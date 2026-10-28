import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { Inbound } from "../whatsapp.ts";
import { classify, command, type GateContext, normalise } from "./gate.ts";

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

const ctx: GateContext = { heldDeposit: false, isAdmin: false, stopped: false };

Deno.test("the gate never turns a message into a consent: approval is read in context", () => {
  for (const t of ["yes", "YES", "haan theek hai", "ok go ahead", "1", "cancel", "sure", "👍"]) {
    assertEquals(classify(text(t), ctx), { kind: "luna", text: t }, t);
  }
});

Deno.test("a tap on an old button goes to Luna as what was tapped, not as consent", () => {
  assertEquals(classify(inbound({ type: "interactive", replyId: "yes:p1", text: "YES, call" }), ctx), {
    kind: "luna",
    text: "[tapped: YES, call]",
  });
});

Deno.test("STOP, START and delete my data are commands, exact words only", () => {
  assertEquals(classify(text("STOP"), ctx), { kind: "command", command: "stop", text: "STOP" });
  assertEquals(classify(text("Stop!"), ctx), { kind: "command", command: "stop", text: "Stop!" });
  assertEquals(classify(text("delete my data"), ctx), {
    kind: "command",
    command: "delete_data",
    text: "delete my data",
  });
  // A sentence with "stop" in it is conversation; Luna can pause or cancel.
  assertEquals(classify(text("stop, wrong time"), ctx).kind, "luna");
});

Deno.test("START only counts while stopped; otherwise it is text", () => {
  assertEquals(classify(text("start"), ctx).kind, "luna");
  assertEquals(classify(text("start"), { ...ctx, stopped: true }), {
    kind: "command",
    command: "start",
    text: "start",
  });
});

Deno.test("while stopped, everything else gets the reminder, whatever it says", () => {
  const stopped = { ...ctx, stopped: true };
  for (const t of ["yes", "book Paragon at 8", "ok go ahead"]) {
    assertEquals(classify(text(t), stopped), { kind: "stopped" }, t);
  }
  assertEquals(classify(text("STOP"), stopped).kind, "command");
});

Deno.test("a reaction goes to Luna as what it is; a removed one is ignored; media is a marker", () => {
  assertEquals(classify(inbound({ type: "reaction", text: "👍", quotedId: "wamid.out1" }), ctx), {
    kind: "luna",
    text: "[reacted 👍]",
  });
  assertEquals(classify(inbound({ type: "reaction", text: "" }), ctx), { kind: "ignore" });
  assertEquals(classify(inbound({ type: "audio" }), ctx), {
    kind: "luna",
    text: "[voice note: not supported yet]",
  });
});

Deno.test("a screenshot while a deposit is held goes to the payment check", () => {
  assertEquals(classify(inbound({ type: "image" }), { ...ctx, heldDeposit: true }), { kind: "screenshot" });
  assertEquals(classify(inbound({ type: "image" }), ctx).kind, "luna");
});

Deno.test("admin commands only for admins", () => {
  assertEquals(command(text("limits"), true)?.command, "admin");
  assertEquals(command(text("limits"), false), null);
});

Deno.test("normalise", () => {
  assertEquals(normalise("  Yes!  "), "yes");
  assertEquals(normalise("STOP."), "stop");
});
