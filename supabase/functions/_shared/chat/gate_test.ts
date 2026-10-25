import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { Inbound } from "../whatsapp.ts";
import { classify, type GateContext, normalise } from "./gate.ts";

export function inbound(over: Partial<Inbound> = {}): Inbound {
  return {
    waId: "919800000001",
    name: "Ihaz",
    messageId: "wamid.in1",
    at: new Date("2026-10-23T12:00:00Z"),
    type: "text",
    text: null,
    replyId: null,
    quotedId: null,
    raw: {},
    ...over,
  };
}

const text = (t: string) => inbound({ text: t });

const readback: GateContext = {
  state: "awaiting_yes",
  prompt: { id: "p1", kind: "ask", optionIds: [], confirmWord: "yes", waMessageId: "wamid.out1" },
  lastOutboundId: "wamid.out1",
  quotedPromptId: null,
  heldDeposit: false,
  isAdmin: false,
};

const optionList: GateContext = {
  ...readback,
  state: "awaiting_pick",
  prompt: {
    id: "p2",
    kind: "options",
    optionIds: ["o1", "o2"],
    confirmWord: "yes",
    waMessageId: "wamid.out2",
  },
  lastOutboundId: "wamid.out2",
};

const nothing: GateContext = { ...readback, state: "collecting", prompt: null };

Deno.test("YES button on the open read-back is consent #1", () => {
  assertEquals(classify(inbound({ type: "interactive", replyId: "yes:p1", text: "YES" }), readback), {
    kind: "consent",
    promptId: "p1",
    optionId: null,
    word: "yes",
  });
});

Deno.test("a tap on an old read-back's button is refused", () => {
  assertEquals(classify(inbound({ type: "interactive", replyId: "yes:p0" }), readback), {
    kind: "stale_approval",
  });
  assertEquals(classify(inbound({ type: "interactive", replyId: "yes:p0" }), nothing), {
    kind: "stale_approval",
  });
});

Deno.test("a tap from an expired option list is refused", () => {
  assertEquals(classify(inbound({ type: "interactive", replyId: "pick:p9:o1" }), optionList), {
    kind: "stale_approval",
  });
  assertEquals(classify(inbound({ type: "interactive", replyId: "pick:p2:o9" }), optionList), {
    kind: "stale_approval",
  });
});

Deno.test("a list pick on the open option list is consent #2", () => {
  assertEquals(classify(inbound({ type: "interactive", replyId: "pick:p2:o2" }), optionList), {
    kind: "consent",
    promptId: "p2",
    optionId: "o2",
    word: "yes",
  });
});

Deno.test("typed YES in several languages, only when the read-back was the last message", () => {
  for (const t of ["yes", "YES", "Yes!", "haan", "हाँ", "sari", "ശരി", "aam", "ஆம்"]) {
    assertEquals(classify(text(t), readback).kind, "consent", t);
  }
  assertEquals(classify(text("yes"), { ...readback, lastOutboundId: "wamid.luna" }), {
    kind: "resend_prompt",
  });
});

Deno.test("anything but a listed word goes to Luna, which cannot consent", () => {
  for (const t of ["ok", "yes but make it 5", "sure why not", "yess", "👍"]) {
    assertEquals(classify(text(t), readback), { kind: "luna", text: t }, t);
  }
});

Deno.test("typed YES with no open prompt (after a replace) goes to Luna", () => {
  assertEquals(classify(text("yes"), nothing), { kind: "luna", text: "yes" });
});

Deno.test("a read-back that states a possible loss needs CANCEL, not YES", () => {
  const loss: GateContext = { ...readback, prompt: { ...readback.prompt!, confirmWord: "cancel" } };
  assertEquals(classify(text("yes"), loss), { kind: "luna", text: "yes" });
  assertEquals(classify(inbound({ type: "interactive", replyId: "yes:p1" }), loss), {
    kind: "stale_approval",
  });
  assertEquals(classify(text("CANCEL"), loss), {
    kind: "consent",
    promptId: "p1",
    optionId: null,
    word: "cancel",
  });
  assertEquals(classify(inbound({ type: "interactive", replyId: "cancel:p1" }), loss).kind, "consent");
  // Outside a CANCEL prompt, "cancel" means cancel the request: Luna decides.
  assertEquals(classify(text("cancel"), readback), { kind: "luna", text: "cancel" });
});

Deno.test("a bare digit picks from the option list; anything longer goes to Luna", () => {
  assertEquals(classify(text("2"), optionList), {
    kind: "consent",
    promptId: "p2",
    optionId: "o2",
    word: "yes",
  });
  assertEquals(classify(text("3"), optionList), { kind: "luna", text: "3" });
  assertEquals(classify(text("the second one"), optionList), { kind: "luna", text: "the second one" });
  assertEquals(classify(text("2 but at 9"), optionList), { kind: "luna", text: "2 but at 9" });
  // After Luna asked something, "2" is an answer to that, not a pick.
  assertEquals(classify(text("2"), { ...optionList, lastOutboundId: "wamid.luna" }), {
    kind: "luna",
    text: "2",
  });
  // Digits never approve a read-back.
  assertEquals(classify(text("1"), readback), { kind: "luna", text: "1" });
});

Deno.test("YES on a Book-it prompt is consent #2 for its one option", () => {
  const bookIt: GateContext = {
    ...optionList,
    prompt: { id: "p3", kind: "book", optionIds: ["o2"], confirmWord: "yes", waMessageId: "wamid.out2" },
  };
  assertEquals(classify(text("haan"), bookIt), {
    kind: "consent",
    promptId: "p3",
    optionId: "o2",
    word: "yes",
  });
});

Deno.test("commands come before everything else", () => {
  assertEquals(classify(text("STOP"), readback), { kind: "command", command: "stop", text: "STOP" });
  assertEquals(classify(text("delete my data"), readback).kind, "command");
  assertEquals(classify(text("stop all"), readback), { kind: "luna", text: "stop all" });
  assertEquals(classify(text("stop all"), { ...readback, isAdmin: true }), {
    kind: "command",
    command: "admin",
    text: "stop all",
  });
});

Deno.test("payment: a screenshot only while a deposit is held; 'paid' asks for one", () => {
  const held = { ...nothing, heldDeposit: true };
  assertEquals(classify(inbound({ type: "image" }), held), { kind: "screenshot" });
  assertEquals(classify(inbound({ type: "image" }), nothing), { kind: "luna", text: "[image: not read]" });
  assertEquals(classify(text("Paid"), held), { kind: "ask_screenshot" });
  assertEquals(classify(text("paid"), nothing), { kind: "luna", text: "paid" });
});

Deno.test("media reaches Luna as a marker; reactions are ignored", () => {
  assertEquals(classify(inbound({ type: "audio" }), nothing), {
    kind: "luna",
    text: "[voice note: not supported yet]",
  });
  assertEquals(classify(inbound({ type: "reaction" }), nothing), { kind: "ignore" });
});

Deno.test("normalise", () => {
  assertEquals(normalise("  Yes  please!! "), "yes please");
  assertEquals(normalise("HAAN."), "haan");
});

Deno.test("a YES that quotes the open read-back counts even after Luna spoke", () => {
  const after = { ...readback, lastOutboundId: "wamid.luna", quotedPromptId: "p1" };
  assertEquals(classify(inbound({ text: "yes", quotedId: "wamid.out1" }), after), {
    kind: "consent",
    promptId: "p1",
    optionId: null,
    word: "yes",
  });
  // A digit quoting the option list, after Luna asked something.
  const list = { ...optionList, lastOutboundId: "wamid.luna", quotedPromptId: "p2" };
  assertEquals(classify(text("1"), list).kind, "consent");
});

Deno.test("a YES that quotes an older prompt is refused; quoting chat is just chat", () => {
  assertEquals(classify(text("yes"), { ...readback, quotedPromptId: "p0" }), { kind: "stale_approval" });
  assertEquals(classify(text("haan"), { ...nothing, quotedPromptId: "p0" }), { kind: "stale_approval" });
  // Quoting an old prompt with a real message goes to Luna.
  assertEquals(classify(text("what time was this?"), { ...readback, quotedPromptId: "p0" }).kind, "luna");
});

Deno.test("quoting the read-back with the wrong word does not approve a loss", () => {
  const loss: GateContext = {
    ...readback,
    prompt: { ...readback.prompt!, confirmWord: "cancel" },
    quotedPromptId: "p1",
  };
  assertEquals(classify(text("yes"), loss), { kind: "luna", text: "yes" });
});
