import { deepStrictEqual as assertEquals, rejects as assertRejects } from "node:assert/strict";
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
    state: "Karnataka",
    stateCode: "KA",
    phone: "+919800000101",
    countryCode: "IN",
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
  await assertRejects(
    () => bad({ text: "x" }),
    (e: unknown) => e instanceof Error && e.message.includes("places 403"),
  );
});

Deno.test("live Places lookup excludes foreign and unverifiable countries despite the India hint", async () => {
  const body = fixture("two_branches");
  body.places[0].addressComponents.find((c: { types: string[] }) => c.types.includes("country")).shortText =
    "US";
  body.places[1].addressComponents = [];
  const client = placesClient("fake", 1000, async () => Response.json(body));
  const hits = await client({ text: "a similarly named business" });
  assertEquals(hits.length, 3);
  assertEquals(hits.every((p) => p.countryCode === "IN"), true);
});
