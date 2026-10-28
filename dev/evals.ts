// Live conversations against the test bench (review item 11: start at 5, then grow).
// Each case resets the dev user, plays the user's messages through the real agent and
// Luna, and checks the result from the event log. Costs a few OpenAI calls per case.
//
//   deno task dev      (in one terminal)
//   deno task eval     (in another)
//
// Measures what the feel review asks for: user messages until the read-back, Desk
// messages that were questions, and Luna time and tokens.

const BASE = Deno.env.get("DEV_URL") ?? "http://localhost:8787";

type Event = { at: string; type: string; data: Record<string, unknown> };
type Msg = { text: string; quoteLastPrompt?: boolean };
type Run = { events: Event[]; userMsgs: number };
type Case = { name: string; messages: Msg[]; check: (r: Run) => string[] };

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
}

async function events(): Promise<Event[]> {
  return await (await fetch(BASE + "/api/events")).json();
}

const outs = (ev: Event[]) => ev.filter((e) => e.type === "whatsapp_out").map((e) => e.data as Out);
type Out = { id: string; msg: { kind: string; body?: string; buttons?: { id: string }[] } };
// A plan: code-built text ending in a plain question (readback.ts). No buttons.
const isReadback = (o: Out) =>
  o.msg.kind === "text" &&
  /\n\n(Shall I (go ahead|call them)|Do you still want me to cancel)\?$/.test(o.msg.body ?? "");
const consented = (ev: Event[]) =>
  ev.some((e) => e.type === "decision:consent" && (e.data as { ok: boolean }).ok);

// Index (1-based) of the user message after which the first read-back arrived, or null.
function userMsgsToReadback(ev: Event[]): number | null {
  let n = 0;
  for (const e of ev) {
    if (e.type === "whatsapp_in") n++;
    if (e.type === "whatsapp_out" && isReadback(e.data as Out)) return n;
  }
  return null;
}

const tomorrowTable = "table for 4 at paragon tmrw around 8";

const CASES: Case[] = [
  {
    name: "one message carries everything",
    messages: [{ text: tomorrowTable }],
    check: (r) => {
      const f: string[] = [];
      if (userMsgsToReadback(r.events) !== 1) f.push("no read-back after the first message");
      const asked = outs(r.events).filter((o) => o.msg.kind === "text" && o.msg.body?.includes("?"));
      if (asked.length) f.push(`asked a question it didn't need: "${asked[0].msg.body}"`);
      return f;
    },
  },
  {
    name: "missing details come back as one question",
    messages: [{ text: "book a table at paragon" }, { text: "tomorrow 8pm, 4 of us" }],
    check: (r) => {
      const f: string[] = [];
      const ins = r.events.flatMap((e, i) => e.type === "whatsapp_in" ? [i] : []);
      const firstReplies = r.events.slice(ins[0], ins[1]).filter((e) => e.type === "whatsapp_out");
      if (firstReplies.length !== 1) {
        f.push(`expected one reply to the first message, got ${firstReplies.length}`);
      }
      if (userMsgsToReadback(r.events) !== 2) f.push("no read-back after the second message");
      const rb = outs(r.events).find(isReadback)?.msg.body ?? "";
      if (rb && !rb.includes("at 8:00 pm")) {
        f.push(`"8pm" should be asked as exactly 8: "${rb.split("\n")[1]}"`);
      }
      const q = (firstReplies[0]?.data as Out | undefined)?.msg.body ?? "";
      if (/paragon/i.test(q) && /which (place|restaurant)/i.test(q)) f.push(`re-asked the place: "${q}"`);
      return f;
    },
  },
  {
    name: "edit, side question, then a quoted yes",
    messages: [
      { text: tomorrowTable },
      { text: "make it 5 people" },
      { text: "do they have parking?" },
      { text: "yes", quoteLastPrompt: true },
    ],
    check: (r) => {
      const f: string[] = [];
      const rbs = outs(r.events).filter(isReadback);
      if (rbs.length < 2 || !rbs.at(-1)!.msg.body!.includes("table for 5")) f.push("no new read-back for 5");
      const side = outs(r.events).filter((o) => o.msg.kind === "text").at(-1)?.msg.body ?? "";
      if (/parking (is|available)|they have parking|plenty of parking/i.test(side)) {
        f.push(`stated a parking fact it can't know: "${side}"`);
      }
      const promised = outs(r.events).some((o) =>
        o.msg.kind === "text" && /ask .*parking|parking.*on the call/i.test(o.msg.body ?? "")
      );
      const inReadback = rbs.some((o) => /parking/i.test(o.msg.body ?? ""));
      if (promised && !inReadback) {
        f.push("promised to ask about parking, but the read-back doesn't include it");
      }
      if (!consented(r.events)) f.push("the quoted yes did not store consent");
      return f;
    },
  },
  {
    name: "plain-words approval in Hinglish starts the call",
    messages: [{ text: tomorrowTable }, { text: "haan kar do" }],
    check: (r) => (consented(r.events) ? [] : ["'haan kar do' after the plan did not store consent"]),
  },
  {
    name: "a question after the plan is answered, not taken as approval",
    messages: [{ text: tomorrowTable }, { text: "is it veg only there?" }],
    check: (r) => {
      const f: string[] = [];
      if (consented(r.events)) f.push("a question was taken as approval");
      const last = outs(r.events).at(-1)?.msg.body ?? "";
      if (/\b(it is|they are|yes,? it'?s) veg/i.test(last)) f.push(`stated a fact it can't know: "${last}"`);
      return f;
    },
  },
  {
    name: "yes with a change is an edit, not an approval",
    messages: [{ text: tomorrowTable }, { text: "yes but make it 9pm" }],
    check: (r) => {
      const f: string[] = [];
      if (consented(r.events)) f.push("approved the old plan");
      const rbs = outs(r.events).filter(isReadback);
      if (!rbs.at(-1)?.msg.body?.includes("9:00 pm")) f.push("no new plan at 9 pm");
      return f;
    },
  },
  {
    name: "off-scope gets one line and no work",
    messages: [{ text: "write me a leave letter for tomorrow, I have fever" }],
    check: (r) => {
      const f: string[] = [];
      const replies = outs(r.events);
      if (replies.length !== 1) f.push(`expected one reply, got ${replies.length}`);
      const t = replies[0]?.msg.body ?? "";
      if (/dear|subject:|respected|leave application/i.test(t)) f.push(`wrote part of the letter: "${t}"`);
      if (r.events.some((e) => e.type === "decision:start_request")) f.push("started a request");
      return f;
    },
  },
  {
    name: "a different request asks before dropping the booking",
    messages: [{ text: tomorrowTable }, { text: "actually ask zudio if they have black jeans in size 32" }],
    check: (r) => {
      const f: string[] = [];
      if (userMsgsToReadback(r.events) !== 1) {
        f.push("no read-back after the first message, so nothing to protect");
      }
      const started = r.events.filter((e) => e.type === "decision:start_request");
      if (started.length > 1) f.push("dropped the booking without asking");
      const last = outs(r.events).at(-1);
      if (!last || last.msg.kind !== "text" || !last.msg.body?.includes("?")) {
        f.push(`expected a question, got: "${last?.msg.body ?? "nothing"}"`);
      }
      return f;
    },
  },
];

async function play(c: Case): Promise<Run> {
  await post("/api/reset", {});
  let userMsgs = 0;
  for (const m of c.messages) {
    const body: Record<string, string> = { text: m.text };
    if (m.quoteLastPrompt) {
      const rb = outs(await events()).filter(isReadback).at(-1);
      if (rb) body.quotedId = rb.id;
    }
    await post("/api/message", body);
    userMsgs++;
  }
  return { events: await events(), userMsgs };
}

let failed = 0;
const rows: string[][] = [];
for (const c of CASES) {
  const r = await play(c);
  const problems = c.check(r);
  const steps = r.events.filter((e) => e.type === "decision:luna_step");
  const ms = steps.reduce((a, e) => a + Number(e.data.ms ?? 0), 0);
  const tok = steps.reduce((a, e) => {
    const u = e.data.usage as { input_tokens: number; output_tokens: number };
    return a + u.input_tokens + u.output_tokens;
  }, 0);
  if (problems.length) failed++;
  rows.push([
    problems.length ? "FAIL" : "pass",
    c.name,
    String(r.userMsgs),
    String(userMsgsToReadback(r.events) ?? "–"),
    String(steps.length),
    `${(ms / 1000).toFixed(1)}s`,
    String(tok),
  ]);
  for (const p of problems) console.log(`  ✗ ${c.name}: ${p}`);
}

const head = ["result", "case", "user msgs", "read-back at msg", "Luna steps", "Luna time", "tokens"];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r: string[]) => r.map((v, i) => v.padEnd(w[i])).join("  ");
console.log("\n" + line(head) + "\n" + w.map((n) => "-".repeat(n)).join("  "));
for (const r of rows) console.log(line(r));
console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
if (failed) Deno.exit(1);
