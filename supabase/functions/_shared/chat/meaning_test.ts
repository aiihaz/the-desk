// What the user meant has to survive the whole path: the stored request, the plan's facts,
// the readback and the caller's brief. And when a check refuses, the turn repairs from their
// messages or asks; it doesn't resubmit what was refused, and when repair fails it keeps the
// last valid state, commits to nothing and says so honestly.
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { User } from "../store.ts";
import type { Item, ResponseOut } from "../openai.ts";
import type { Outbound } from "../whatsapp.ts";
import { type CallInputs, callVariables } from "../call_vars.ts";
import type { GroundingInput, GroundingResult } from "./intent_grounding.ts";
import { type LunaDeps, runLuna } from "./luna.ts";
import type { PlanInput } from "./plan_writer.ts";
import { bookingReadback, planFacts } from "./readback.ts";
import { checkSlots, CONFLICT_OPEN_TOLERANCE, type Fields, incoherentTime } from "./slots.ts";
import type { ActiveRequest } from "./store.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { proposePlan } from "./turn.ts";

const user: User = { id: "u1", waId: "919812345678", blocked: false };
// Saturday 7 Nov 2026, 6:46 pm in India.
const now = new Date("2026-11-07T18:46:00+05:30");
const NINE = "2026-11-07T21:00:00+05:30";
const place = {
  name: "Kopitiam Lah",
  address: "Doopanahalli, Indiranagar",
  city: "Bengaluru",
  area: "Indiranagar",
};

// Room either side of their time, and the business's choice, are two meanings.
const target: Fields = {
  party_size: 2,
  customer_name: "Ihaz",
  exact_time: NINE,
  tolerance_min: 30,
  may_book: true,
};
const handOff: Fields = {
  party_size: 2,
  customer_name: "Ihaz",
  time_open: true,
  time_given: "both",
  window_start: "2026-11-07T20:30:00+05:30",
  window_end: "2026-11-07T21:30:00+05:30",
  may_book: true,
};

function caller(f: Fields): string {
  const x: CallInputs = {
    task: "booking",
    fields: f as Record<string, unknown>,
    businessName: place.name,
    customerPhone: "+919812345678",
    option: null,
    prev: null,
    booking: null,
    payment: null,
    approvedLossRs: 0,
  };
  return JSON.stringify(callVariables("first", x, false, now));
}

Deno.test("room either side of their time stays their time, through facts, readback and caller", () => {
  const facts = planFacts({ task: "booking", place, f: target, customerPhone: "+919812345678", now });
  assertEquals(facts.when, {
    kind: "their time, with room either way",
    day: "tonight (Sat 7 Nov)",
    time: "9:00 pm",
    either_way_min: 30,
  });
  const text = bookingReadback({ place, f: target, customerPhone: "+919812345678", now }).text;
  assertEquals(text.includes("tonight (Sat 7 Nov) at 9:00 pm (up to 30 min either way)"), true);
  assertEquals(text.includes("suits them"), false);
  const brief = caller(target);
  assertEquals(brief.includes("9:00 pm IST"), true);
  assertEquals(brief.includes("Up to 30 minutes either way of the time."), true);
  assertEquals(brief.includes("any time that suits the business"), false);
});

Deno.test("a time left to the business stays the business's choice, through facts, readback and caller", () => {
  const facts = planFacts({ task: "booking", place, f: handOff, customerPhone: "+919812345678", now });
  assertEquals(facts.when, {
    kind: "left to the business: the call asks what time suits them",
    day: "tonight (Sat 7 Nov)",
    not_before: "8:30 pm",
    not_after: "9:30 pm",
  });
  const text = bookingReadback({ place, f: handOff, customerPhone: "+919812345678", now }).text;
  assertEquals(text.includes("at a time that suits them between 8:30 pm and 9:30 pm"), true);
  const brief = caller(handOff);
  assertEquals(brief.includes("They left the time to the business"), true);
  assertEquals(brief.includes("9:00 pm"), false);
});

Deno.test("plan facts carry what was decided, never a sentence to copy", () => {
  const facts = planFacts({ task: "booking", place, f: target, customerPhone: "+919812345678", now });
  assertEquals(facts.place, "Kopitiam Lah in Indiranagar");
  assertEquals(facts.what, "table for 2");
  assertEquals(facts.action, "book");
  assertEquals(facts.name, "Ihaz");
  assertEquals(String(facts.number).startsWith("given (+91 98…)"), true);
  const withheld = planFacts({
    task: "booking",
    place,
    f: { ...target, share_phone: false },
    customerPhone: "+919812345678",
    now,
  });
  assertEquals(String(withheld.number).startsWith("withheld"), true);
  const askOnly = planFacts({
    task: "booking",
    place,
    f: { ...target, may_book: false },
    customerPhone: "+919812345678",
    now,
  });
  assertEquals([askOnly.action, "name" in askOnly, "number" in askOnly], [
    "ask whether they can, and book nothing yet",
    false,
    false,
  ]);
});

Deno.test("code refuses time fields that contradict each other, without picking a reading", () => {
  // One patch can't hold both meanings.
  const both = checkSlots("booking", { party_size: 2 }, {
    time_open: true,
    day: "2026-11-07",
    window_start: "2026-11-07T20:30:00+05:30",
    window_end: "2026-11-07T21:30:00+05:30",
    tolerance_min: 30,
  }, now);
  assertEquals(both, { ok: false, errors: [CONFLICT_OPEN_TOLERANCE] });
  // Nor can a tolerance be added to a time left to the business.
  const added = checkSlots("booking", handOff, { tolerance_min: 30 }, now);
  assertEquals(added.ok, false);
  // A tolerance needs a time of theirs to be room around.
  const loose = checkSlots("booking", { party_size: 2 }, {
    window_start: "2026-11-07T20:30:00+05:30",
    window_end: "2026-11-07T21:30:00+05:30",
    tolerance_min: 30,
  }, now);
  assertEquals(!loose.ok && loose.errors, [
    "tolerance_min: room either way of exact_time, so only with exact_time",
  ]);
  // Either meaning on its own is stored as given.
  assertEquals(
    checkSlots("booking", { party_size: 2 }, { exact_time: NINE, tolerance_min: 30 }, now).ok,
    true,
  );
  assertEquals(
    checkSlots("booking", { party_size: 2 }, {
      time_open: true,
      window_start: "2026-11-07T20:30:00+05:30",
      window_end: "2026-11-07T21:30:00+05:30",
    }, now).ok,
    true,
  );
});

Deno.test("a new meaning replaces the old one whole, so nothing of the old one is left behind", () => {
  // Their time with room, then a range: the room was around the old time, so it goes too.
  const range = checkSlots("booking", target, {
    window_start: "2026-11-07T20:00:00+05:30",
    window_end: "2026-11-07T22:00:00+05:30",
  }, now);
  assertEquals(range.ok && range.patch, {
    window_start: "2026-11-07T20:00:00+05:30",
    window_end: "2026-11-07T22:00:00+05:30",
    exact_time: null,
    tolerance_min: null,
  });
  // Their time with room, then left to the business.
  const open = checkSlots("booking", target, { time_open: true, day: "2026-11-07" }, now);
  assertEquals(open.ok && [open.patch.exact_time, open.patch.tolerance_min, open.patch.time_given], [
    null,
    null,
    "none",
  ]);
});

Deno.test("an old incoherent row isn't refused for an edit that leaves the time alone", () => {
  const old: Fields = { ...handOff, tolerance_min: 30 };
  assertEquals(incoherentTime(old), [CONFLICT_OPEN_TOLERANCE]);
  assertEquals(checkSlots("booking", old, { party_size: 3 }, now).ok, true);
});

// ---- whole turns, with a scripted Luna and forced checker verdicts ----

const call = (name: string, args: unknown, id: string): Item => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: `call_${id}`,
});

const kopitiam: ActiveRequest = {
  id: "r1",
  task: "booking",
  state: "collecting",
  version: 1,
  fields: { party_size: 2, customer_name: "Ihaz" },
  businessId: "b1",
  bookingId: null,
  createdAt: now,
  pausedAt: null,
};

const handOffPatch = {
  time_open: true,
  day: "2026-11-07",
  window_start: "2026-11-07T20:30:00+05:30",
  window_end: "2026-11-07T21:30:00+05:30",
};

function turn(
  steps: Item[][],
  verdicts: {
    edit?: (i: GroundingInput) => GroundingResult;
    plan?: (i: GroundingInput) => GroundingResult;
    draft?: (text: string, input: PlanInput, n: number) => { ok: true } | { ok: false; problems: string[] };
  } = {},
) {
  const store = new FakeChatStore();
  store.req = structuredClone(kopitiam);
  store.place = async () => place;
  store.lines = [
    { from: "user", text: "Kopitiam Lah, dinner for 2 tonight", at: new Date(now.getTime() - 120_000) },
    { from: "desk", text: "What time tonight should I book for two?", at: new Date(now.getTime() - 100_000) },
    { from: "user", text: "Around 9", at: new Date(now.getTime() - 90_000) },
    {
      from: "desk",
      text: "How flexible are you if 9 isn't available?",
      at: new Date(now.getTime() - 60_000),
    },
    { from: "user", text: "30 mins sooner or later", at: new Date(now.getTime() - 30_000) },
  ];
  const sent: Outbound[] = [];
  const inputs: Item[][] = [];
  const grounding: GroundingInput[] = [];
  const checked: { text: string; input: PlanInput }[] = [];
  const pass = (): GroundingResult => ({ ok: true, evidence: [{ field: "x", message: 1, source: "user" }] });
  const deps: LunaDeps = {
    store,
    send: async (_u, m) => {
      sent.push(m);
      return `wamid.out${sent.length}`;
    },
    now: () => now,
    create: async (req): Promise<ResponseOut> => {
      inputs.push(structuredClone(req.input));
      return { output: steps.shift() ?? [], usage: { input_tokens: 0, output_tokens: 0 } };
    },
    searchPlaces: async () => [],
    onApproved: async () => ({ started: true }),
    checkIntent: async (i) => {
      grounding.push(i);
      return (i.phase === "edit" ? verdicts.edit : verdicts.plan)?.(i) ?? pass();
    },
    checkPlan: async (input, text) => {
      checked.push({ text, input });
      return verdicts.draft?.(text, input, checked.length) ?? { ok: true };
    },
  };
  return { store, sent, inputs, grounding, checked, deps };
}

// What the last tool call of a step got back, as Luna reads it.
function result(inputs: Item[][], step: number, callId: string): Record<string, unknown> {
  const out = inputs[step].find((i) => i.type === "function_call_output" && i.call_id === `call_${callId}`);
  return JSON.parse((out as { output: string }).output);
}

const unclearHandOff = (i: GroundingInput): GroundingResult =>
  i.patch.time_open
    ? {
      ok: false,
      reason: "intent_unclear",
      clarification: "Did they want 9 with room either side, or any time the place picks?",
    }
    : { ok: true, evidence: [{ field: "exact_time", message: 3, source: "user" }] };

Deno.test("a refused reading is repaired from their messages, then the plan in Luna's own words", async () => {
  const draft1 = "Kopitiam Lah in Indiranagar, table for 2 tonight. Shall I book it?";
  const draft2 =
    "I'll call Kopitiam Lah in Indiranagar for a table for 2 tonight at 9, happy with anything " +
    "from 8:30 to 9:30, in your name, and give them your number in case they need you. Go ahead?";
  const t = turn([
    [call("set_slots", { fields: handOffPatch }, "s1")],
    // The same reading again: refused without another check.
    [call("set_slots", { fields: handOffPatch }, "s2")],
    [call("set_slots", { fields: { exact_time: NINE, tolerance_min: 30 } }, "s3")],
    [call("propose_plan", { text: draft1 }, "p1")],
    [call("propose_plan", { text: draft2 }, "p2")],
  ], {
    edit: unclearHandOff,
    draft: (_text, _input, n) => n === 1 ? { ok: false, problems: ["drops the time"] } : { ok: true },
  });
  await runLuna(t.deps, user, now);

  // The first refusal: nothing stored, the question it raises, and how to repair.
  const first = result(t.inputs, 1, "s1");
  assertEquals([first.ok, first.stored, first.clarification], [
    false,
    "nothing",
    "Did they want 9 with room either side, or any time the place picks?",
  ]);
  // The repeat isn't checked again, and Luna is told it was already refused.
  const again = result(t.inputs, 2, "s2");
  assertEquals(String(again.next).startsWith("You already sent this and it was refused"), true);
  assertEquals(t.grounding.filter((g) => g.phase === "edit").length, 2);

  // Stored: their time with room, nothing of the refused hand-off.
  const f = t.store.req!.fields;
  assertEquals([f.exact_time, f.tolerance_min, f.time_open, f.window_start], [
    NINE,
    30,
    undefined,
    undefined,
  ]);

  // The plan check read the draft against facts with the meaning, not a sentence.
  assertEquals(
    (t.checked[0].input.facts.when as Record<string, unknown>).kind,
    "their time, with room either way",
  );
  // A refused draft comes back with the problems and the facts, and no readback to copy.
  const refused = result(t.inputs, 4, "p1");
  assertEquals(refused.problems, ["drops the time"]);
  assertEquals(typeof refused.facts, "object");
  assertEquals("must_cover" in refused, false);
  assertEquals(JSON.stringify(refused).includes("Shall I go ahead?"), false);

  // What they approve is Luna's second draft, and the call does what it says.
  assertEquals(t.store.prompt?.text, draft2);
  assertEquals(t.sent, [{ kind: "text", body: draft2 }]);
  const brief = caller(t.store.req!.fields);
  assertEquals(brief.includes("9:00 pm IST") && brief.includes("Up to 30 minutes either way"), true);
});

Deno.test("when their messages leave it open, Luna asks the one question and stores nothing", async () => {
  const t = turn([
    [call("set_slots", { fields: handOffPatch }, "s1")],
    [call("reply", { text: "Should I aim for 9, or let them pick any time between 8:30 and 9:30?" }, "r1")],
  ], { edit: unclearHandOff });
  await runLuna(t.deps, user, now);
  assertEquals(t.store.slotWrites, []);
  assertEquals(t.store.prompt, null);
  assertEquals(t.sent, [{
    kind: "text",
    body: "Should I aim for 9, or let them pick any time between 8:30 and 9:30?",
  }]);
});

Deno.test("refused stored details: the plan isn't checked again, nothing commits, and the fallback is honest", async () => {
  // The stored state is one grounding won't accept, and Luna keeps proposing it.
  const t = turn(
    Array.from(
      { length: 6 },
      (_, i) => [call("propose_plan", { text: "Kopitiam Lah at 9. Go ahead?" }, `p${i}`)],
    ),
    {
      plan: () => ({
        ok: false,
        reason: "intent_unclear",
        clarification: "Did they want 9 with room either side, or any time the place picks?",
      }),
    },
  );
  t.store.req = { ...t.store.req!, state: "confirming", fields: { ...kopitiam.fields, exact_time: NINE } };
  await runLuna(t.deps, user, now);

  // One plan check of that version; the rest were refused as repeats.
  assertEquals(t.grounding.filter((g) => g.phase === "plan").length, 1);
  const repeat = result(t.inputs, 2, "p1");
  assertEquals(String(repeat.next).startsWith("You already sent this"), true);
  // Nothing proposed, approved or changed.
  assertEquals([t.store.prompt, t.store.slotWrites, t.store.consents], [null, [], []]);
  assertEquals(t.checked, []);
  // The fallback doesn't recite details a check refused, or ask for more.
  assertEquals(t.sent, [{ kind: "text", body: "[fallback_unsure]" }]);
});

Deno.test("repair fails with nothing missing: the fallback says what it has and asks for nothing", async () => {
  const bad = [call("reply", { text: "**bold**" }, "r")];
  const t = turn([bad, bad, bad]);
  t.store.req = { ...t.store.req!, fields: { ...target } };
  await runLuna(t.deps, user, now);
  assertEquals(t.sent, [{ kind: "text", body: "[fallback_held]" }]);
});

Deno.test("repair fails with something genuinely missing: only then does the fallback ask for the rest", async () => {
  const bad = [call("reply", { text: "**bold**" }, "r")];
  const t = turn([bad, bad, bad]);
  await runLuna(t.deps, user, now);
  assertEquals(t.sent, [{ kind: "text", body: "[fallback_known]" }]);
});

Deno.test("an incoherent stored time never reaches a plan, not even the readback", async () => {
  const t = turn([]);
  t.store.req = { ...t.store.req!, state: "confirming", fields: { ...handOff, tolerance_min: 30 } };
  const res = await proposePlan(t.deps, user, "r1", null, "Kopitiam Lah tonight. Go ahead?");
  assertEquals(res.ok, false);
  assertEquals("errors" in res && res.errors, [CONFLICT_OPEN_TOLERANCE]);
  assertEquals([t.store.prompt, t.sent, t.grounding, t.checked], [null, [], [], []]);
});

Deno.test("the last-resort readback describes the grounded state, after two refused drafts", async () => {
  const t = turn([
    [call("propose_plan", { text: "Kopitiam Lah. Go ahead?" }, "p1")],
    [call("propose_plan", { text: "Kopitiam Lah, tonight. Go ahead?" }, "p2")],
  ], { draft: () => ({ ok: false, problems: ["drops the time"] }) });
  t.store.req = { ...t.store.req!, state: "confirming", fields: { ...target } };
  await runLuna(t.deps, user, now);
  const sentText = (t.sent[0] as { body: string }).body;
  assertEquals(t.store.prompt?.text, sentText);
  assertEquals(sentText.includes("tonight (Sat 7 Nov) at 9:00 pm (up to 30 min either way)"), true);
});
