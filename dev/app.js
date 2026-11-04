const $ = (s) => document.querySelector(s);
const thread = $("#chat"), typing = $("#typing");
const trace = [], seen = new Set(), sent = new Map();
let state = {}, quote = null, busy = 0, lastStamp = 0;
const time = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function error(message) {
  $("#error").textContent = message;
  $("#error").hidden = !message;
}
async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Could not load ${path} (${r.status}).`);
  return r.json();
}
async function post(path, body = {}) {
  busy++;
  typing.hidden = false;
  error("");
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? `Request failed (${r.status}).`);
    return true;
  } catch (e) {
    error(e.message);
    return false;
  } finally {
    typing.hidden = --busy === 0;
  }
}
function append(el) {
  $("#welcome")?.remove();
  thread.insertBefore(el, typing);
  thread.scrollTop = thread.scrollHeight;
  return el;
}
function bubble(who, at, text, id) {
  if (new Date(at).getTime() - lastStamp > 300000) {
    append(
      node(
        "div",
        "stamp",
        new Date(at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " · " +
          time(at),
      ),
    );
  }
  lastStamp = new Date(at).getTime();
  const el = node(who === "desk" ? "button" : "div", `bubble ${who}`, text);
  el.title = time(at);
  if (who === "desk") {
    el.type = "button";
    el.title += " · Reply to this message";
    el.onclick = () => {
      quote = id;
      $("#quote").hidden = false;
      $("#quoteText").textContent = text;
      $("#message").focus();
    };
    sent.set(id, text);
  }
  append(el);
}
function choices(message) {
  const rows = message.kind === "buttons" ? message.buttons : message.kind === "list" ? message.rows : [];
  if (!rows?.length) return;
  const wrap = node("div", "actions");
  for (const row of rows) {
    const b = node("button", "", row.title + (row.description ? ` · ${row.description}` : ""));
    b.onclick = () => post("/api/message", { replyId: row.id, title: row.title });
    wrap.append(b);
  }
  append(wrap);
}
function render(s) {
  state = s;
  $("#state").textContent = JSON.stringify(s, null, 2);
  const ready = s.readiness ?? {};
  const live = ready.mode === "live";
  $("#mode").textContent = live ? "Real phone test" : "Local simulation";
  $("#modeDescription").textContent = live
    ? "Only the configured test line can be called."
    : "WhatsApp messages stay in this browser.";
  $("#agentStatus").textContent = ready.agentReady ? "Configured" : "Needs key";
  $("#phoneStatus").textContent = ready.phoneReady ? `Configured ${ready.testPhone}` : "Needs setup";
  $("#readinessLabel").textContent = ready.agentReady ? "Agent configured" : "Setup needed";
  $("#setupHint").textContent = ready.agentReady
    ? (live
      ? "Provider access and caller checks are verified when dialing."
      : "Real agent, simulated phone calls. No WhatsApp messages are sent.")
    : "The interface is connected. Add an OpenAI key to enable natural chat and approval checks.";
  $("#agentHint") &&
    ($("#agentHint").textContent = ready.agentReady
      ? "Local chat · your normal approval workflow"
      : "Agent key needed for chat · test-plan preparation is available");
  $("#missing").textContent = [
    ...(ready.missing ?? []),
    ...(!ready.publicWebhook ? ["A public HTTPS webhook that writes to this database"] : []),
  ].join(", ") || "Provider configuration is present. Check agent/README.md for caller contract setup.";
  for (const button of document.querySelectorAll("[data-draft]")) {
    if (live) {
      button.dataset.draft = button.dataset.draft.includes("table")
        ? "Please prepare a table for two tomorrow at the Consenting test line. This is a phone workflow test."
        : "Please ask the Consenting test line what time they close today. This is a phone workflow test.";
    }
  }
  $("#simulationControls").hidden = live;
  $("#phoneControls").hidden = !live;
  $("#refreshPhone").disabled = !ready.phoneReady;
  const r = s.requests?.[0];
  const labels = {
    collecting: "Getting the details",
    choosing_place: "Choosing a place",
    confirming: "Review the plan",
    awaiting_yes: "Waiting for approval",
    calling_1: "Call in progress",
    calling_2: "Call in progress",
    verifying: "Verifying",
    options_ready: "Options to review",
    awaiting_pick: "Choose an option",
    done: "Completed",
    expired: "Expired",
    closed: "Finished",
    paused: "Paused",
  };
  $("#errandStatus").textContent = labels[r?.state] ??
    (r ? r.state.replaceAll("_", " ") : "Ready when you are");
  $("#errandTitle").textContent = r
    ? ({
      booking: "A table, without the phone tag.",
      question: "A quick question, taken care of.",
      cancel: "A cancellation to confirm.",
      reschedule: "A new time to arrange.",
    }[r.task] ?? r.task)
    : "It starts with a message.";
  $("#errandFields").replaceChildren();
  for (const [key, value] of Object.entries(r?.fields ?? {})) {
    if (["may_book", "tolerance_min", "place_query"].includes(key) || value == null) continue;
    const display = /_time$|window_start|window_end/.test(key) && typeof value === "string"
      ? new Date(value).toLocaleString()
      : Array.isArray(value)
      ? value.join(" · ")
      : String(value);
    $("#errandFields").append(node("div", "", key.replaceAll("_", " ") + ": " + display));
  }
  const step = !r
    ? 0
    : ["collecting", "choosing_place"].includes(r.state)
    ? 0
    : ["confirming", "awaiting_yes"].includes(r.state)
    ? 1
    : ["calling_1", "calling_2", "verifying"].includes(r.state)
    ? 2
    : 3;
  $("#timeline").querySelectorAll("li").forEach((el, i) =>
    el.className = r ? (i < step ? "done" : i === step ? "current" : "") : ""
  );
  const memories = (s.memories ?? []).filter((m) => !m.forgotten_at);
  $("#memories").replaceChildren(
    ...(memories.length
      ? memories.map((m) => node("p", "", m.text))
      : [node("p", "", "Explicit preferences and corrections will appear here.")]),
  );
  $("#recent").replaceChildren(
    ...(s.requests?.slice(1).map((r) => node("p", "", r.task + " · " + (labels[r.state] ?? r.state))) ?? []),
  );
  if (!s.requests?.slice(1).length) $("#recent").textContent = "No past errands yet.";
  const calling = ["calling_1", "calling_2", "verifying"].includes(r?.state);
  document.querySelectorAll("[data-sim^='call_']").forEach((b) => b.disabled = !calling);
  $("#prepareBooking").disabled = !!r && !["done", "closed", "expired", "cancelled"].includes(r.state);
  $("#prepareQuestion").disabled = $("#prepareBooking").disabled;
}
function event(e) {
  const key = e.id ?? JSON.stringify(e);
  if (seen.has(key)) return;
  seen.add(key);
  if (e.type === "state") return render(e.data);
  if (e.type === "reset") {
    for (const el of [...thread.children]) if (el !== typing) el.remove();
    $("#events").replaceChildren();
    trace.length = 0;
    sent.clear();
    lastStamp = 0;
    clearQuote();
  }
  trace.push(e);
  if (trace.length > 500) trace.shift();
  if (e.type === "whatsapp_in") bubble("you", e.at, e.data.text ?? `[${e.data.type}]`);
  if (e.type === "whatsapp_out") {
    bubble("desk", e.at, e.data.msg.body ?? "", e.data.id);
    choices(e.data.msg);
  }
  if (e.type === "call") {
    append(node(
      "div",
      "note",
      e.data.mode === "live"
        ? "Calling your configured test line…"
        : "Approval recorded. Simulated call started — play a result from the workflow panel.",
    ));
  }
  if (["error", "simulate_refused"].includes(e.type)) {
    error(typeof e.data === "string" ? e.data : e.data.error ?? "The action could not complete.");
  }
  if (e.type === "decision:settle_call" && !state.readiness?.agentReady) {
    append(
      node(
        "div",
        "note",
        "Call facts were processed. An agent key is needed to write and verify the user-facing report.",
      ),
    );
  }
  if (e.type === "phone_result" && e.data.transcript) {
    const details = node("details", "transcript");
    details.append(node("summary", "", "Call transcript"));
    for (const line of e.data.transcript) {
      details.append(node("p", "", `${line.role === "agent" ? "Desk" : "Test line"}: ${line.en_text}`));
    }
    append(details);
  }
  const detail = node("details", `event ${e.type === "db_read" ? "read-event" : ""}`);
  const summary = node("summary");
  summary.append(
    node("time", "", time(e.at)),
    node("strong", "", e.type.replaceAll("_", " ")),
    node("span", "", String(e.data?.note ?? e.data?.method ?? e.data?.error ?? "")),
  );
  detail.append(summary, node("pre", "", JSON.stringify(e.data, null, 2)));
  $("#events").append(detail);
  if ($("#events").childElementCount > 500) $("#events").firstChild.remove();
}
const source = new EventSource("/events");
source.onopen = () => {
  $("#connection").textContent = "Connected locally";
  $(".sidebar-footer .status-dot").classList.add("connected");
  get("/api/state").then(render).catch((e) => error(e.message));
};
source.onerror = () => {
  $("#connection").textContent = "Reconnecting…";
  $(".sidebar-footer .status-dot").classList.remove("connected");
};
source.onmessage = (m) => {
  try {
    event(JSON.parse(m.data));
  } catch (e) {
    error(`Could not render an update: ${e.message}`);
  }
};
function clearQuote() {
  quote = null;
  $("#quote").hidden = true;
}
$("#unquote").onclick = clearQuote;
$("#message").oninput = () => {
  $("#send").disabled = !$("#message").value.trim();
  $("#message").style.height = "32px";
  $("#message").style.height = Math.min(130, $("#message").scrollHeight) + "px";
};
$("#message").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#compose").requestSubmit();
  }
};
$("#compose").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#message").value.trim();
  if (!text) return;
  const quotedId = quote;
  $("#message").value = "";
  $("#message").dispatchEvent(new Event("input"));
  clearQuote();
  // Inbound is saved before processing. Do not offer a blind resend after failure.
  await post("/api/message", { text, ...(quotedId ? { quotedId } : {}) });
};
$("#image").onchange = async () => {
  const file = $("#image").files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return error("Choose an image smaller than 5 MB.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    return error("Choose a JPG, PNG or WebP screenshot.");
  }
  if (!state.readiness?.agentReady) return error("An agent key is needed to check payment screenshots.");
  const reader = new FileReader();
  reader.onload = () => post("/api/message", { type: "image", dataUrl: reader.result });
  reader.readAsDataURL(file);
  $("#image").value = "";
};
for (const b of document.querySelectorAll("[data-draft]")) {
  b.onclick = () => {
    $("#message").value = b.dataset.draft;
    $("#message").dispatchEvent(new Event("input"));
    $("#message").focus();
  };
}
for (const b of document.querySelectorAll("[data-sim]")) {
  b.onclick = () => post("/api/simulate", { action: b.dataset.sim });
}
$("#prepareBooking").onclick = () =>
  post("/api/prepare", { task: "booking", businessId: $("#business").value });
$("#prepareQuestion").onclick = () =>
  post("/api/prepare", { task: "question", businessId: $("#business").value });
$("#refreshPhone").onclick = () => post("/api/phone/refresh");
$("#reset").onclick = () => {
  if (confirm("Clear this local test conversation, errands and memories?")) post("/api/reset");
};
$("#diagnosticsBtn").onclick = () => $("#inspector").showModal();
$("#closeInspector").onclick = () => $("#inspector").close();
$("#showReads").onchange = (e) => $("#events").classList.toggle("show-reads", e.target.checked);
$("#detailsBtn").onclick = () => {
  const open = $("#details").classList.toggle("open");
  $("#detailsBtn").setAttribute("aria-expanded", String(open));
};
$("#chatNav").onclick = () => $("#message").focus();
$("#export").onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" }));
  const a = node("a");
  a.href = url;
  a.download = "desk-local-trace.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
get("/api/businesses").then((bs) => {
  $("#business").replaceChildren(...bs.map((b) => {
    const option = node("option", "", b.name + " · " + b.address);
    option.value = b.id;
    return option;
  }));
}).catch((e) => error(e.message));
// Poll only in real phone mode. This never submits or retries a call.
let polling = false;
setInterval(async () => {
  if (
    polling || document.hidden || state.readiness?.mode !== "live" || !state.readiness?.phoneReady ||
    !["calling_1", "calling_2", "verifying"].includes(state.requests?.[0]?.state)
  ) return;
  polling = true;
  try {
    await post("/api/phone/refresh");
  } finally {
    polling = false;
  }
}, 15000);
