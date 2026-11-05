import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { Outbound } from "../whatsapp.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { showTranscript, transcriptMessages } from "./tools.ts";

const user = { id: "u1", waId: "919812345678", blocked: false };

function setup() {
  const store = new FakeChatStore();
  const sent: Outbound[] = [];
  const deps = {
    store,
    send: async (_u: unknown, m: Outbound) => {
      sent.push(m);
      return `wamid.${sent.length}`;
    },
  };
  return { store, sent, deps };
}

const call = (id: string, place: string, lines = [
  { role: "agent", en_text: "Hello, is this Paragon?" },
  { role: "user", en_text: "Yes, 8 pm for four is fine." },
]) => ({
  id,
  kind: "first" as const,
  at: new Date("2026-11-04T18:00:00+05:30"),
  place,
  until: new Date("2026-11-06T18:00:00+05:30"),
  lines,
});

Deno.test("show_transcript: nothing kept says how long they're kept", async () => {
  const { store, sent, deps } = setup();
  store.limits.transcript_hours_after_event = 12;
  store.limits.transcript_hours_without_event = 48;
  const res = await showTranscript(deps, user, null);
  assertEquals(res.ok, false);
  assertEquals(String(res.reason).includes("12 hours after the booking"), true);
  assertEquals(String(res.reason).includes("48 hours after the call"), true);
  assertEquals(sent, []);
});

Deno.test("show_transcript: one call is sent as stored, and its message is marked", async () => {
  const { store, sent, deps } = setup();
  store.transcripts = [call("c1111111-x", "Paragon")];
  const res = await showTranscript(deps, user, null);
  assertEquals(res.ok, true);
  assertEquals(res.sent, "transcript");
  assertEquals(sent.length, 1);
  const body = (sent[0] as { body: string }).body;
  assertEquals(body.startsWith("What was said on the call to Paragon,"), true);
  assertEquals(body.includes("Desk: Hello, is this Paragon?\n\nParagon: Yes, 8 pm for four is fine."), true);
  assertEquals(store.transcriptMessages, [["wamid.1", "c1111111-x"]]);
});

Deno.test("show_transcript: several are listed until one is named by ref", async () => {
  const { store, sent, deps } = setup();
  store.transcripts = [call("c1111111-x", "Paragon"), call("c2222222-y", "Rahmath")];
  const list = await showTranscript(deps, user, null);
  assertEquals(list.ok, true);
  assertEquals((list.calls as { ref: string }[]).map((c) => c.ref), ["c1111111", "c2222222"]);
  assertEquals(sent, []);
  assertEquals((await showTranscript(deps, user, "nope")).ok, false);
  await showTranscript(deps, user, "C2222222");
  assertEquals((sent[0] as { body: string }).body.includes("call to Rahmath"), true);
  assertEquals(store.transcriptMessages, [["wamid.1", "c2222222-y"]]);
});

Deno.test("a long call is split into parts that fit a chat message, every part marked", async () => {
  const { store, sent, deps } = setup();
  const lines = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? "user" : "agent",
    en_text: `line ${i} ` + "x".repeat(400),
  }));
  store.transcripts = [call("c3333333-z", "Paragon", lines)];
  await showTranscript(deps, user, null);
  assertEquals(sent.length > 1, true);
  for (const m of sent) assertEquals((m as { body: string }).body.length <= 3500, true);
  assertEquals(store.transcriptMessages.length, sent.length);
  const all = sent.map((m) => (m as { body: string }).body).join("\n\n");
  assertEquals(all.includes("line 0 ") && all.includes("line 29 "), true);
});

Deno.test("transcript lines are cleaned like any outside text; empty ones are dropped", () => {
  const [body] = transcriptMessages(call("c4", "Paragon"), [
    { role: "assistant", en_text: "Hi​ there" },
    { role: "user", en_text: "   " },
  ]);
  assertEquals(body.endsWith("\n\nDesk: Hi there"), true);
});
