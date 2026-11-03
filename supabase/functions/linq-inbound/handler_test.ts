import { assertEquals } from "jsr:@std/assert@1.0.8";
import { event, SECRET, signedHeaders } from "../_shared/linq_test_helpers.ts";
import type { Store, User } from "../_shared/store.ts";
import type { Inbound } from "../_shared/whatsapp.ts";
import { handle } from "./handler.ts";

function setup() {
  const seen = new Set<string>();
  const pending: Promise<unknown>[] = [];
  const handed: string[] = [];
  let fail = false;
  const user = { id: "u", waId: "919876543210", blocked: false };
  const store = {
    saveEvent: async () => true,
    upsertUser: async () => user,
    saveInbound: async (_u: string, msg: Inbound) => {
      if (fail) throw new Error("database unavailable");
      if (seen.has(msg.messageId)) return false;
      seen.add(msg.messageId);
      return true;
    },
  } as unknown as Store;
  return {
    user,
    handed,
    pending,
    fail: (value: boolean) => fail = value,
    deps: {
      store,
      secret: SECRET,
      background: (p: Promise<unknown>) => {
        pending.push(p);
      },
      handOff: async (_u: User, msg: Inbound) => {
        handed.push(msg.messageId);
      },
    },
  };
}
async function request() {
  const body = JSON.stringify(event());
  return new Request("https://desk.example/linq-inbound", {
    method: "POST",
    body,
    headers: await signedHeaders(body),
  });
}

Deno.test("Linq webhook dedupes messages across redelivery", async () => {
  const s = setup();
  assertEquals((await handle(await request(), s.deps)).status, 200);
  assertEquals((await handle(await request(), s.deps)).status, 200);
  await Promise.all(s.pending);
  assertEquals(s.handed, ["inbound-id"]);
});

Deno.test("Linq webhook retries persistence failure and never hands off blocked users", async () => {
  const s = setup();
  s.fail(true);
  assertEquals((await handle(await request(), s.deps)).status, 503);
  s.fail(false);
  assertEquals((await handle(await request(), s.deps)).status, 200);
  await Promise.all(s.pending);
  assertEquals(s.handed.length, 1);
  const blocked = setup();
  blocked.user.blocked = true;
  assertEquals((await handle(await request(), blocked.deps)).status, 200);
  assertEquals(blocked.handed.length, 0);
});

Deno.test("Linq webhook rejects unsigned requests and unsupported methods", async () => {
  const s = setup();
  assertEquals(
    (await handle(
      new Request("https://desk.example", { method: "POST", body: JSON.stringify(event()) }),
      s.deps,
    )).status,
    401,
  );
  assertEquals((await handle(new Request("https://desk.example"), s.deps)).status, 405);
  assertEquals(s.handed.length, 0);
});
