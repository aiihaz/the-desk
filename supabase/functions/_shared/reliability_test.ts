import { setFollowUp } from "./chat/tools.ts";
import { callAfterConsent } from "./chat/calls.ts";
import { runLuna } from "./chat/luna.ts";
import { deepStrictEqual as equal, ok, rejects } from "node:assert/strict";
import { authorizeInternal } from "./internal_auth.ts";
import { handle as inbound } from "../wa-inbound/handler.ts";
import { sign } from "./test_sign.ts";
import { dial } from "./dial.ts";
import { CallRejected } from "./sarvam.ts";
import { FakeCallStore } from "./test_call_store.ts";
import { FakeChatStore } from "./chat/test_chat_store.ts";
import { fakeWriter, say } from "./chat/test_writer.ts";
import { approvePlan } from "./chat/approval.ts";
import { reportCall } from "./chat/report.ts";
import { drainDeliveries, followUpFacts } from "./chat/followup.ts";
import { deliver, OutsideServiceWindow } from "./deliver.ts";
import { type Store, type User } from "./store.ts";
import type { Inbound } from "./whatsapp.ts";
import { parseWebhook } from "./whatsapp.ts";
import { handleInbound } from "./chat/agent.ts";

const user: User = { id: "u1", waId: "919800000001", blocked: false };
const now = new Date("2026-11-03T12:00:00+05:30");
const args = { requestId: "r1", kind: "first" as const, optionId: null, isRetry: false };

Deno.test("internal authorization rejects missing, anon and user credentials", () => {
  equal(authorizeInternal(new Request("http://local"), "service")?.status, 401);
  for (const key of ["anon", "user", "service-extra"]) {
    equal(
      authorizeInternal(
        new Request("http://local", { headers: { authorization: `Bearer ${key}` } }),
        "service",
      )?.status,
      403,
    );
  }
  equal(
    authorizeInternal(
      new Request("http://local", { headers: { authorization: "Bearer service" } }),
      "service",
    ),
    null,
  );
  equal(
    authorizeInternal(new Request("http://local", { headers: { authorization: "Bearer service" } }), "")
      ?.status,
    401,
  );
});

Deno.test("Meta redelivery completes ingestion after a partial database failure", async () => {
  const body = await Deno.readTextFile("fixtures/whatsapp/text.json");
  let recorded = false;
  let failed = false;
  let handoffs = 0;
  const pending: Promise<unknown>[] = [];
  const store: Store = {
    saveEvent: async () => {
      const fresh = !recorded;
      recorded = true;
      return fresh;
    },
    upsertUser: async () => {
      if (!failed) {
        failed = true;
        throw new Error("transient");
      }
      return user;
    },
    saveInbound: async () => true,
    lastInboundAt: async () => now,
    saveOutbound: async () => {},
  };
  const deps = {
    store,
    appSecret: "test",
    verifyToken: "test",
    background: (p: Promise<unknown>) => {
      pending.push(p);
    },
    handOff: async () => {
      handoffs++;
    },
  };
  const request = async () =>
    new Request("http://local", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": await sign(body, "test") },
    });
  // Run the actual signed ingestion failure, then the same event a second time.
  await rejects(async () => inbound(await request(), deps));
  equal((await inbound(await request(), deps)).status, 200);
  await Promise.all(pending);
  equal(handoffs, 1);
});

Deno.test("a provider-accepted call survives failure to persist its attempt ID", async () => {
  const store = new FakeCallStore();
  store.markDialing = async () => {
    throw new Error("database unavailable");
  };
  let submissions = 0;
  const result = await dial({
    store,
    start: async () => {
      submissions++;
      return "accepted";
    },
  }, args);
  equal(result.ok, false);
  if (!result.ok) equal(result.error, "submission_unknown");
  equal(store.calls.get("c-1")?.status, "queued");
  equal(store.calls.get("c-1")?.providerCallId, "accepted");
  equal(submissions, 1);
});

Deno.test("transport failure is uncertain; definite rejection is failed", async () => {
  for (
    const [error, expected] of [[new Error("connection lost"), "submission_unknown"], [
      new CallRejected("400"),
      "dial_failed",
    ]] as const
  ) {
    const store = new FakeCallStore();
    const result = await dial({
      store,
      start: async () => {
        throw error;
      },
    }, args);
    ok(!result.ok);
    equal(result.error, expected);
    equal(store.calls.get("c-1")?.status, expected === "dial_failed" ? "failed" : "queued");
  }
});

Deno.test("successful calling still returns the provider attempt", async () => {
  const store = new FakeCallStore();
  const result = await dial({ store, start: async () => "accepted" }, args);
  ok(result.ok);
  equal(result.attempt_id, "accepted");
  equal(store.calls.get("c-1")?.status, "dialing");
});

function reportingStore() {
  const store = new FakeChatStore();
  store.call = {
    callId: "c1",
    requestId: "r1",
    userId: "u1",
    waId: user.waId,
    kind: "question",
    task: "question",
    businessId: "b1",
    phone: "+919800000901",
    option: null,
    isRetry: false,
    bookingTime: null,
  };
  store.req = {
    id: "r1",
    task: "question",
    state: "calling_1",
    version: 1,
    fields: {},
    businessId: "b1",
    bookingId: null,
    createdAt: now,
    pausedAt: null,
  };
  return store;
}

Deno.test("a correction arriving during the approval checker prevents dispatch", async () => {
  const store = reportingStore();
  store.req!.state = "awaiting_yes";
  store.prompt = {
    id: "p1",
    kind: "ask",
    optionIds: [],
    confirmWord: "yes",
    waMessageId: "plan",
    sentAt: now,
    text: "Call them?",
    message: { kind: "text", body: "Call them?" },
  };
  store.lines = [{ id: "plan", from: "desk", text: "Call them?", at: now }, {
    id: "yes",
    from: "user",
    text: "yes",
    at: now,
  }];
  let starts = 0;
  const result = await approvePlan(
    {
      store,
      create: async () => {
        store.unhandled = true;
        return say("verdict", { decision: "yes", message: 1, why: "agreed" });
      },
      onApproved: async () => {
        starts++;
        return { started: true };
      },
    },
    user,
    null,
    "yes",
  );
  equal(result.ok, false);
  equal(starts, 0);
  equal(store.consents.length, 0);
});

Deno.test("an unintended commitment reaches the user's durable facts", async () => {
  const store = reportingStore();
  await reportCall({ store, create: fakeWriter, send: async () => "out", now: () => now }, "c1", {
    attemptId: "a1",
    callId: "c1",
    status: "completed",
    durationS: 30,
    interactionId: null,
    failureReason: null,
    transcript: null,
    agentNumber: null,
    outputs: {
      outcome: "question_answered",
      answer: "We open at ten",
      possible_unintended_commitment: "yes",
      unintended_commitment_details: "Reserved a table without permission",
    },
  });
  equal(
    store.reports[0].facts.happened.possible_unintended_commitment,
    "Reserved a table without permission",
  );
  equal(store.reports[0].facts.happened.commitment_is_not_authorized, true);
});

Deno.test("closed windows defer updates without sending templates or failing them", async () => {
  const store = reportingStore();
  // Exercise a ready delivery directly, with an explicit expired-window result.
  store.deliveries.push({
    id: "deferred",
    userId: user.id,
    waId: user.waId,
    message: { kind: "text", body: "Update" },
    attempts: 0,
    kind: "report",
    status: "pending",
  });
  let attempts = 0;
  const result = await drainDeliveries({
    store,
    send: async (_u, message) => {
      attempts++;
      equal(message.kind, "text");
      throw new OutsideServiceWindow();
    },
  });
  equal(result.failed, 0);
  ok(result.retrying >= 1);
  ok(attempts >= 1);
  equal(store.deliveries.find((d) => d.id === "deferred")?.status, "pending");
});

Deno.test("the shared send path never sends paid templates", async () => {
  let sent = 0;
  const store: Store = {
    saveEvent: async () => true,
    upsertUser: async () => user,
    saveInbound: async () => true,
    lastInboundAt: async () => now,
    saveOutbound: async () => {},
  };
  await rejects(() =>
    deliver(
      store,
      async () => {
        sent++;
        return "out";
      },
      user,
      { kind: "template", name: "paid", language: "en" },
      now,
    )
  );
  equal(sent, 0);
});

Deno.test("recovery reconstructs the same inbound message from its stored body", async () => {
  const fixture = JSON.parse(await Deno.readTextFile("fixtures/whatsapp/text.json"));
  const original = parseWebhook(fixture).messages[0];
  const recovered = parseWebhook({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { messages: [original.raw] } }] }],
  }).messages[0];
  equal([recovered.messageId, recovered.waId, recovered.text], [
    original.messageId,
    original.waId,
    original.text,
  ]);
});

Deno.test("a failed fenced turn remains incomplete and is abandoned for retry", async () => {
  const store = reportingStore();
  const log: string[] = [];
  const bound = Object.assign(reportingStore(), {
    renewTurn: async () => {},
    assertTurn: async () => {},
    completeTurn: async () => {
      log.push("complete");
    },
    abandonTurn: async () => {
      log.push("abandon");
    },
  });
  const root = Object.assign(store, { forTurn: () => bound });
  root.claims = [{ status: "claimed", token: "generation", batch: ["hello"] }];
  const msg: Inbound = {
    waId: user.waId,
    name: null,
    messageId: "m1",
    at: now,
    type: "text",
    text: "hello",
    replyId: null,
    quotedId: null,
    raw: {},
  };
  await rejects(() =>
    handleInbound(user, msg, {
      store: root,
      send: async () => "out",
      isAdmin: () => false,
      luna: async () => {
        throw new Error("crash");
      },
      onCommand: async () => {},
      onPayment: async () => {},
      sleep: async () => {},
    })
  );
  equal(log, ["abandon"]);
});

Deno.test("a window update describes unfinished work without claiming an action", () => {
  const facts = followUpFacts({
    requestId: "r1",
    userId: user.id,
    reason: "window",
    task: "question",
    state: "collecting",
    stamp: 1,
    fields: {},
    waitingFor: "the shop name",
    endReason: null,
    place: null,
    amountRs: null,
    deadline: null,
  });
  equal(facts.happened.status, "unfinished_errand_service_window_closing");
  equal(facts.happened.waiting_for, "the shop name");
});

Deno.test("uncertain submission is never described as nothing happened or ended", async () => {
  const store = reportingStore();
  await callAfterConsent(
    {
      store,
      create: fakeWriter,
      send: async () => "out",
      now: () => now,
      dial: async () => ({ ok: false, error: "submission_unknown", call_id: "c1", detail: "uncertain" }),
    },
    user,
    { ok: true, consent_id: "k1", kind: "ask", request_id: "r1", option_id: null },
  );
  equal(store.req!.state, "calling_1");
  equal(
    store.deliveries[0].facts?.happened.status,
    "call_submission_uncertain_may_have_started_do_not_retry",
  );
});
Deno.test("a model response cannot send after losing its turn generation", async () => {
  const store = Object.assign(reportingStore(), {
    assertTurn: async () => {
      throw new Error("turn lease lost");
    },
  });
  let sent = 0;
  await rejects(() =>
    runLuna(
      {
        store,
        create: async () => say("reply", { text: "Calling now" }),
        send: async () => {
          sent++;
          return "out";
        },
        searchPlaces: async () => [],
        onApproved: async () => ({ started: true }),
      },
      user,
      now,
    )
  );
  equal(sent, 0);
});
Deno.test("a reminder outside the current WhatsApp window is refused", async () => {
  const store = Object.assign(reportingStore(), {
    serviceWindowEnds: async () => new Date(now.getTime() + 3_600_000),
  });
  const result = await setFollowUp({ store, send: async () => "out", now: () => now }, user, {
    waitingFor: "the user's decision",
    remindAt: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
    errand: null,
  });
  equal(result.ok, false);
  equal(store.followUps.length, 0);
});
