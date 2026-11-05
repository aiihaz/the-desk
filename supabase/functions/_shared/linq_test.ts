import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.8";
import {
  downloadLinqImage,
  linqChatId,
  markRead,
  parseLinqWebhook,
  parseStoredLinqMessage,
  send,
  startTyping,
  textContent,
  verifyLinqSignature,
} from "./linq.ts";
import { deliver, OutsideServiceWindow } from "./deliver.ts";
import type { Store } from "./store.ts";

import { event, reactionEvent, SECRET, signedHeaders } from "./linq_test_helpers.ts";

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

Deno.test("Linq inbox recovery preserves the message, timestamp and quoted consent", () => {
  const message = parseLinqWebhook(event())!;
  assertEquals(parseStoredLinqMessage(message.raw), message);
  assertEquals(parseStoredLinqMessage({ text: { body: "a Meta message" } }), null);
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

Deno.test("documented Linq reactions preserve target and recover without treating removal as approval", () => {
  const added = parseLinqWebhook(reactionEvent())!;
  assertEquals([added.type, added.text, added.quotedId, added.messageId], [
    "reaction",
    "👍",
    "plan-id",
    "linq-reaction:reaction-add-id",
  ]);
  assertEquals(parseStoredLinqMessage(added.raw), added);
  const removed = parseLinqWebhook(reactionEvent(true))!;
  assertEquals(removed.text, "");
  assertEquals(parseStoredLinqMessage(removed.raw), removed);
  const own = reactionEvent();
  own.data.is_from_me = true;
  assertEquals(parseLinqWebhook(own), null);
  const email = reactionEvent();
  email.data.from_handle.handle = "someone@example.com";
  assertEquals(parseLinqWebhook(email), null);
  const unknown = reactionEvent();
  unknown.data.reaction_type = "sticker";
  assertEquals(parseLinqWebhook(unknown), null);
});

Deno.test("attachment reads enforce both declared and streaming size bounds", async () => {
  const raw = {
    linq: { parts: [{ type: "media", mime_type: "image/png", url: "https://storage.example/image" }] },
  };
  for (
    const response of [
      () => new Response(new Uint8Array(4), { headers: { "content-length": "4" } }),
      () => new Response(new Uint8Array(4)),
    ]
  ) {
    await assertRejects(
      () => downloadLinqImage(raw, async () => response(), { maxBytes: 3 }),
      Error,
      "size limit",
    );
  }
  const result = await downloadLinqImage(raw, async (_url, init) => {
    assertEquals(init?.redirect, "error");
    assertEquals(init?.signal instanceof AbortSignal, true);
    assertEquals(init?.headers, undefined);
    return new Response(new Uint8Array([1, 2]));
  }, { maxBytes: 3 });
  assertEquals(result?.bytes, new Uint8Array([1, 2]));
});

Deno.test("reaction timestamps use documented envelope time when reacted_at is absent", () => {
  const payload = reactionEvent();
  const { reacted_at: _at, chat_id: _chat, ...data } = payload.data;
  const message = parseLinqWebhook({ ...payload, data })!;
  assertEquals(message.at.toISOString(), payload.created_at.replace("Z", ".000Z"));
  assertEquals(message.quotedId, "plan-id");
});

Deno.test("Linq sends provide a finite transport cancellation signal", async () => {
  await send(
    { token: "fake", timeoutMs: 1 },
    "919876543210",
    { kind: "text", body: "fixture" },
    async (_url, init) => {
      assertEquals(init?.signal instanceof AbortSignal, true);
      return Response.json({ message: { id: "sent" } });
    },
  );
});

Deno.test("the chat to mark read or type in comes from the message, or a reaction's event", () => {
  assertEquals(linqChatId(parseLinqWebhook(event())!.raw), "chat-id");
  assertEquals(linqChatId(parseLinqWebhook(reactionEvent())!.raw), "direct-chat-id");
  assertEquals(linqChatId({}), null);
});

Deno.test("a read receipt marks the chat; a failure is logged, never thrown", async () => {
  const seen: string[] = [];
  await markRead({ token: "fake" }, "chat-id", async (url, init) => {
    seen.push(`${init?.method} ${url} ${new Headers(init?.headers).get("Authorization")}`);
    assertEquals(init?.signal instanceof AbortSignal, true);
    return new Response(null, { status: 204 });
  });
  assertEquals(seen, ["POST https://api.linqapp.com/api/partner/v3/chats/chat-id/read Bearer fake"]);
  await markRead({ token: "fake" }, "chat-id", async () => new Response("no", { status: 500 }));
  await markRead({ token: "fake" }, "chat-id", () => Promise.reject(new Error("network")));
  await markRead({ token: "" }, "chat-id");
});

Deno.test("typing: one call at a time, refreshed until a reply, and cleared once at the end", async () => {
  const seen: string[] = [];
  let release!: () => void;
  const slowStart = new Promise<void>((r) => release = r);
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    assertEquals(String(url), "https://api.linqapp.com/api/partner/v3/chats/chat-id/typing");
    if (seen.length === 0) await slowStart;
    seen.push(init?.method ?? "");
    return new Response(null, { status: 204 });
  };
  const typing = startTyping({ token: "fake" }, "chat-id", fetcher, 5);
  const stopping = typing.stop();
  release();
  await stopping;
  // The slow start lands first, so the clear is last and nothing is left showing.
  assertEquals(seen, ["POST", "DELETE"]);
  await typing.stop();
  assertEquals(seen, ["POST", "DELETE"]);

  const refreshed: string[] = [];
  const t = startTyping({ token: "fake" }, "chat-id", async (_u, init) => {
    refreshed.push(init?.method ?? "");
    return new Response(null, { status: 204 });
  }, 5);
  await new Promise((r) => setTimeout(r, 18));
  t.sent();
  const afterReply = refreshed.length;
  await new Promise((r) => setTimeout(r, 15));
  assertEquals(refreshed.length, afterReply);
  assertEquals(afterReply >= 3, true);
  await t.stop();
  assertEquals(refreshed.at(-1), "DELETE");
});

Deno.test("a failing typing call never reaches the turn", async () => {
  const t = startTyping({ token: "fake" }, "chat-id", () => Promise.reject(new Error("network")));
  await t.stop();
});
