import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { DialArgs } from "../dial.ts";
import type { Outbound } from "../whatsapp.ts";
import { checkScreenshot, handleScreenshot, type PaymentDeps, type Screenshot } from "./payment.ts";
import type { HeldBooking } from "./store.ts";
import { FakeChatStore } from "./test_chat_store.ts";

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
  assertEquals(checkScreenshot(good, held), { problems: [], weak: false });
});

Deno.test("checkScreenshot: each mismatch is said in words", () => {
  const p = (s: Partial<Screenshot>) => checkScreenshot({ ...good, ...s }, held).problems;
  assertEquals(p({ amount_rs: 50 }), ["this shows Rs 50, they asked for Rs 500"]);
  assertEquals(p({ payee_upi: "someone@ybl" }), ["this went to someone@ybl, they gave paragon@okhdfc"]);
  assertEquals(p({ status: "failed" }), ["this payment shows as failed"]);
  assertEquals(p({ paid_at: "2026-10-23T17:00:00+05:30" }), ["this payment is from before they held it"]);
  assertEquals(p({ utr: null }), ["I can't read the UPI reference number"]);
});

Deno.test("checkScreenshot: a QR-only payee matches by name, flagged as weaker", () => {
  const r = checkScreenshot({ ...good, payee_upi: null }, { ...held, upiId: null });
  assertEquals(r, { problems: [], weak: true });
});

function setup(read: Screenshot) {
  const store = new FakeChatStore();
  store.held = held;
  const sent: Outbound[] = [];
  const dials: DialArgs[] = [];
  const deps: PaymentDeps = {
    store,
    send: async (_u, m) => (sent.push(m), "wamid.out"),
    dial: async (a) => (dials.push(a), { ok: true, call_id: "c9", attempt_id: "a9", flags: [] }),
    create: async () => ({
      output: [{ type: "function_call", name: "screenshot", arguments: JSON.stringify(read) }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
    image: async () => ({ mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }),
  };
  const user = { id: "u1", waId: "919812345678", blocked: false };
  return { store, sent, dials, deps, user };
}
const text = (m: Outbound) => (m as { body: string }).body;

Deno.test("a passing screenshot is recorded and the confirm call starts", async () => {
  const { store, sent, dials, deps, user } = setup(good);
  await handleScreenshot(deps, user, {});
  assertEquals(store.payments[0].passed, true);
  assertEquals(text(sent[0]), "Got it: Rs 500 to Paragon@OKHDFC, ref …4321. I'll call Paragon to confirm.");
  assertEquals(dials, [{ requestId: "r1", kind: "payment_confirm", optionId: null, isRetry: false }]);
});

Deno.test("a failing screenshot says what's wrong, and nothing is called", async () => {
  const { store, sent, dials, deps, user } = setup({ ...good, amount_rs: 50 });
  await handleScreenshot(deps, user, {});
  assertEquals(store.payments[0].passed, false);
  assertEquals(
    text(sent[0]),
    "This doesn't match what Paragon asked for: this shows Rs 50, they asked for Rs 500. Nothing is confirmed yet.",
  );
  assertEquals(dials.length, 0);
});

Deno.test("a reused UTR is refused; a typed 'paid' asks for the screenshot", async () => {
  const a = setup(good);
  a.store.paymentResult = { ok: false, reason: "utr_used" };
  await handleScreenshot(a.deps, a.user, {});
  assertEquals(text(a.sent[0]).startsWith("That payment reference was already used"), true);
  assertEquals(a.dials.length, 0);

  const b = setup(good);
  await handleScreenshot(b.deps, b.user, {}, true);
  assertEquals(
    text(b.sent[0]),
    "Thanks. Please send me the payment screenshot here, and I'll call Paragon to confirm it.",
  );
  assertEquals(b.store.payments.length, 0);
});

Deno.test("a payment after the deadline still goes, and the user is told", async () => {
  const { sent, dials, deps, user } = setup({ ...good, paid_at: "2026-10-23T19:45:00+05:30" });
  await handleScreenshot(deps, user, {});
  assertEquals(text(sent[0]).includes("after their 7:30 pm deadline"), true);
  assertEquals(dials.length, 1);
});
