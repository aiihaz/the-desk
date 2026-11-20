// Comparison bench: one comparison errand against real businesses, with no chat in front
// of it. It runs the production path from the search on: Places picks the top-rated five
// (find_business), the plan and a bench YES are stored like a chat approval
// (open_prompt, record_consent with its watermark), and callAfterConsent dials each
// business through dial() and Sarvam, with every database check per call. Results come
// back through the deployed sarvam-webhook and settle into the ranked summary as usual.
//
// The errand belongs to the bench user (channel 'bench', 0036), so what the Desk would
// send (the "calling these" notice, the ranked summary) is written and stored in
// production and never reaches iMessage or WhatsApp. Each run is also copied, with every
// call's outputs, transcript and audio path, to bench_runs, which the transcript
// retention purge doesn't touch.
//
//   deno task bench --query "salon" --area "Indiranagar" --city "Bengaluru" \
//     --ask "How much is a men's haircut?" --ask "Do you take walk-ins today?"
//   deno task bench ... --dry-run      search and show the picks; no plan, no calls
//   deno task bench --watch <request id>   follow a run already started, and save it
//
// Production project only. Secrets: supabase/functions/.env (or --env <file>) for Sarvam,
// Places and OpenAI; the service key comes from the logged-in Supabase CLI.
import { parseArgs } from "jsr:@std/cli@1.0.6/parse-args";
import { DbCallStore } from "../supabase/functions/_shared/call_store.ts";
import { callAfterConsent } from "../supabase/functions/_shared/chat/calls.ts";
import { comparisonQuestions } from "../supabase/functions/_shared/chat/comparison.ts";
import { findBusiness } from "../supabase/functions/_shared/chat/find.ts";
import { DbChatStore } from "../supabase/functions/_shared/chat/store.ts";
import { dial } from "../supabase/functions/_shared/dial.ts";
import { createDelivery } from "../supabase/functions/_shared/messaging.ts";
import { observedResponsesClient } from "../supabase/functions/_shared/model_client.ts";
import { placesClient, type SearchPlaces } from "../supabase/functions/_shared/places.ts";
import { sarvamConfigFromEnv, startCall } from "../supabase/functions/_shared/sarvam.ts";
import { serperClient, withWebPhones } from "../supabase/functions/_shared/serper.ts";
import { DbStore, serviceClient, type User } from "../supabase/functions/_shared/store.ts";

const PROJECT = "rvglpiyctuzpegbvlane";
const BENCH_ID = "bench:comparison";
const POLL_MS = 15_000;
// Secrets the local dial uses that must be production's: the webhook token is how the
// deployed sarvam-webhook accepts this call's result.
const MUST_MATCH = [
  "SARVAM_API_KEY",
  "SARVAM_ORG_ID",
  "SARVAM_WORKSPACE_ID",
  "SARVAM_APP_ID",
  "SARVAM_CONNECTION_ID",
  "SARVAM_WEBHOOK_TOKEN",
];

const args = parseArgs(Deno.args, {
  string: ["query", "area", "city", "ask", "env", "watch", "timeout-min"],
  boolean: ["dry-run", "yes", "full"],
  collect: ["ask"],
});

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

async function loadEnv() {
  const here = decodeURIComponent(new URL("..", import.meta.url).pathname);
  const candidates = args.env ? [args.env] : [
    `${here}supabase/functions/.env`,
    `${here}../desk/supabase/functions/.env`,
  ];
  const file = candidates.find((p) => {
    try {
      return Deno.statSync(p).isFile;
    } catch {
      return false;
    }
  });
  if (!file) throw new Error(`no env file found (tried ${candidates.join(", ")}); pass --env`);
  for (const line of (await Deno.readTextFile(file)).split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !Deno.env.get(m[1])) Deno.env.set(m[1], m[2].replace(/^["']|["']$/g, ""));
  }
  Deno.env.set("SUPABASE_URL", `https://${PROJECT}.supabase.co`);
  if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    const keys = JSON.parse(await cli(["projects", "api-keys", "--project-ref", PROJECT, "-o", "json"]));
    const key = keys.find((k: Row) => k.name === "service_role")?.api_key;
    if (!key) throw new Error("could not read the service_role key from the Supabase CLI");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", key);
  }
  return file;
}

async function cli(cmd: string[]): Promise<string> {
  const out = await new Deno.Command("supabase", { args: cmd, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) {
    throw new Error(`supabase ${cmd.slice(0, 2).join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The CLI lists each production secret's SHA-256, never its value.
async function checkSecrets() {
  const listed: Row[] = JSON.parse(await cli(["secrets", "list", "--project-ref", PROJECT, "-o", "json"]));
  const prod = new Map(listed.map((s) => [s.name, String(s.value)]));
  const bad: string[] = [];
  for (const name of MUST_MATCH) {
    const local = Deno.env.get(name);
    if (!local) bad.push(`${name}: missing locally`);
    else if (!prod.has(name)) bad.push(`${name}: not set in production`);
    else if (prod.get(name) !== await sha256(local)) bad.push(`${name}: differs from production`);
  }
  if (bad.length) throw new Error(`local Sarvam secrets don't match production:\n  ${bad.join("\n  ")}`);
}

const db = () => serviceClient();

async function benchUser(city: string | null): Promise<User> {
  const { data, error } = await db().from("users").upsert(
    { wa_id: BENCH_ID, name: "Comparison bench", channel: "bench", ...(city ? { city } : {}) },
    { onConflict: "wa_id" },
  ).select("id, wa_id, blocked, channel").single();
  if (error) throw error;
  if (data.blocked) throw new Error("the bench user is blocked");
  const { error: e2 } = await db().from("user_limits").upsert(
    { user_id: data.id, key: "comparison_mode", value: true, updated_by: "comparison_bench" },
    { onConflict: "user_id,key" },
  );
  if (e2) throw e2;
  return { id: data.id, waId: data.wa_id, blocked: false, channel: "bench" };
}

async function rpc<T = Row>(fn: string, params: Row): Promise<T> {
  const { data, error } = await db().rpc(fn, params);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

function must(res: Row, what: string) {
  if (!res?.ok) throw new Error(`${what} refused: ${res?.reason ?? JSON.stringify(res)}`);
  return res;
}

async function ask(q: string): Promise<string> {
  await Deno.stdout.write(new TextEncoder().encode(q));
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  return new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim();
}

async function start() {
  const query = args.query?.trim();
  const city = args.city?.trim() ?? null;
  const questions = (args.ask ?? []).map((q) => q.trim()).filter(Boolean);
  if (!query || !questions.length) {
    console.error(
      'usage: deno task bench --query "<kind of place>" [--area <area>] --city <city> --ask "<question>" ...',
    );
    Deno.exit(2);
  }

  const chat = new DbChatStore();
  const store = new DbStore();
  const send = createDelivery(store);
  const user = await benchUser(city);

  // One errand at a time: an unapproved leftover is cancelled; a run still calling is followed.
  const { request: left } = await chat.active(user.id);
  if (left) {
    if (["calling_1", "calling_2", "verifying"].includes(left.state)) {
      console.log(`A bench run is still calling: ${left.id}. Following it.`);
      return watch(left.id);
    }
    must(await rpc("cancel_request", { p_request_id: left.id }), "cancelling the previous bench errand");
  }

  const q = must(await rpc("queue_request", { p_user_id: user.id, p_task: "question" }), "queue_request");
  const requestId: string = q.request_id;
  const { data: req } = await db().from("requests").select("comparison").eq("id", requestId).single();
  if (!req?.comparison) throw new Error("the errand didn't snapshot comparison mode; is 0034 live?");
  must(await rpc("update_slots", { p_request_id: requestId, p_fields: { questions } }), "update_slots");

  const env = (k: string) => Deno.env.get(k) ?? "";
  if (!env("GOOGLE_MAPS_API_KEY")) throw new Error("GOOGLE_MAPS_API_KEY is not set");
  const places: SearchPlaces = placesClient(env("GOOGLE_MAPS_API_KEY"));
  const searchPlaces = env("SERPER_API_KEY")
    ? withWebPhones(places, serperClient(env("SERPER_API_KEY")))
    : places;
  const found = await findBusiness({ store: chat, send, searchPlaces }, user, {
    query,
    area: args.area?.trim() || null,
    city,
    byKind: true,
  });
  const picked = (found.picked ?? []) as Row[];
  if (!found.ok || !picked.length) {
    await rpc("cancel_request", { p_request_id: requestId });
    throw new Error(`no businesses picked: ${found.ok ? "no callable results" : found.reason}`);
  }
  const { data: biz } = await db().from("businesses").select("id, name, phone_e164, area, city")
    .in("id", picked.map((p) => p.business_id));
  const phone = new Map((biz ?? []).map((b: Row) => [b.id, b.phone_e164]));
  console.log(`\nSearched: ${found.searched}`);
  for (const p of picked) {
    console.log(
      `  ${p.rank}. ${p.name}${p.area ? `, ${p.area}` : ""}  ★${p.rating ?? "–"} (${p.review_count ?? 0})  ${
        phone.get(p.business_id)
      }`,
    );
  }
  const fields = (await db().from("requests").select("fields").eq("id", requestId).single()).data?.fields ??
    {};
  console.log(`\nEach gets asked:\n${comparisonQuestions(fields).map((x) => `  - ${x}`).join("\n")}`);

  if (args["dry-run"]) {
    await rpc("cancel_request", { p_request_id: requestId });
    console.log("\nDry run: errand cancelled, nothing dialled.");
    return;
  }
  if (!args.yes) {
    const a = await ask(`\nThis dials ${picked.length} real businesses now. Type "call" to go: `);
    if (a.toLowerCase() !== "call") {
      await rpc("cancel_request", { p_request_id: requestId });
      console.log("Not called. Errand cancelled.");
      return;
    }
  }

  // The plan and its YES, stored as a chat approval is: the prompt the YES answers, and
  // the inbound message whose seq is the consent's watermark. The YES is marked handled
  // so no recovery pass hands it to the chat agent.
  const plan = `Bench: calling ${picked.map((p) => p.name).join(", ")} to ask: ${questions.join(" / ")}`;
  const now = Date.now();
  must(await rpc("advance_request", { p_request_id: requestId, p_to: "confirming" }), "advance_request");
  const promptId = crypto.randomUUID();
  must(
    await rpc("open_prompt", {
      p_prompt_id: promptId,
      p_request_id: requestId,
      p_kind: "ask",
      p_option_ids: [],
      p_confirm_word: "yes",
      p_text: plan,
      p_message: { kind: "text", body: plan },
    }),
    "open_prompt",
  );
  const planId = `bench:plan:${promptId}`;
  await store.saveOutbound(user.id, planId, { kind: "text", body: plan });
  await chat.promptSent(promptId, planId);
  const yesId = `bench:yes:${crypto.randomUUID()}`;
  await store.saveInbound(user.id, {
    waId: BENCH_ID,
    name: null,
    messageId: yesId,
    at: new Date(now + 1),
    type: "text",
    text: "YES",
    replyId: null,
    quotedId: null,
    raw: { type: "text", text: { body: "YES" }, bench: true },
  });
  await chat.markHandled(yesId);
  const { data: yes } = await db().from("messages").select("seq").eq("wa_message_id", yesId).single();
  const consent = must(
    await chat.recordConsent(promptId, null, "yes", yesId, {
      input_seq: yes!.seq,
      source: "comparison_bench",
    }),
    "record_consent",
  );

  await db().from("bench_runs").insert({
    request_id: requestId,
    user_id: user.id,
    query: String(found.searched),
    questions,
    picked: picked.map((p) => ({ ...p, phone: phone.get(p.business_id) })),
  });

  // The dial: this machine submits to Sarvam with production's secrets (checked above).
  Deno.env.set("DESK_CALLS_PAUSED", "0");
  const sarvam = sarvamConfigFromEnv();
  const calls = new DbCallStore();
  console.log(`\nApproved. Request ${requestId} (follow or reprint: --watch ${requestId}). Dialling…`);
  const res = await callAfterConsent(
    {
      store: chat,
      send,
      create: observedResponsesClient(env("OPENAI_API_KEY")),
      dial: (a) => dial({ store: calls, start: (c) => startCall(sarvam, c) }, a),
      trace: (event, data) => {
        if (event !== "dial") return;
        const d = data as Row;
        const r = d.res as Row;
        const name = picked.find((p) => p.business_id === d.businessId)?.name ?? d.businessId;
        console.log(
          `  ${name}: ${
            r.ok
              ? "submitted"
              : `${r.error}${r.reason ? ` (${r.reason})` : ""}${r.detail ? ` ${r.detail}` : ""}`
          }`,
        );
      },
    },
    user,
    consent as Parameters<typeof callAfterConsent>[2],
  );
  if (!res.started) {
    await snapshot(requestId, "not_started");
    console.log("\nNo call started. Saved to bench_runs.");
    return;
  }
  await watch(requestId);
}

// Every call of the run as it stands, saved to bench_runs.
async function snapshot(requestId: string, status?: string) {
  const { data: calls, error } = await db().from("calls").select(
    "id, status, outcome, submission_state, outputs, comparison_result, transcript, audio_path, duration_s, cost_rs_est, provider_call_id, created_at, settled_at, businesses(name, area, phone_e164)",
  ).eq("request_id", requestId).order("created_at");
  if (error) throw error;
  const { data: summary } = await db().from("deliveries").select("status, facts, message, created_at")
    .eq("dedupe_key", `comparison:${requestId}:summary`).maybeSingle();
  const { data: r } = await db().from("requests").select("state, user_id").eq("id", requestId).single();
  // What the bench user "received" after approving: the notice and the summary, as written.
  const { data: sent } = await db().from("messages").select("body, at").eq("user_id", r!.user_id)
    .eq("direction", "out").like("wa_message_id", "bench:%").not("wa_message_id", "like", "bench:plan:%")
    .gte("at", (calls ?? [])[0]?.created_at ?? new Date().toISOString()).order("at");
  const done = r!.state !== "calling_1" && summary?.status === "sent";
  const row = {
    calls: calls ?? [],
    summary: summary ? { ...summary, sent_messages: sent ?? [] } : null,
    status: status ?? (done ? "complete" : "dialing"),
    updated_at: new Date().toISOString(),
  };
  await db().from("bench_runs").update(row).eq("request_id", requestId);
  return { ...row, state: r!.state, done };
}

async function watch(requestId: string) {
  const until = Date.now() + Number(args["timeout-min"] ?? 30) * 60_000;
  const seen = new Map<string, string>();
  for (;;) {
    const s = await snapshot(requestId);
    for (const c of s.calls as Row[]) {
      const line = `${c.status}${c.outcome ? ` / ${c.outcome}` : ""}${c.settled_at ? " (settled)" : ""}`;
      if (seen.get(c.id) !== line) {
        seen.set(c.id, line);
        console.log(`  [${new Date().toLocaleTimeString("en-IN")}] ${c.businesses?.name}: ${line}`);
      }
    }
    if (s.done) return report(s);
    if (Date.now() > until) {
      await snapshot(requestId, "timed_out");
      console.log(`\nStill waiting after the timeout. Saved as timed_out; resume with --watch ${requestId}`);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function report(s: Row) {
  console.log("\n=== Ranked summary (stored, not sent) ===");
  for (const m of s.summary?.sent_messages ?? []) console.log(`\n${m.body?.body ?? JSON.stringify(m.body)}`);
  for (const c of s.calls as Row[]) {
    console.log(
      `\n--- ${c.businesses?.name} (${c.businesses?.phone_e164}) · ${c.status} · ${c.duration_s ?? "?"}s`,
    );
    if (c.outputs) console.log(`outputs: ${JSON.stringify(c.outputs, null, 2)}`);
    if (c.audio_path) console.log(`audio: call-audio/${c.audio_path}`);
    const lines = Array.isArray(c.transcript) ? c.transcript : [];
    for (const t of args.full ? lines : lines.slice(0, 12)) {
      console.log(`  ${t.role ?? t.speaker ?? "?"}: ${t.content ?? t.text ?? JSON.stringify(t)}`);
    }
    if (!args.full && lines.length > 12) console.log(`  … ${lines.length - 12} more lines (--full)`);
  }
  console.log("\nSaved to bench_runs.");
}

const envFile = await loadEnv();
console.log(`Production ${PROJECT}; local secrets from ${envFile}`);
if (args.watch) {
  await watch(args.watch);
} else {
  if (!args["dry-run"]) await checkSecrets();
  await start();
}
