import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { DialArgs } from "../dial.ts";
import type { Outbound } from "../whatsapp.ts";
import { bindHold, checkScreenshot, handleScreenshot, type PaymentDeps, type Screenshot } from "./payment.ts";
import type { HeldBooking } from "./store.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { fakeWriter, say } from "./test_writer.ts";

const held: HeldBooking = {
  bookingId: "bk1",
  requestId: "r1",
  businessId: "b1",
  amountRs: 500,
  upiId: "paragon@okhdfc",
  payeeName: "Paragon Restaurant",
  deadline: new Date("2026-10-23T19:30:00+05:30"),
  heldAt: new Date("2026-10-23T18:00:00+05:30"),
  time: new Date("2026-10-23T20:15:00+05:30"),
};

const good: Screenshot = {
  status: "success",
  amount_rs: 500,
  payee_upi: "Paragon@OKHDFC",
  payee_name: "PARAGON RESTAURANT",
  utr: "432112344321",
  paid_at: "2026-10-23T18:42:00+05:30",
};

Deno.test("checkScreenshot: the right amount, payee and time passes", () => {
  assertEquals(checkScreenshot(good, held), { problems: [], weak: false, forOther: false });
});

Deno.test("checkScreenshot: each mismatch is said plainly", () => {
  const p = (s: Partial<Screenshot>) => checkScreenshot({ ...good, ...s }, held).problems;
  assertEquals(p({ amount_rs: 50 }), ["it shows Rs 50; they asked for Rs 500"]);
  assertEquals(p({ payee_upi: "someone@ybl" }), ["it went to someone@ybl; they gave paragon@okhdfc"]);
  assertEquals(p({ status: "failed" }), ["the payment shows as failed"]);
  assertEquals(p({ paid_at: "2026-10-23T17:00:00+05:30" }), [
    "this payment is from before they asked for it",
  ]);
  assertEquals(p({ utr: null }), ["can't read the UPI reference number"]);
});

Deno.test("checkScreenshot: a name-only match, or nothing to match, passes but is flagged", () => {
  const name = checkScreenshot({ ...good, payee_upi: null }, { ...held, upiId: null });
  assertEquals(name, { problems: [], weak: true, forOther: false });
  const nothing = checkScreenshot(good, { ...held, upiId: null, payeeName: null });
  assertEquals(nothing, { problems: [], weak: true, forOther: false });
});

function setup(read: Screenshot) {
  const store = new FakeChatStore();
  store.holds = [held];
  const sent: Outbound[] = [];
  const dials: DialArgs[] = [];
  const chat: string[] = [];
  const deps: PaymentDeps = {
    store,
    send: async (_u, m) => (sent.push(m), "wamid.out"),
    dial: async (a) => (dials.push(a), { ok: true, call_id: "c9", attempt_id: "a9", flags: [] }),
    create: async (req) => req.tools[0].name === "screenshot" ? say("screenshot", read) : fakeWriter(req),
    image: async () => ({ mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }),
    notAPayment: async (u) => {
      chat.push(u.id);
    },
  };
  const user = { id: "u1", waId: "919812345678", blocked: false };
  return { store, sent, dials, deps, user, chat };
}
const told = (store: FakeChatStore) => store.owedFacts[0].facts;

Deno.test("a passing screenshot is recorded, the confirm call starts, and they're told", async () => {
  const { store, sent, dials, deps, user } = setup(good);
  await handleScreenshot(deps, user, {}, "m1");
  assertEquals(store.payments[0].passed, true);
  assertEquals(dials, [{ requestId: "r1", kind: "payment_confirm", optionId: null, isRetry: false }]);
  assertEquals(told(store).happened.status, "payment_matches_calling_them_now_to_tell_them_it_is_done");
  assertEquals(told(store).values, { paid: "Rs 500", payee: "Paragon@OKHDFC", reference: "…4321" });
  assertEquals(sent.length, 1);
});

Deno.test("a failing screenshot says what's wrong, and nothing is called", async () => {
  const { store, dials, deps, user } = setup({ ...good, amount_rs: 50 });
  await handleScreenshot(deps, user, {}, "m1");
  assertEquals(store.payments[0].passed, false);
  assertEquals(told(store).happened.problems, ["it shows Rs 50; they asked for Rs 500"]);
  assertEquals(dials.length, 0);
});

Deno.test("a reused UTR is refused", async () => {
  const a = setup(good);
  a.store.paymentResult = { ok: false, reason: "utr_used" };
  await handleScreenshot(a.deps, a.user, {}, "m1");
  assertEquals(told(a.store).happened.status, "this_payment_reference_was_already_used_nothing_done");
  assertEquals(a.dials.length, 0);
});

Deno.test("a photo that isn't a payment goes to the conversation, and nothing is recorded", async () => {
  const { store, dials, deps, user, chat } = setup({ ...good, status: "not_a_payment" });
  await handleScreenshot(deps, user, {}, "m1");
  assertEquals([chat, store.payments, dials], [["u1"], [], []]);
});

Deno.test("a payment after the deadline still goes, and the user is told", async () => {
  const { store, dials, deps, user } = setup({ ...good, paid_at: "2026-10-23T19:45:00+05:30" });
  await handleScreenshot(deps, user, {}, "m1");
  assertEquals(told(store).happened.paid_after_their_deadline_will_ask_if_it_still_stands, true);
  assertEquals(told(store).values.deadline, "Fri 23 Oct 2026, 7:30 pm");
  assertEquals(dials.length, 1);
});

Deno.test("a confirm call that can't start leaves the payment waiting, and they're told", async () => {
  const { store, deps, user } = setup(good);
  deps.dial = async () => ({ ok: false, error: "refused", reason: "business_closed" });
  await handleScreenshot(deps, user, {}, "m1");
  assertEquals(store.notStarted, ["r1"]);
  assertEquals(told(store).happened.status, "payment_matches_but_could_not_call_them_not_confirmed_yet");
});

const second: HeldBooking = {
  ...held,
  bookingId: "bk2",
  requestId: "r2",
  businessId: "b2",
  amountRs: 300,
  upiId: "salon@okaxis",
  payeeName: "Salon",
};

Deno.test("two open: the payment binds to the one it fits, not the newest", async () => {
  const { store, deps, user } = setup(good);
  // The newest first, as heldBookings returns them.
  store.holds = [second, held];
  assertEquals((await bindHold(deps, user, good, store.holds, null))?.bookingId, "bk1");
  await handleScreenshot(deps, user, {}, "m1");
  assertEquals(store.payments[0].passed, true);
});

Deno.test("two it fits equally: their words decide, and otherwise they're asked", async () => {
  const { store, dials, deps, user } = setup(good);
  const twin = { ...held, bookingId: "bk3", requestId: "r3" };
  store.holds = [twin, held];
  await handleScreenshot(deps, user, {}, "m1");
  assertEquals(told(store).happened.status, "cannot_tell_which_payment_this_is_for");
  assertEquals(told(store).next_step, "pick_which_payment");
  assertEquals([store.payments, dials], [[], []]);

  deps.create = async () => say("verdict", { decision: "yes", message: 1, why: "2" });
  const bound = await bindHold(deps, user, good, store.holds, "this is for the second one");
  assertEquals(bound?.bookingId, "bk1");
});

Deno.test("no open advance: an image is just an image", async () => {
  const { store, deps, user, chat } = setup(good);
  store.holds = [];
  await handleScreenshot(deps, user, {}, "m1");
  assertEquals(chat, ["u1"]);
});
