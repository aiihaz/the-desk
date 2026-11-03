import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.8";
import { parseLinqWebhook, send, textContent, verifyLinqSignature } from "./linq.ts";
import { deliver, OutsideServiceWindow } from "./deliver.ts";
import type { Store } from "./store.ts";

import { event, SECRET, signedHeaders } from "./linq_test_helpers.ts";

Deno.test("Linq signature: valid raw body, tampering, missing secret and replay", async () => {
  const body = JSON.stringify(event());
  const headers = await signedHeaders(body);
  assertEquals(await verifyLinqSignature(body, headers, SECRET), true);
  assertEquals(await verifyLinqSignature(body + " ", headers, SECRET), false);
  assertEquals(await verifyLinqSignature(body, headers, ""), false);
  assertEquals(await verifyLinqSignature(body, await signedHeaders(body, 1), SECRET), false);
  assertEquals(
    await verifyLinqSignature(body, await signedHeaders(body, Math.floor(Date.now() / 1000) + 600), SECRET),
    false,
  );
});

Deno.test("Linq inbound: normalized phone, quoted reply and text history", () => {
  const msg = parseLinqWebhook(event())!;
  assertEquals([msg.waId, msg.messageId, msg.type, msg.text, msg.quotedId], [
    "919876543210",
    "inbound-id",
    "text",
    "Book for two",
    "plan-id",
  ]);
  assertEquals((msg.raw as { text: { body: string } }).text.body, "Book for two");
});

Deno.test("Linq ignores groups, email handles, outbound and status events", () => {
  const group = event();
  group.data.chat.is_group = true;
  const email = event();
  email.data.sender_handle.handle = "user@example.com";
  const own = event();
  own.data.direction = "outbound";
  const status = event();
  status.event_type = "message.delivered";
  for (const e of [group, email, own, status]) assertEquals(parseLinqWebhook(e), null);
  const old = event();
  old.webhook_version = "2025-01-01";
  assertThrows(() => parseLinqWebhook(old));
});

Deno.test("Linq screenshot preserves image URL and caption for payment verification", () => {
  const e = event();
  const payload = {
    ...e,
    data: {
      ...e.data,
      parts: [...e.data.parts, {
        type: "media",
        mime_type: "image/png",
        url: "https://storage.example/screenshot.png",
      }],
    },
  };
  const msg = parseLinqWebhook(payload)!;
  assertEquals(msg.type, "image");
  assertEquals(msg.text, "Book for two");
  assertEquals((msg.raw as { linq: unknown }).linq, payload.data);
});

Deno.test("Linq send uses v3 messages with automatic routing and verifies returned id", async () => {
  const mock: typeof fetch = async (input, init) => {
    assertEquals(input, "https://api.linqapp.com/api/partner/v3/messages");
    assertEquals(JSON.parse(String(init?.body)), {
      to: ["+919876543210"],
      message: { parts: [{ type: "text", value: "Your plan?" }] },
    });
    assertEquals(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    return Response.json({ message: { id: "sent-id" } });
  };
  assertEquals(
    await send({ token: "test-token" }, "919876543210", { kind: "text", body: "Your plan?" }, mock),
    "sent-id",
  );
  await assertRejects(
    () =>
      send(
        { token: "test-token" },
        "919876543210",
        { kind: "text", body: "test" },
        () => Promise.resolve(Response.json({})),
      ),
    Error,
    "missing message.id",
  );
  await assertRejects(
    () =>
      send(
        { token: "test-token" },
        "919876543210",
        { kind: "text", body: "test" },
        () => Promise.resolve(new Response("{}", { status: 403 })),
      ),
    Error,
    "403",
  );
  assertThrows(() => textContent({ kind: "template", name: "wa-template", language: "en" }));
});

Deno.test("Linq delivery logs original content outside WhatsApp's window; WhatsApp still rejects", async () => {
  const logged: unknown[] = [];
  const store = {
    lastInboundAt: async () => null,
    saveOutbound: async (...args: unknown[]) => {
      logged.push(args);
    },
  } as unknown as Store;
  const user = { id: "u", waId: "919876543210", blocked: false };
  const msg = { kind: "text" as const, body: "The business offered another slot. Would it work?" };
  await assertRejects(() => deliver(store, async () => "sent-id", user, msg), OutsideServiceWindow);
  assertEquals(await deliver(store, async () => "sent-id", user, msg, new Date(), false), "sent-id");
  assertEquals(logged, [["u", "sent-id", msg]]);
});
