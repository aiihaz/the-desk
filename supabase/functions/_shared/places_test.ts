import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import { parsePlaces, placesClient, shortAddress, toE164 } from "./places.ts";

const fixture = (name: string) =>
  JSON.parse(Deno.readTextFileSync(new URL(`../../../fixtures/places/${name}.json`, import.meta.url)));

Deno.test("parsePlaces: name, area, city, phone, closed", () => {
  const [mg, indira, noPhone, closed] = parsePlaces(fixture("two_branches"));
  assertEquals(mg, {
    placeId: "test-place-mg-road",
    name: "Navu Bar & Kitchen",
    address: "12 MG Road, Ashok Nagar, Bengaluru",
    area: "Ashok Nagar",
    city: "Bengaluru",
    phone: "+919800000101",
    openingHours: fixture("two_branches").places[0].regularOpeningHours,
    closed: false,
  });
  assertEquals(indira.address, "100 Feet Rd, Indiranagar, Bengaluru, Karnataka 560038");
  assertEquals(
    shortAddress(
      "Indiqube Symphony, Shankarnarayan Building, Old, MG Rd, Craig Park Layout, Ashok Nagar, Bengaluru",
    ),
    "Craig Park Layout, Ashok Nagar, Bengaluru",
  );
  assertEquals(indira.phone, "+918040000102");
  assertEquals(noPhone.phone, null);
  assertEquals(closed.closed, true);
  assertEquals(parsePlaces({}), []);
});

Deno.test("toE164", () => {
  assertEquals(toE164("+91 96869 78053"), "+919686978053");
  assertEquals(toE164("096869 78053"), null);
  assertEquals(toE164(undefined), null);
});

Deno.test("placesClient: India, field mask, errors", async () => {
  let sent: { url: string; init: RequestInit } | null = null;
  const ok = placesClient("k", 1000, async (url, init) => {
    sent = { url: String(url), init: init! };
    return new Response(JSON.stringify(fixture("two_branches")));
  });
  assertEquals((await ok({ text: "Navu, Bengaluru" })).length, 5);
  const headers = sent!.init.headers as Record<string, string>;
  assertEquals(headers["X-Goog-Api-Key"], "k");
  assertEquals(headers["X-Goog-FieldMask"].includes("places.internationalPhoneNumber"), true);
  assertEquals(JSON.parse(String(sent!.init.body)).regionCode, "IN");

  const bad = placesClient(
    "k",
    1000,
    async () => new Response('{"error":{"message":"denied"}}', { status: 403 }),
  );
  await assertRejects(() => bad({ text: "x" }), Error, "places 403");
});
