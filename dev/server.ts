// Local test page for the chat agent while the WhatsApp number is blocked.
// Runs the real chat code (gate, state machine, read-backs) against the local
// Supabase database. WhatsApp and Sarvam are faked: nothing leaves this machine,
// and no call is ever placed. Every decision and database call is streamed to the page.
//
//   supabase start && deno task dev    →    http://localhost:8787
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { deliver } from "../supabase/functions/_shared/deliver.ts";
import { DbStore, type User } from "../supabase/functions/_shared/store.ts";
import type { Inbound, Outbound } from "../supabase/functions/_shared/whatsapp.ts";
import { errandRef, profileCard, recentCard, taskCard } from "../supabase/functions/_shared/chat/cards.ts";
import { reportCall } from "../supabase/functions/_shared/chat/report.ts";
import { claimChecker, verifier } from "../supabase/functions/_shared/chat/verify.ts";
import type { CallKind, CallResult } from "../supabase/functions/_shared/sarvam.ts";
import { type ChatStore, DbChatStore } from "../supabase/functions/_shared/chat/store.ts";
import { toolsFor } from "../supabase/functions/_shared/chat/states.ts";
import {
  cancelActive,
  setBusiness,
  setSlots,
  startNewRequest,
  type ToolDeps,
} from "../supabase/functions/_shared/chat/tools.ts";
import { proposePlan } from "../supabase/functions/_shared/chat/turn.ts";
import { type AgentDeps, handleInbound } from "../supabase/functions/_shared/chat/agent.ts";
import { runCommand } from "../supabase/functions/_shared/chat/commands.ts";
import { callKind } from "../supabase/functions/_shared/chat/calls.ts";
import { handleScreenshot } from "../supabase/functions/_shared/chat/payment.ts";
import { DbAdminStore } from "../supabase/functions/_shared/chat/admin.ts";
import { DbCallStore } from "../supabase/functions/_shared/call_store.ts";
import { callVariables } from "../supabase/functions/_shared/call_vars.ts";
import { type LunaDeps, runLuna } from "../supabase/functions/_shared/chat/luna.ts";
import { responsesClient } from "../supabase/functions/_shared/openai.ts";
import { jevClient } from "../supabase/functions/_shared/jev.ts";
import { type PlaceHit, placesClient, type SearchPlaces } from "../supabase/functions/_shared/places.ts";
import type { Task } from "../supabase/functions/_shared/chat/states.ts";
import type { ConsentStored } from "../supabase/functions/_shared/chat/store.ts";

await loadLocalEnv();
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const waStore = new DbStore(db);

const DEV_WA_ID = "919999900001";
const DEV_CALLER = "+918000000999";
const DEV_BUSINESSES = [
  {
    place_id: "dev/paragon",
    name: "Paragon",
    address: "Kannur Rd, Kozhikode",
    city: "Kozhikode",
    phone: "+919800000901",
  },
  {
    place_id: "dev/zudio",
    name: "Zudio",
    address: "Mavoor Rd, Kozhikode",
    city: "Kozhikode",
    phone: "+919800000902",
  },
  {
    place_id: "dev/toniguy",
    name: "Toni&Guy",
    address: "Indiranagar, Bengaluru",
    city: "Bengaluru",
    phone: "+919800000903",
  },
];

// Event stream -----------------------------------------------------------------

type Event = { at: string; type: string; data: unknown };
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const history: Event[] = [];
const enc = new TextEncoder();

function emit(type: string, data: unknown) {
  const e = { at: new Date().toISOString(), type, data };
  history.push(e);
  if (history.length > 500) history.shift();
  const chunk = enc.encode(`data: ${JSON.stringify(e)}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

const WRITES = new Set([
  "touch",
  "startRequest",
  "cancelRequest",
  "setBusiness",
  "updateSlots",
  "advance",
  "openPrompt",
  "promptSent",
  "recordConsent",
  "claimTurn",
  "releaseTurn",
  "markHandled",
  "stopUser",
  "resumeUser",
  "requestDeletion",
  "pauseRequest",
  "resumeRequest",
  "callNotStarted",
  "queueRequest",
  "activateQueued",
  "settleCall",
]);

// Logs every ChatStore call with its arguments, result and time.
function traced(store: ChatStore): ChatStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        const t0 = performance.now();
        try {
          const result = await v.apply(target, args);
          emit(WRITES.has(String(prop)) ? "db_write" : "db_read", {
            method: prop,
            args,
            result,
            ms: Math.round(performance.now() - t0),
          });
          return result;
        } catch (e) {
          emit("error", { method: prop, args, error: errText(e) });
          throw e;
        }
      };
    },
  });
}

const store = traced(new DbChatStore(db));

// Fake WhatsApp: messages go to the page, and are logged in `messages` as usual.
async function fakeSend(_to: string, msg: Outbound): Promise<string> {
  const id = `dev.out.${crypto.randomUUID()}`;
  emit("whatsapp_out", { id, msg });
  return id;
}

async function devUser(): Promise<User> {
  return await waStore.upsertUser(DEV_WA_ID, "Ihaz (dev)");
}

function send(user: User, msg: Outbound) {
  return deliver(waStore, fakeSend, user, msg);
}

const toolDeps: ToolDeps = { store, send, trace: (event, data) => emit(`decision:${event}`, data) };

// find_business uses real Google Places when GOOGLE_MAPS_API_KEY is set (results are
// saved as businesses; calls stay fake). Without it, it searches the three dev businesses.
const mapsKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
const searchPlaces: SearchPlaces = mapsKey ? placesClient(mapsKey) : searchDevBusinesses;

async function searchDevBusinesses({ text }: { text: string }): Promise<PlaceHit[]> {
  const words = text.toLowerCase().split(/[^a-z0-9&]+/).filter((w) => w.length > 2);
  return DEV_BUSINESSES
    .filter((b) => b.name.toLowerCase().split(/\W+/).some((w) => words.includes(w)))
    .map((b) => ({
      placeId: b.place_id,
      name: b.name,
      address: b.address,
      area: b.address.split(",")[0],
      city: b.city,
      phone: b.phone,
      openingHours: null,
      closed: false,
    }));
}

const callStore = new DbCallStore(db);

// After an approval, production calls dial (reserve_call → Sarvam). The bench shows the
// variables the voice agent would get, marks the call as started, and places nothing.
// Use Simulate to play the call's result back through the real report path.
async function onApproved(_user: User, consent: ConsentStored): Promise<{ started: boolean }> {
  const r = await store.request(consent.request_id);
  const kind = callKind(consent.kind, r.task);
  let variables: unknown;
  try {
    variables = callVariables(kind, await callStore.requestInputs(r.id, consent.option_id), false);
  } catch (e) {
    variables = { error: errText(e) };
  }
  emit("call", {
    note: "Consent stored. Production now calls dial (reserve_call → Sarvam) with these variables. " +
      "No call is placed here; use Simulate to fake the result.",
    consent,
    kind,
    variables,
  });
  return { started: true };
}

const openaiKey = Deno.env.get("OPENAI_API_KEY");
const typesafeKey = Deno.env.get("TYPESAFE_API_KEY");
const lunaDeps: LunaDeps | null = openaiKey
  ? {
    store,
    send,
    create: responsesClient(openaiKey),
    jev: typesafeKey ? jevClient(typesafeKey) : undefined,
    searchPlaces,
    onApproved,
    trace: (event, data) => emit(`decision:${event}`, data),
  }
  : null;

// The same entry as production (wa-inbound): debounce, one turn per user, real commands.
// Only the call is faked: on a consent the bench shows the variables dial would send.
const turnDeps: AgentDeps = {
  store,
  send,
  isAdmin: (waId) => waId === DEV_WA_ID && Deno.env.get("DEV_ADMIN") === "1",
  trace: (event, data) => emit(`decision:${event}`, data),
  luna: async (user, _text, msg) => {
    if (!lunaDeps) {
      return emit("luna", { note: "OPENAI_API_KEY is not set in supabase/functions/.env; Luna is off." });
    }
    await runLuna(lunaDeps, user, msg.at, msg.messageId);
  },
  onCommand: (user, route) =>
    runCommand(
      { store, send, admin: new DbAdminStore(db), trace: (event, data) => emit(`decision:${event}`, data) },
      user,
      route,
    ),
  // The real screenshot check. The bench has no WhatsApp media, so an image reads from
  // raw.dataUrl when the page sends one; the confirm call is shown, not placed.
  onPayment: (user, route, msg) =>
    handleScreenshot(
      {
        store,
        send,
        create: responsesClient(openaiKey ?? ""),
        trace: (event, data) => emit(`decision:${event}`, data),
        image: async (raw) => {
          // deno-lint-ignore no-explicit-any
          const url = (raw as any)?.dataUrl;
          if (typeof url !== "string" || !url.startsWith("data:")) return null;
          const [head, b64] = url.split(",");
          return {
            mime: head.slice(5).split(";")[0],
            bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
          };
        },
        dial: async (a) => {
          const variables = callVariables(a.kind, await callStore.requestInputs(a.requestId, null), false);
          emit("call", {
            note: "Payment passed: production now places the confirm call.",
            args: a,
            variables,
          });
          return { ok: true, call_id: "dev", attempt_id: "dev", flags: [] };
        },
      },
      user,
      msg.raw,
      route.typed,
    ),
};

// The cards Luna would see on this turn (E4 design 1.1).
async function cards(user: User) {
  const now = new Date();
  const info = await store.user(user.id);
  const { request, prompt } = await store.active(user.id);
  const r = request ?? await store.queued(user.id);
  const { data: places } = await db.from("user_places").select("label").eq("user_id", user.id);
  const { data: opts } = r
    ? await db.from("options").select("label, advance_required").eq("request_id", r.id).is("voided_at", null)
    : { data: [] };
  const { data: recent } = await db.from("requests")
    .select("created_at, task, state, end_reason, fields, businesses(name)")
    .eq("user_id", user.id).in("state", ["done", "cancelled", "expired"])
    .order("created_at", { ascending: false }).limit(3);
  return {
    profile: profileCard({
      ...info,
      bookOnFirstCall: await store.limitBool("book_on_first_call", user.id),
      placeLabels: (places ?? []).map((p) => p.label),
    }),
    task: taskCard(
      r
        ? {
          ref: errandRef(r.id),
          task: r.task,
          state: r.state,
          fields: r.fields,
          place: r.businessId ? await store.place(r.businessId) : null,
          hasBooking: !!r.bookingId,
          options: (opts ?? []).map((o) => ({
            label: o.label,
            detail: o.advance_required ? "advance" : null,
          })),
          paused: !!r.pausedAt,
          planSentAt: r.id === request?.id ? prompt?.sentAt ?? null : null,
        }
        : null,
      now,
    ),
    recent: recentCard(
      // deno-lint-ignore no-explicit-any
      (recent ?? []).map((x: any) => ({
        at: new Date(x.created_at),
        task: x.task,
        state: x.state,
        endReason: x.end_reason,
        placeName: x.businesses?.name ?? null,
        fields: x.fields,
      })),
      now,
    ),
    allowed_tools: toolsFor(r?.state ?? null),
  };
}

// Everything stored for the dev user, for the state panel.
async function snapshot(user: User) {
  const { data: requests } = await db.from("requests")
    .select("id, task, state, version, end_reason, fields, business_id, booking_id, created_at, updated_at")
    .eq("user_id", user.id).order("created_at", { ascending: false }).limit(6);
  const ids = (requests ?? []).map((r) => r.id);
  const none = ["00000000-0000-0000-0000-000000000000"];
  const [prompts, consents, options, calls, messages] = await Promise.all([
    db.from("consent_prompts")
      .select(
        "id, request_id, request_version, kind, confirm_word, option_ids, wa_message_id, closed_at, close_reason, text_shown",
      )
      .in("request_id", ids.length ? ids : none).order("sent_at", { ascending: false }).limit(10),
    db.from("consents")
      .select("id, request_id, kind, option_id, request_version, voided_at, void_reason, at")
      .in("request_id", ids.length ? ids : none).order("at", { ascending: false }).limit(10),
    db.from("options")
      .select("id, request_id, label, value, voided_at, void_reason")
      .in("request_id", ids.length ? ids : none).order("created_at", { ascending: false }).limit(10),
    db.from("calls").select("id, request_id, kind, status, created_at")
      .in("request_id", ids.length ? ids : none).order("created_at", { ascending: false }).limit(10),
    db.from("messages").select("direction, wa_message_id, at").eq("user_id", user.id)
      .order("at", { ascending: false }).limit(6),
  ]);
  return {
    requests,
    consent_prompts: prompts.data,
    consents: consents.data,
    options: options.data,
    calls: calls.data,
    messages: messages.data,
  };
}

// Handlers ----------------------------------------------------------------------

async function onMessage(
  body: { text?: string; replyId?: string; title?: string; type?: string; quotedId?: string },
) {
  const user = await devUser();
  const id = `dev.in.${crypto.randomUUID()}`;
  const type = body.replyId ? "interactive" : body.type ?? "text";
  const msg: Inbound = {
    waId: DEV_WA_ID,
    name: "Ihaz (dev)",
    messageId: id,
    at: new Date(),
    type,
    text: body.replyId ? body.title ?? null : body.text ?? null,
    replyId: body.replyId ?? null,
    quotedId: body.quotedId ?? null,
    raw: {
      from: DEV_WA_ID,
      id,
      timestamp: Math.floor(Date.now() / 1000),
      type,
      dev: true,
      ...body,
      // Where Meta puts the id of a quoted message, so history shows what was quoted.
      ...(body.quotedId ? { context: { id: body.quotedId } } : {}),
    },
  };
  emit("whatsapp_in", msg);
  await waStore.saveInbound(user.id, msg);
  await handleInbound(user, msg, turnDeps);
}

async function onTool(body: { tool: string; args?: Record<string, unknown> }) {
  const user = await devUser();
  const a = body.args ?? {};
  emit("tool_call", { as: "Luna (you)", tool: body.tool, args: a });
  let result: unknown;
  switch (body.tool) {
    case "start_new_request":
      result = await startNewRequest(toolDeps, user, a.task as Task);
      break;
    case "set_slots":
      result = await setSlots(toolDeps, user, (a.fields ?? {}) as Record<string, unknown>, {
        add: a.add_questions as string[] | undefined,
      });
      break;
    case "propose_plan": {
      const { request } = await store.active(user.id);
      result = request ? await proposePlan(toolDeps, user, request.id) : { ok: false, reason: "no request" };
      break;
    }
    case "set_business":
      result = await setBusiness(toolDeps, user, a.business_id as string);
      break;
    case "cancel_request":
      result = await cancelActive(toolDeps, user);
      break;
    case "reply":
      // No L3 output check yet (step 4): sent as typed.
      result = { ok: true, wa_message_id: await send(user, { kind: "text", body: String(a.text) }) };
      break;
    default:
      result = { ok: false, reason: "unknown tool" };
  }
  emit("tool_result", { tool: body.tool, result });
}

async function onSimulate(body: { action: string; args?: Record<string, unknown> }) {
  const user = await devUser();
  const a = body.args ?? {};
  emit("simulate", body);
  const { request } = await store.active(user.id);
  const now = new Date();
  switch (body.action) {
    // A finished call, played through the real report path (report.ts → settle_call →
    // WhatsApp). outputs are the voice agent's final_agent_variables (eng plan 3.4).
    case "call_result":
    case "call_1_options":
    case "call_booked": {
      if (!request || !["calling_1", "calling_2", "verifying"].includes(request.state)) {
        return emit(
          "simulate_refused",
          "needs a request in calling_1, calling_2 or verifying (confirm call)",
        );
      }
      const preset: Record<string, unknown> = body.action === "call_1_options"
        ? {
          booking_status: "not_booked",
          no_match_reason: "no_slot",
          options: ((a.times as string[] | undefined) ?? [90, 135]).map((m) => ({
            time: typeof m === "string" ? m : new Date(now.getTime() + Number(m) * 60_000).toISOString(),
          })),
        }
        : body.action === "call_booked"
        ? { booking_status: "booked", booked_time: request.fields.exact_time ?? request.fields.window_start }
        : (a.outputs as Record<string, unknown>) ?? {};
      // Verification reads the transcript: pass args.transcript ([{role, en_text}], role
      // "agent" or "user" for the business) to play a call; call_booked plays a clean one.
      const transcript = (a.transcript as CallResult["transcript"]) ?? (body.action === "call_booked"
        ? [
          { role: "agent", en_text: "Hello, I'm calling on behalf of a customer to book a table." },
          { role: "user", en_text: "Yes, tell me." },
          {
            role: "agent",
            en_text: `So that's a table for ${request.fields.party_size ?? 2} at ${preset.booked_time}, ` +
              `name ${request.fields.customer_name ?? "the customer"}. Is that confirmed?`,
          },
          { role: "user", en_text: "Yes, confirmed. See you then." },
        ]
        : null);
      const kind: CallKind = request.state === "verifying"
        ? "payment_confirm"
        : request.task === "cancel" || request.task === "reschedule"
        ? request.task
        : request.state === "calling_2"
        ? "booking"
        : request.task === "question"
        ? "question"
        : "first";
      const caller = await db.from("caller_numbers").select("id").eq("e164", DEV_CALLER).single();
      // Call 2 books the option the user picked (consent #2).
      const picked = kind === "booking"
        ? (await db.from("consents").select("option_id").eq("request_id", request.id).eq("kind", "book")
          .is("voided_at", null).order("at", { ascending: false }).limit(1).maybeSingle()).data?.option_id ??
          null
        : null;
      const { data: call, error } = await db.from("calls").insert({
        request_id: request.id,
        user_id: user.id,
        business_id: request.businessId,
        caller_number_id: caller.data!.id,
        kind,
        option_id: picked,
        agent_version: "dev",
        status: "in_progress",
      }).select("id").single();
      if (error) throw error;
      const result: CallResult = {
        attemptId: `dev.${call.id}`,
        callId: call.id,
        status: (a.status as CallResult["status"]) ?? "completed",
        durationS: 60,
        interactionId: null,
        failureReason: null,
        outputs: preset,
        transcript,
        agentNumber: DEV_CALLER,
      };
      await callStore.finishCall(result);
      return await reportCall(
        {
          ...toolDeps,
          verify: openaiKey ? verifier(store, responsesClient(openaiKey)) : undefined,
          checkClaim: openaiKey ? claimChecker(store, responsesClient(openaiKey)) : undefined,
        },
        call.id,
        result,
      );
    }
    case "expire": {
      const hours = Number(a.hours ?? 13);
      const at = new Date(now.getTime() + hours * 3_600_000);
      return emit("decision:expire_requests", {
        at,
        expired: await rpc("expire_requests", { p_now: at.toISOString() }),
      });
    }
    // The option hold passing: mark_stale_options as if args.minutes (default 61) went by.
    case "stale": {
      const at = new Date(now.getTime() + Number(a.minutes ?? 61) * 60_000);
      return emit("decision:mark_stale_options", {
        at,
        stale: await rpc("mark_stale_options", { p_now: at.toISOString() }),
      });
    }
    case "reopen": {
      const { data } = await db.from("requests").select("id").eq("user_id", user.id).eq("state", "expired")
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (!data) return emit("simulate_refused", "no expired request");
      return emit("decision:reopen_request", await rpc("reopen_request", { p_request_id: data.id }));
    }
  }
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return data;
}

async function reset() {
  const user = await devUser();
  await db.from("requests").delete().eq("user_id", user.id);
  await db.from("messages").delete().eq("user_id", user.id);
  await db.from("user_turns").delete().eq("user_id", user.id);
  // A new user: no saved city, not stopped, so the first search shows where the place is.
  await db.from("users").update({ city: null, stopped_at: null, delete_requested_at: null }).eq(
    "id",
    user.id,
  );
  history.length = 0;
  emit("reset", { user_id: user.id });
}

async function seed() {
  await db.from("users").upsert({
    wa_id: DEV_WA_ID,
    name: "Ihaz (dev)",
    phone_e164: `+${DEV_WA_ID}`,
    city: null,
  }, {
    onConflict: "wa_id",
  });
  const allDay = {
    periods: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      open: { day: d, hour: 0, minute: 0 },
      close: { day: d, hour: 23, minute: 59 },
    })),
  };
  for (const b of DEV_BUSINESSES) {
    await db.from("businesses").upsert({
      place_id: b.place_id,
      name: b.name,
      address: b.address,
      city: b.city,
      phone_e164: b.phone,
      source: "user",
      opening_hours: allDay,
    }, { onConflict: "place_id" });
  }
  await db.from("caller_numbers").upsert({ e164: DEV_CALLER, provider: "sarvam" }, { onConflict: "e164" });
}

// Server ------------------------------------------------------------------------

await seed();
const page = new URL("./index.html", import.meta.url);

Deno.serve({ port: Number(Deno.env.get("DEV_PORT") ?? 8787) }, async (req) => {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/") {
      return new Response(await Deno.readTextFile(page), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/events") {
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          clients.add(c);
          for (const e of history) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        },
        cancel() {
          clients.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    if (url.pathname === "/api/state") return Response.json(await snapshot(await devUser()));
    // Every event since the last reset, for the eval runner.
    if (url.pathname === "/api/events") return Response.json(history);
    if (url.pathname === "/api/cards") return Response.json(await cards(await devUser()));
    if (url.pathname === "/api/businesses") {
      const { data } = await db.from("businesses").select("id, name, address").like("place_id", "dev/%");
      return Response.json(data);
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (url.pathname === "/api/message") await onMessage(body);
      else if (url.pathname === "/api/tool") await onTool(body);
      else if (url.pathname === "/api/simulate") await onSimulate(body);
      else if (url.pathname === "/api/reset") await reset();
      else return new Response("not found", { status: 404 });
      emit("state", await snapshot(await devUser()));
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  } catch (e) {
    emit("error", { path: url.pathname, error: errText(e) });
    return Response.json({ ok: false, error: errText(e) }, { status: 500 });
  }
});

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// Secrets from supabase/functions/.env (OPENAI_API_KEY, ...), then SUPABASE_URL and the
// service role key from `supabase status`, unless already set.
async function loadLocalEnv() {
  try {
    const text = await Deno.readTextFile(new URL("../supabase/functions/.env", import.meta.url));
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && m[2] && !Deno.env.get(m[1])) Deno.env.set(m[1], m[2].replace(/^"(.*)"$/, "$1"));
    }
  } catch {
    // No .env: Luna stays off.
  }
  if (Deno.env.get("SUPABASE_URL") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return;
  const out = await new Deno.Command("supabase", { args: ["status", "-o", "env"], stderr: "null" }).output();
  const env = Object.fromEntries(
    new TextDecoder().decode(out.stdout).split("\n")
      .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2]]),
  );
  if (!env.API_URL || !env.SERVICE_ROLE_KEY) {
    throw new Error("local Supabase not running: run `supabase start`");
  }
  Deno.env.set("SUPABASE_URL", env.API_URL);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", env.SERVICE_ROLE_KEY);
}
