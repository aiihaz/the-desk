import { assert, assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1.0.8";
import { buildPayload, needsTemplate, parseWebhook, verifySignature } from "./whatsapp.ts";
import { e164ToWaId, waIdToE164 } from "./e164.ts";
import { sign } from "./test_sign.ts";

const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`../../../fixtures/whatsapp/${name}.json`, import.meta.url));

Deno.test("signature: valid, tampered, wrong secret, malformed", async () => {
  const body = fixture("text");
  const bytes = new TextEncoder().encode(body);
  const header = await sign(body, "s3cret");
  assert(await verifySignature(bytes, header, "s3cret"));
  assertFalse(await verifySignature(new TextEncoder().encode(body + " "), header, "s3cret"));
  assertFalse(await verifySignature(bytes, header, "other"));
  assertFalse(await verifySignature(bytes, null, "s3cret"));
  assertFalse(await verifySignature(bytes, "sha256=zz", "s3cret"));
  assertFalse(await verifySignature(bytes, header.replace("sha256=", "sha1="), "s3cret"));
  assertFalse(await verifySignature(bytes, header, ""), "empty secret never verifies");
});

Deno.test("parse: text message with profile name", () => {
  const { messages, statuses } = parseWebhook(JSON.parse(fixture("text")));
  assertEquals(statuses, []);
  assertEquals(messages.length, 1);
  const m = messages[0];
  assertEquals([m.waId, m.name, m.messageId, m.type], ["919800000001", "Ihaz", "wamid.TEXT1", "text"]);
  assertEquals(m.text, "Book a table for 4 at Paragon tonight around 8");
  assertEquals(m.replyId, null);
  assertEquals(m.at.toISOString(), "2026-10-23T13:00:00.000Z");
});

Deno.test("parse: button and list replies carry our ids", () => {
  const b = parseWebhook(JSON.parse(fixture("button_reply"))).messages[0];
  assertEquals([b.text, b.replyId], ["9:30 pm", "opt:e0000000-0000-0000-0000-000000000001"]);
  const l = parseWebhook(JSON.parse(fixture("list_reply"))).messages[0];
  assertEquals([l.text, l.replyId], ["Paragon, Kannur Rd", "place:places/paragon"]);
});

Deno.test("parse: delivery status, and non-WhatsApp payloads are ignored", () => {
  const { messages, statuses } = parseWebhook(JSON.parse(fixture("status")));
  assertEquals(messages, []);
  assertEquals(statuses[0].status, "delivered");
  assertEquals(parseWebhook({ object: "page", entry: [] }), { messages: [], statuses: [] });
  assertEquals(parseWebhook(null), { messages: [], statuses: [] });
});

Deno.test("payloads: Meta's limits are enforced before sending", () => {
  const ok = buildPayload("919800000001", {
    kind: "buttons",
    body: "Paragon can do 9:30 pm or 9:45 pm for 4.",
    buttons: [{ id: "opt:1", title: "9:30 pm" }, { id: "opt:2", title: "9:45 pm" }],
  });
  assertEquals(ok.interactive.action.buttons[1].reply, { id: "opt:2", title: "9:45 pm" });
  assertThrows(() =>
    buildPayload("x", {
      kind: "buttons",
      body: "b",
      buttons: [1, 2, 3, 4].map((i) => ({ id: `${i}`, title: `${i}` })),
    })
  );
  assertThrows(() =>
    buildPayload("x", { kind: "buttons", body: "b", buttons: [{ id: "1", title: "x".repeat(21) }] })
  );
  assertThrows(() => buildPayload("x", { kind: "text", body: "" }));
  assertThrows(() =>
    buildPayload("x", { kind: "list", body: "b", button: "Pick", rows: [{ id: "1", title: "x".repeat(25) }] })
  );
  const t = buildPayload("x", { kind: "template", name: "desk_report", language: "en", params: ["Booked"] });
  assertEquals(t.template.components[0].parameters, [{ type: "text", text: "Booked" }]);
});

Deno.test("24-hour window", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  assertFalse(needsTemplate(new Date("2026-10-22T12:00:01Z"), now));
  assert(needsTemplate(new Date("2026-10-22T12:00:00Z"), now));
  assert(needsTemplate(null, now));
});

Deno.test("e164", () => {
  assertEquals(waIdToE164("919800000001"), "+919800000001");
  assertEquals(e164ToWaId("+919800000001"), "919800000001");
  assertThrows(() => waIdToE164("+919800000001"));
  assertThrows(() => waIdToE164("0123"));
});
