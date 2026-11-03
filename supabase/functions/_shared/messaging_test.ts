import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import { createDelivery } from "./messaging.ts";
import { OutsideServiceWindow } from "./deliver.ts";
import { identityKey, type MessagingChannel, type Store, storedUser, type User } from "./store.ts";
import type { Outbound } from "./whatsapp.ts";

Deno.test("same phone has distinct channel identities without changing the WhatsApp key", () => {
  const phone = "919876543210";
  assertEquals(identityKey(phone, "whatsapp"), phone);
  assertEquals(identityKey(phone, "linq"), `linq:${phone}`);
  assertEquals(
    storedUser({
      id: "linq-user",
      wa_id: `linq:${phone}`,
      phone_e164: `+${phone}`,
      blocked: false,
      channel: "linq",
    }).waId,
    phone,
  );
});

function setup(lastInbound: Date | null = new Date()) {
  const users = new Map<string, User>([
    ["wa-user", { id: "wa-user", waId: "919876543210", blocked: false, channel: "whatsapp" }],
    ["linq-user", { id: "linq-user", waId: "919876543210", blocked: false, channel: "linq" }],
  ]);
  const sent: { channel: MessagingChannel; to: string; message: Outbound }[] = [];
  const saved: string[] = [];
  const store = {
    deliveryTarget: async (id: string) => {
      const user = users.get(id);
      if (!user) throw new Error("user not found");
      return user;
    },
    lastInboundAt: async () => lastInbound,
    saveOutbound: async (id: string) => {
      saved.push(id);
    },
  } as unknown as Store;
  const makeSender = (channel: MessagingChannel) => async (to: string, message: Outbound) => {
    sent.push({ channel, to, message });
    return `${channel}-message-id`;
  };
  return {
    users,
    sent,
    saved,
    send: createDelivery(store, { whatsapp: makeSender("whatsapp"), linq: makeSender("linq") }),
  };
}

Deno.test("interleaved replies to the same phone use each persisted channel", async () => {
  const s = setup();
  const text = { kind: "text" as const, body: "Which time works?" };
  await s.send(s.users.get("wa-user")!, text);
  await s.send(s.users.get("linq-user")!, text);
  await s.send(s.users.get("wa-user")!, text);
  assertEquals(s.sent.map((m) => m.channel), ["whatsapp", "linq", "whatsapp"]);
  assertEquals(s.saved, ["wa-user", "linq-user", "wa-user"]);
});

Deno.test("late call reports and retries route by user UUID, not namespaced or stale wa_id", async () => {
  const s = setup(null);
  const user: User = { id: "linq-user", waId: "linq:919876543210", blocked: false, channel: "whatsapp" };
  await s.send(user, { kind: "text", body: "The business replied. Does the alternative work?" });
  assertEquals(s.sent[0].channel, "linq");
  assertEquals(s.sent[0].to, "919876543210");
  await assertRejects(
    () => s.send(s.users.get("wa-user")!, { kind: "text", body: "Outside the window" }),
    OutsideServiceWindow,
  );
  assertEquals(s.sent.length, 1);
});

Deno.test("missing or blocked delivery targets cannot be sent through either channel", async () => {
  const s = setup();
  s.users.get("linq-user")!.blocked = true;
  await assertRejects(
    () => s.send({ id: "linq-user", waId: "919876543210", blocked: false }, { kind: "text", body: "test" }),
    Error,
    "blocked",
  );
  await assertRejects(
    () => s.send({ id: "missing", waId: "919876543210", blocked: false }, { kind: "text", body: "test" }),
    Error,
    "not found",
  );
  assertEquals(s.sent.length, 0);
});
