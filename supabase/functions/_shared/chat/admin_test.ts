import { assertEquals } from "jsr:@std/assert@1.0.8";
import { pushAlerts } from "../alerts.ts";
import type { User } from "../store.ts";
import type { Outbound } from "../whatsapp.ts";
import { type AdminStore, type AlertRow, HELP, runAdmin } from "./admin.ts";
import { command } from "./gate.ts";

const alert: AlertRow = {
  id: "ab12cd34-0000-4000-8000-000000000000",
  kind: "booking_unverified",
  at: new Date("2026-10-23T20:05:00+05:30"),
  detail: { problems: ["transcript: unclear (line dropped)"] },
  requestId: "r1",
  callId: "c1",
};

class FakeAdmin implements AdminStore {
  calls: unknown[][] = [];
  alerts: AlertRow[] = [alert];
  limitResult: { ok: boolean; reason?: string } = { ok: true };
  notified: string[] = [];
  async status() {
    return {
      kill_switch: false,
      agent_version: "7",
      credit_rs: 812.5,
      calls_today: { completed: 3, no_answer: 1 },
      bookings_today: 2,
      active_requests: 4,
      open_alerts: 1,
      stopped_users: 0,
    };
  }
  async openAlerts() {
    return this.alerts;
  }
  async resolveAlert(prefix: string, by: string) {
    this.calls.push(["resolve", prefix, by]);
    return prefix === "ab12" ? { ok: true } : { ok: false, reason: "not_found" };
  }
  async setLimit(key: string, value: unknown, by: string, userWaId: string | null) {
    this.calls.push(["setLimit", key, value, by, userWaId]);
    return this.limitResult;
  }
  async limits() {
    return [{ key: "kill_switch", value: false }, { key: "luna_model", value: "gpt-6-luna" }];
  }
  async addCredit(rs: number, by: string) {
    this.calls.push(["credit", rs, by]);
    return 1312.5;
  }
  async optOut(phone: string) {
    this.calls.push(["optout", phone]);
    return true;
  }
  async numbers() {
    return [{ id: "c00000", e164: "+918000000001", active: true, declared: false, calls_today: 3 }];
  }
  async setNumberActive(ref: string, active: boolean) {
    this.calls.push(["number", ref, active]);
    return { ok: true, e164: "+918000000001" };
  }
  async newAlerts() {
    return this.alerts;
  }
  async markNotified(ids: string[]) {
    this.notified.push(...ids);
  }
}

const by = "919800000001";

Deno.test("status: the numbers at a glance", async () => {
  const out = await runAdmin(new FakeAdmin(), "Status", by);
  assertEquals(out.split("\n").slice(0, 4), [
    "Running.",
    "Agent version: 7",
    "Credit: Rs 813",
    "Calls today: completed 3, no_answer 1",
  ]);
  assertEquals(out.includes("Open alerts: 1 (review)"), true);
});

Deno.test("review lists alerts by id prefix; resolve closes one", async () => {
  const a = new FakeAdmin();
  const out = await runAdmin(a, "review", by);
  assertEquals(out.split("\n")[1].startsWith("ab12cd "), true);
  assertEquals(out.includes("booking_unverified: transcript: unclear (line dropped)"), true);
  assertEquals(await runAdmin(a, "resolve AB12", by), "Resolved ab12.");
  assertEquals(await runAdmin(a, "resolve ffff", by), "No open alert ffff.");
  a.alerts = [];
  assertEquals(await runAdmin(a, "review", by), "Nothing to review.");
});

Deno.test("stop all and resume flip the kill switch", async () => {
  const a = new FakeAdmin();
  assertEquals((await runAdmin(a, "stop all", by)).startsWith("Stopped"), true);
  assertEquals((await runAdmin(a, "resume", by)).startsWith("Resumed"), true);
  assertEquals(a.calls, [["setLimit", "kill_switch", true, by, null], [
    "setLimit",
    "kill_switch",
    false,
    by,
    null,
  ]]);
});

Deno.test("credit, optout, numbers", async () => {
  const a = new FakeAdmin();
  assertEquals(await runAdmin(a, "credit Rs 500", by), "Added Rs 500. Balance: Rs 1313.");
  assertEquals(
    await runAdmin(a, "optout +91 98000 00901", by),
    "Opted out +919800000901: no Desk number will call it.",
  );
  assertEquals(await runAdmin(a, "optout 98000", by), "Not a phone number: 98000");
  assertEquals(await runAdmin(a, "numbers", by), "c00000 +918000000001 on (not declared), 3 calls today");
  assertEquals(await runAdmin(a, "number off +918000000001", by), "+918000000001 is off.");
  assertEquals(a.calls.at(-1), ["number", "+918000000001", false]);
});

Deno.test("set limit: JSON values, bare words as text, per-user overrides, refusals passed on", async () => {
  const a = new FakeAdmin();
  assertEquals(
    await runAdmin(a, "set limit max_calls_per_user_per_day 20", by),
    "max_calls_per_user_per_day = 20.",
  );
  assertEquals(await runAdmin(a, "set limit luna_model gpt-6-luna", by), 'luna_model = "gpt-6-luna".');
  assertEquals(
    await runAdmin(a, "set limit max_advance_rs 500 for 919812345678", by),
    "max_advance_rs = 500 for 919812345678.",
  );
  assertEquals(a.calls.at(-1), ["setLimit", "max_advance_rs", 500, by, "919812345678"]);
  a.limitResult = { ok: false, reason: "bad value for retry_delay_minutes (expects int): -5" };
  assertEquals(
    await runAdmin(a, "set limit retry_delay_minutes -5", by),
    "Not changed: bad value for retry_delay_minutes (expects int): -5",
  );
});

Deno.test("anything else gets the list of commands", async () => {
  assertEquals(await runAdmin(new FakeAdmin(), "credit lots", by), HELP);
});

Deno.test("gate: whole admin commands only, so an admin can still talk to the Desk", () => {
  const text = (t: string) => ({
    waId: by,
    name: null,
    messageId: "wamid.in1",
    at: new Date(),
    type: "text",
    text: t,
    replyId: null,
    quotedId: null,
    raw: {},
  });
  for (const t of ["status", "Review", "stop all", "resolve ab12", "number on c00000", "set limit x 1"]) {
    assertEquals(command(text(t), true)?.command, "admin", t);
  }
  for (const t of ["status of my booking?", "reviews of paragon", "numbers for dentists"]) {
    assertEquals(command(text(t), true), null, t);
  }
  assertEquals(command(text("status"), false), null);
});

Deno.test("alerts: sent once any admin gets them; kept new when none can be reached", async () => {
  const a = new FakeAdmin();
  const sent: Outbound[] = [];
  const admin: User = { id: "u1", waId: by, blocked: false };
  const res = await pushAlerts({
    store: a,
    admins: async () => [admin],
    send: async (_u, m) => (sent.push(m), "wamid.1"),
  });
  assertEquals(res, { sent: 1, undelivered: 0 });
  assertEquals(a.notified, [alert.id]);
  assertEquals((sent[0] as { body: string }).body.includes("ab12cd"), true);

  const b = new FakeAdmin();
  const res2 = await pushAlerts({
    store: b,
    admins: async () => [admin],
    send: async () => {
      throw new Error("outside the 24-hour window");
    },
  });
  assertEquals(res2, { sent: 0, undelivered: 1 });
  assertEquals(b.notified, []);
});
