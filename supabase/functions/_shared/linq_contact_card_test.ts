import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import { linqSender } from "./linq_contact_card.ts";
import { deliver } from "./deliver.ts";
import type { Store } from "./store.ts";

const LINE = "+12055550100";
const CHAT = "550e8400-e29b-41d4-a716-446655440000";
const user = { id: "user-id", waId: "919876543210", blocked: false, channel: "linq" as const };
const message = { kind: "text" as const, body: "What can I help with?" };

function setup(options: {
  service?: string;
  enabled?: boolean;
  active?: boolean;
  shareStatus?: number;
  textStatus?: number;
  claimFails?: boolean;
  finishFails?: boolean;
} = {}) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const claims: string[] = [];
  const finishes: boolean[] = [];
  const logs: string[] = [];
  const shared = new Set<string>();
  const store = {
    claimLinqContactShare: async (_user: string, chat: string) => {
      claims.push(chat);
      if (options.claimFails) throw new Error("database unavailable");
      return shared.has(chat) ? null : "claim-token";
    },
    finishLinqContactShare: async (chat: string, _claim: string, success: boolean) => {
      finishes.push(success);
      if (options.finishFails) throw new Error("database unavailable");
      if (success) shared.add(chat);
    },
    saveOutbound: async (_user: string, id: string) => {
      logs.push(id);
    },
    lastInboundAt: async () => new Date(),
  } as unknown as Store;
  let texts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/v3/messages")) {
      texts++;
      return Response.json({
        message: { id: `text-${texts}` },
        chat_id: CHAT,
        from: LINE,
        service: options.service ?? "iMessage",
      }, { status: options.textStatus ?? 200 });
    }
    if (url.includes("/contact_card?")) {
      assertEquals(new URL(url).searchParams.get("phone_number"), LINE);
      return Response.json({ contact_cards: [{ phone_number: LINE, is_active: options.active ?? true }] });
    }
    assertEquals(url, `https://api.linqapp.com/api/partner/v3/chats/${CHAT}/share_contact_card`);
    assertEquals(init?.method, "POST");
    assertEquals(init?.body, undefined);
    return new Response(null, { status: options.shareStatus ?? 204 });
  };
  const sender = linqSender(store, user.id, {
    token: "test-token",
    shareContactCard: options.enabled ?? true,
  }, fetcher);
  return {
    requests,
    claims,
    finishes,
    logs,
    reply: () => deliver(store, sender, user, message, new Date(), false),
  };
}

Deno.test("contact card follows a successful text; later replies honor the per-chat cooldown", async () => {
  const s = setup();
  assertEquals(await s.reply(), "text-1");
  assertEquals(await s.reply(), "text-2");
  assertEquals(s.requests.map((r) => new URL(r.url).pathname), [
    "/api/partner/v3/messages",
    "/api/partner/v3/contact_card",
    `/api/partner/v3/chats/${CHAT}/share_contact_card`,
    "/api/partner/v3/messages",
  ]);
  assertEquals(JSON.parse(String(s.requests[0].init?.body)), {
    to: ["+919876543210"],
    message: { parts: [{ type: "text", value: message.body }] },
  });
  assertEquals(s.finishes, [true]);
  assertEquals(s.logs, ["text-1", "text-2"]);
});

Deno.test("contact cards are skipped for RCS, SMS and a disabled feature", async () => {
  for (const options of [{ service: "RCS" }, { service: "SMS" }, { enabled: false }]) {
    const s = setup(options);
    assertEquals(await s.reply(), "text-1");
    assertEquals(s.requests.length, 1);
    assertEquals(s.claims.length, 0);
  }
});

Deno.test("inactive cards are not shared and release the claim with retry backoff", async () => {
  const s = setup({ active: false });
  assertEquals(await s.reply(), "text-1");
  assertEquals(s.requests.length, 2);
  assertEquals(s.finishes, [false]);
  assertEquals(s.logs, ["text-1"]);
});

Deno.test("card/API/storage failures never fail or repeat an accepted text", async () => {
  for (const options of [{ shareStatus: 503 }, { claimFails: true }, { finishFails: true }]) {
    const s = setup(options);
    assertEquals(await s.reply(), "text-1");
    assertEquals(s.requests.filter((r) => r.url.endsWith("/messages")).length, 1);
    assertEquals(s.logs, ["text-1"]);
  }
});

Deno.test("a rejected text triggers no identity sharing or successful outbound log", async () => {
  const s = setup({ textStatus: 403 });
  await assertRejects(() => s.reply(), Error, "403");
  assertEquals(s.requests.length, 1);
  assertEquals(s.claims.length, 0);
  assertEquals(s.logs.length, 0);
});
