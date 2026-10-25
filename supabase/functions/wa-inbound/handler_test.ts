import { assertEquals } from "jsr:@std/assert@1.0.8";
import { handle } from "./handler.ts";
import { sign } from "../_shared/test_sign.ts";
import type { Store, User } from "../_shared/store.ts";
import type { Inbound } from "../_shared/whatsapp.ts";

const SECRET = "app-secret";
const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`../../../fixtures/whatsapp/${name}.json`, import.meta.url));

class FakeStore implements Store {
  events = new Set<string>();
  users = new Map<string, User & { name: string | null }>();
  inbound = new Map<string, Inbound>();
  async saveEvent(id: string) {
    if (this.events.has(id)) return false;
    this.events.add(id);
    return true;
  }
  async upsertUser(waId: string, name: string | null) {
    if (!this.users.has(waId)) this.users.set(waId, { id: `u-${waId}`, waId, blocked: false, name });
    return this.users.get(waId)!;
  }
  async saveInbound(_userId: string, msg: Inbound) {
    if (this.inbound.has(msg.messageId)) return false;
    this.inbound.set(msg.messageId, msg);
    return true;
  }
  async lastInboundAt() {
    return null;
  }
  async saveOutbound() {}
}

function setup() {
  const store = new FakeStore();
  const handed: string[] = [];
  const pending: Promise<unknown>[] = [];
  const deps = {
    store,
    appSecret: SECRET,
    verifyToken: "verify-me",
    background: (p: Promise<unknown>) => void pending.push(p),
    handOff: async (_u: User, m: Inbound) => void handed.push(m.messageId),
  };
  return { store, handed, pending, deps };
}

async function post(body: string, signature?: string) {
  return new Request("http://x/wa-inbound", {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": signature ?? await sign(body, SECRET) },
  });
}

Deno.test("GET: Meta subscription check", async () => {
  const { deps } = setup();
  const ok = await handle(
    new Request("http://x/?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42"),
    deps,
  );
  assertEquals([ok.status, await ok.text()], [200, "42"]);
  const bad = await handle(
    new Request("http://x/?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42"),
    deps,
  );
  assertEquals(bad.status, 403);
});

Deno.test("POST: bad signature → 401, nothing stored", async () => {
  const { deps, store, handed } = setup();
  const res = await handle(await post(fixture("text"), "sha256=" + "0".repeat(64)), deps);
  assertEquals(res.status, 401);
  assertEquals([store.events.size, store.users.size, handed.length], [0, 0, 0]);
});

Deno.test("POST: text → user created, message stored, handed off once", async () => {
  const { deps, store, handed, pending } = setup();
  const res = await handle(await post(fixture("text")), deps);
  await Promise.all(pending);
  assertEquals(res.status, 200);
  assertEquals(store.users.get("919800000001")?.name, "Ihaz");
  assertEquals([...store.inbound.keys()], ["wamid.TEXT1"]);
  assertEquals(handed, ["wamid.TEXT1"]);
});

Deno.test("POST: Meta redelivery is not handed off twice", async () => {
  const { deps, handed, pending } = setup();
  await handle(await post(fixture("text")), deps);
  // Same body again, then the same message id inside a different body.
  await handle(await post(fixture("text")), deps);
  await handle(await post(fixture("text").replace('"entry"', '"x":1,"entry"')), deps);
  await Promise.all(pending);
  assertEquals(handed, ["wamid.TEXT1"]);
});

Deno.test("POST: blocked user's message is stored but not handed off", async () => {
  const { deps, store, handed, pending } = setup();
  store.users.set("919800000001", { id: "u1", waId: "919800000001", blocked: true, name: null });
  await handle(await post(fixture("text")), deps);
  await Promise.all(pending);
  assertEquals(store.inbound.size, 1);
  assertEquals(handed, []);
});

Deno.test("POST: status updates are stored, no handoff; bad JSON → 400", async () => {
  const { deps, store, handed } = setup();
  assertEquals((await handle(await post(fixture("status")), deps)).status, 200);
  assertEquals([store.events.size, handed.length], [1, 0]);
  assertEquals((await handle(await post("{not json"), deps)).status, 400);
});
