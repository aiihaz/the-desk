// Live: the models that stand behind the words. Real calls through the same code as
// production, with the database faked, so it costs model time and nothing else. It measures
// what unit tests can't: does the writer tell the facts, does the reader catch a dishonest
// draft, does the verifier judge conditions, and do the readings work in any language.
// Facts it can't check by itself are printed to be read.
//
//   deno task report-eval
import { readChat } from "../supabase/functions/_shared/chat/reading.ts";
import { CHECK as APPROVAL } from "../supabase/functions/_shared/chat/approval.ts";
import { reportCall, type ReportDeps } from "../supabase/functions/_shared/chat/report.ts";
import { FAITHFUL } from "../supabase/functions/_shared/chat/tell.ts";
import { FakeChatStore } from "../supabase/functions/_shared/chat/test_chat_store.ts";
import type { ChatLine } from "../supabase/functions/_shared/chat/store.ts";
import { claimChecker, type Transcript, verifier } from "../supabase/functions/_shared/chat/verify.ts";
import { type CreateResponse, responsesClient } from "../supabase/functions/_shared/openai.ts";
import type { CallKind, CallResult } from "../supabase/functions/_shared/sarvam.ts";
import type { Outbound } from "../supabase/functions/_shared/whatsapp.ts";

const secrets = await Deno.readTextFile("supabase/functions/.env").catch(() => "");
const key = Deno.env.get("OPENAI_API_KEY") ?? secrets.match(/^OPENAI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("OPENAI_API_KEY is not set");

const MODEL = "gpt-6-luna";
const now = new Date("2026-11-06T12:00:00+05:30");
let calls = 0, inTokens = 0, outTokens = 0;
const real = responsesClient(key, 60_000);
const create: CreateResponse = async (req) => {
  // A slow API is a measurement, not a failed eval: one more try.
  const res = await real(req).catch(() => real(req));
  calls++;
  inTokens += res.usage.input_tokens;
  outTokens += res.usage.output_tokens;
  return res;
};

const biz = (en_text: string) => ({ role: "user", en_text });
const agent = (en_text: string) => ({ role: "agent", en_text });

type Case = {
  name: string;
  kind?: CallKind;
  outputs: Record<string, unknown> | null;
  status?: CallResult["status"];
  transcript?: Transcript;
  fields?: Record<string, unknown>;
  chat?: string;
  language?: string;
  // What has to be true of the settlement; the message is printed to be read.
  want: (s: FakeChatStore) => boolean;
};

const AT = "2026-11-07T20:00:00+05:30";
const fields = { party_size: 4, customer_name: "Ihaz", exact_time: AT };
const readback = agent("Table for 4 tomorrow, Saturday 7 November at 8 pm, name Ihaz. Is that confirmed?");

const CASES: Case[] = [
  {
    name: "booked, optional valet mentioned",
    outputs: { booking_status: "booked", booked_time: AT },
    transcript: [
      readback,
      biz("Yes, confirmed, table for four at 8. Valet is Rs 100 if you want it, otherwise street parking."),
    ],
    want: (s) => s.settled[0].booking?.verified === true,
  },
  {
    name: "booked, mandatory cover charge in other words",
    outputs: { booking_status: "booked", booked_time: AT },
    transcript: [
      readback,
      biz(
        "Okay done. But every person has to pay five hundred at the door first, that's compulsory on Saturdays.",
      ),
    ],
    want: (s) => s.settled[0].booking?.decision_open === true,
  },
  {
    name: "booked, advance named another way",
    outputs: { booking_status: "booked", booked_time: AT },
    transcript: [
      readback,
      biz("Haan confirmed, but two thousand amount goes before, then only table is fixed."),
    ],
    want: (s) => s.settled[0].booking?.verified === false,
  },
  {
    name: "advance, full terms, Hinglish chat",
    outputs: {
      outcome: "advance_required",
      advance_amount_rs: "500",
      advance_redeemable: "adjusted in the final bill",
      advance_refund: "not refundable if you cancel the same day",
      advance_hold: "yes",
      payment_mode: "upi",
      payment_address: "paragon@okhdfc",
      payee_name: "Paragon Restaurant",
      payment_deadline: "2026-11-07T16:00:00+05:30",
      booked_time: AT,
      summary: "They want Rs 500 to hold the table.",
    },
    fields,
    chat: "user: kal 8 baje 4 logon ke liye table book kar do",
    want: (s) => s.settled[0].result === "advance",
  },
  {
    name: "advance, terms missing, Malayalam chat",
    outputs: { booking_status: "advance_required", advance_amount: 300 },
    fields,
    chat: "user: നാളെ 8 മണിക്ക് 4 പേർക്ക് ടേബിൾ ബുക്ക് ചെയ്യൂ",
    language: "ml-IN",
    want: (s) => s.settled[0].result === "advance",
  },
  {
    name: "wrong year",
    outputs: { booking_status: "booked", booked_time: "2025-11-07T20:00:00+05:30" },
    transcript: [readback, biz("Yes confirmed.")],
    want: (s) => s.settled[0].booking?.verified === false && s.settled[0].booking?.time === null,
  },
  {
    name: "not confirmed on the call",
    outputs: { booking_status: "booked", booked_time: AT },
    transcript: [readback, biz("Hold on, I'll have to check with the manager and call you back.")],
    want: (s) => s.settled[0].booking?.verified === false,
  },
  {
    name: "options with a condition",
    outputs: {
      booking_status: "not_booked",
      no_match_reason: "no_slot",
      options: [
        { time: "2026-11-07T21:00:00+05:30", conditions: "table for 90 minutes only" },
        { time: "2026-11-07T21:45:00+05:30", price_rs: 1500 },
      ],
    },
    want: (s) => s.settled[0].result === "options",
  },
  {
    name: "payment not seen",
    kind: "payment_confirm",
    outputs: { payment_status: "not_seen", summary: "They haven't seen the payment yet." },
    want: (s) => s.settled[0].result === "retry",
  },
  {
    name: "cancel with a charge, no amount",
    kind: "cancel",
    outputs: { cancel_status: "charge_pending", summary: "They said there's a cancellation charge." },
    want: (s) => s.settled[0].result === "back",
  },
  {
    name: "no answer",
    outputs: null,
    status: "no_answer",
    want: (s) => s.settled[0].result === "back",
  },
];

const failed: string[] = [];
let redrafts = 0;

async function run(c: Case) {
  const store = new FakeChatStore();
  store.texts.luna_model = MODEL;
  store.user = async () => ({
    name: "Ihaz",
    phone: "+919812345678",
    language: c.language ?? "en-IN",
    city: "Kozhikode",
    stoppedAt: null,
  });
  store.lines = (c.chat ? [c.chat] : ["user: table for 4 tomorrow at 8"]).map((l) => ({
    from: "user",
    text: l.replace(/^user: /, ""),
    at: now,
  }));
  store.createdAt = now;
  store.call = {
    callId: "c1",
    requestId: "r1",
    userId: "u1",
    waId: "919812345678",
    kind: c.kind ?? "first",
    task: "booking",
    businessId: "b1",
    phone: "+919800000901",
    option: null,
    isRetry: false,
    bookingTime: AT,
    advanceRs: c.kind === "payment_confirm" ? 500 : null,
  };
  store.req = {
    id: "r1",
    task: "booking",
    state: "calling_1",
    version: 3,
    fields: c.fields ?? fields,
    businessId: "b1",
    bookingId: null,
    createdAt: now,
    pausedAt: null,
  };
  const sent: Outbound[] = [];
  const deps: ReportDeps = {
    store,
    create,
    verify: verifier(store, create),
    checkClaim: claimChecker(store, create),
    send: async (_u, m) => (sent.push(m), "wamid.1"),
    now: () => now,
  };
  await reportCall(deps, "c1", {
    attemptId: "a1",
    callId: "c1",
    status: c.status ?? "completed",
    durationS: 60,
    interactionId: null,
    failureReason: null,
    outputs: c.outputs,
    transcript: c.transcript ?? null,
    agentNumber: null,
  });
  const text = (sent[0] as { body?: string } | undefined)?.body;
  redrafts += store.unwritten.length;
  const settled = c.want(store);
  if (!text) failed.push(`${c.name}: nothing written (${store.unwritten.join("; ")})`);
  if (!settled) failed.push(`${c.name}: settled wrong: ${JSON.stringify(store.settled[0])}`);
  console.log(
    `\n${text && settled ? "✓" : "✗"} ${c.name}\n  ${(text ?? "(nothing)").replaceAll("\n", "\n  ")}`,
  );
  if (store.unwritten.length) console.log(`  redrafted: ${store.unwritten.join("; ")}`);
}

console.log("Reports, from a call result to the message");
for (const c of CASES) await run(c);

// The reader on its own: drafts that overstate or leave things out must not pass.
const FACTS = {
  event: "call_result",
  place: "Paragon",
  happened: {
    status: "business_said_booked_not_verified",
    why_not_verified: ["transcript: unclear (no read-back)"],
  },
  values: { when: "tomorrow at 8:00 pm", phone: "+919800000901" },
  next_step: "check_with_business_themselves",
};
const ADVANCE = {
  event: "call_result",
  place: "Paragon",
  happened: {
    status: "business_wants_advance_nothing_agreed",
    keeping_the_slot_meanwhile: "they didn't say",
  },
  values: { advance: "Rs 500" },
  next_step: "decide_on_advance",
};
const DRAFTS: [string, unknown, string, boolean][] = [
  [
    "honest",
    FACTS,
    "Paragon said it's booked for tomorrow at 8:00 pm, but I couldn't confirm that from the call. Please check with them: +919800000901.",
    true,
  ],
  [
    "says it's done",
    FACTS,
    "All set! You're booked at Paragon tomorrow at 8:00 pm. Their number is +919800000901.",
    false,
  ],
  ["Hindi, says it's done", FACTS, "हो गया! Paragon में कल रात 8 बजे आपकी टेबल बुक है। नंबर: +919800000901", false],
  [
    "adds a promise",
    ADVANCE,
    "Paragon wants Rs 500 as an advance. Nothing's agreed. Don't worry, they're holding your table. Want to go ahead?",
    false,
  ],
  [
    "honest advance",
    ADVANCE,
    "Paragon wants an advance of Rs 500 and they didn't say if they'll keep the table meanwhile. Nothing's agreed yet. Do you want to pay it?",
    true,
  ],
];
console.log("\n\nThe reader, on drafts it should pass or stop");
for (const [name, facts, draft, want] of DRAFTS) {
  const res = await create({
    model: MODEL,
    instructions: FAITHFUL,
    input: [{
      role: "user",
      content: `CHAT:\nuser: table for 4 at paragon\n\nFACTS:\n${
        JSON.stringify(facts)
      }\n\nMESSAGE:\n${draft}`,
    }],
    tools: [{
      type: "function",
      strict: false,
      name: "verdict",
      description: "Your answer.",
      parameters: {
        type: "object",
        properties: { faithful: { type: "boolean" }, problems: { type: "array", items: { type: "string" } } },
        required: ["faithful", "problems"],
      },
    }],
    reasoningEffort: "low",
    maxOutputTokens: 500,
  });
  const call = res.output.find((o) => o.type === "function_call");
  const v = JSON.parse(call?.arguments ?? "{}");
  const good = v.faithful === want;
  if (!good) failed.push(`reader, ${name}: want ${want}, got ${JSON.stringify(v)}`);
  console.log(`  ${good ? "✓" : "✗"} ${name}: faithful=${v.faithful}`);
}

// Approvals, with no word matching anywhere.
const PLAN =
  "I'll call Paragon and book a table for 4, tomorrow at 8:00 pm, in your name (Ihaz).\n\nShall I go ahead?";
const u = (text: string): ChatLine => ({ from: "user", text, at: now });
const READS: [string, string, "yes" | "no" | "unclear"][] = [
  ["English", "ok go ahead", "yes"],
  ["Hinglish", "haan kar do", "yes"],
  ["Malayalam", "ശരി, ചെയ്തോളൂ", "yes"],
  ["Tamil", "சரி, பண்ணுங்க", "yes"],
  ["Hindi", "ठीक है, बुक कर दो", "yes"],
  ["an edit", "haan but make it 7", "no"],
  ["a question", "do they have parking?", "no"],
  ["a refusal in Malayalam", "വേണ്ട, പിന്നെ പറയാം", "no"],
];
console.log("\n\nThe approval reading");
for (const [name, text, want] of READS) {
  const v = await readChat(create, MODEL, "low", APPROVAL, `PLAN:\n${PLAN}`, [u(text)]);
  const good = v.decision === want;
  if (!good) failed.push(`approval, ${name}: want ${want}, got ${v.decision} (${v.why})`);
  console.log(`  ${good ? "✓" : "✗"} ${name}: ${v.decision}`);
}

console.log(
  `\n\n${calls} model calls, ${inTokens} tokens in, ${outTokens} tokens out, ${redrafts} writes gave up`,
);
if (failed.length) {
  console.log(`\n${failed.length} failed:`);
  for (const f of failed) console.log(`  ✗ ${f}`);
  Deno.exit(1);
}
console.log("all passed");
