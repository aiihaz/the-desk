import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { User } from "../store.ts";
import { parsePlaces, type PlaceHit } from "../places.ts";
import { findBusiness, type FindDeps, nameFits, sameCity } from "./find.ts";
import { FakeChatStore } from "./test_chat_store.ts";

const user: User = { id: "u1", waId: "919812345678", blocked: false };
const fixture = parsePlaces(
  JSON.parse(
    Deno.readTextFileSync(new URL("../../../../fixtures/places/two_branches.json", import.meta.url)),
  ),
);

function setup(hits: PlaceHit[] = fixture) {
  const store = new FakeChatStore();
  const queries: string[] = [];
  const deps: FindDeps = {
    store,
    send: async () => "wamid.x",
    searchPlaces: async ({ text }) => {
      queries.push(text);
      return hits;
    },
  };
  return { store, queries, deps };
}

Deno.test("two branches: both shown by area, no phone, closed and guesses dropped", async () => {
  const { store, queries, deps } = setup();
  const r = await findBusiness(deps, user, { name: "navu", area: null, city: "Bangalore" });
  assertEquals(queries, ["navu, Bangalore"]);
  assertEquals(r.ok && (r.matches as { area: string | null }[]).map((m) => m.area), [
    "Ashok Nagar",
    "Indiranagar",
  ]);
  assertEquals(r.ok && String(r.next).startsWith("more than one place"), true);
  assertEquals(store.saved, ["test-place-mg-road", "test-place-indiranagar"]);
});

Deno.test("the saved city is used, and a named city doesn't overwrite it", async () => {
  const { store, queries, deps } = setup(fixture.slice(1, 2));
  const r = await findBusiness(deps, user, { name: "Navu", area: "Indiranagar", city: "Bengaluru" });
  assertEquals(queries, ["Navu, Indiranagar, Bengaluru"]);
  assertEquals(store.city, "Kozhikode");
  assertEquals(r.ok && r.next, "one match: choose_business");

  await findBusiness(deps, user, { name: "Navu", area: null, city: null });
  assertEquals(queries[1], "Navu, Kozhikode");
});

Deno.test("no city known: all of India, the results say where; the first city named is saved", async () => {
  const { store, queries, deps } = setup();
  store.city = null;
  const r = await findBusiness(deps, user, { name: "navu", area: null, city: null });
  assertEquals(queries, ["navu"]);
  assertEquals(
    r.ok && r.next,
    "more than one place: ask which one in a short line, telling them apart by area and saying they are in Bengaluru, then choose_business",
  );
  await findBusiness(deps, user, { name: "navu", area: null, city: "Bengaluru" });
  assertEquals(store.city, "Bengaluru");
});

Deno.test("no city, one match: ask; with the area they picked: choose", async () => {
  const { store, deps } = setup(fixture.slice(1, 2));
  store.city = null;
  const r = await findBusiness(deps, user, { name: "navu", area: null, city: null });
  assertEquals(String(r.ok && r.next).startsWith("one match, in Bengaluru"), true);
  const picked = await findBusiness(deps, user, { name: "navu", area: "Indiranagar", city: null });
  assertEquals(picked.ok && picked.next, "one match: choose_business");
});

Deno.test("saved city with branches only elsewhere: say so first", async () => {
  const { queries, deps } = setup();
  const r = await findBusiness(deps, user, { name: "navu", area: null, city: null });
  assertEquals(queries, ["navu, Kozhikode"]);
  assertEquals(String(r.ok && r.next).startsWith("none in Kozhikode; these are in Bengaluru."), true);
});

Deno.test("one match with a different name is checked with the user", async () => {
  const { deps } = setup(fixture.slice(4));
  const r = await findBusiness(deps, user, { name: "navu", area: null, city: null });
  assertEquals(
    r.ok && r.next,
    "one match, but the name is not what they typed: ask if that's the place before choose_business",
  );
});

Deno.test("nothing callable, and a search error", async () => {
  const { deps } = setup(fixture.slice(2, 4));
  const r = await findBusiness(deps, user, { name: "navu", area: null, city: null });
  assertEquals(r.ok && (r.matches as unknown[]).length, 0);
  assertEquals(r.ok && String(r.next).includes("no phone number"), true);

  deps.searchPlaces = async () => {
    throw new Error("places 500");
  };
  const e = await findBusiness(deps, user, { name: "navu", area: null, city: null });
  assertEquals(e.ok, false);
});

Deno.test("a match in another city is checked; the saved city copied back isn't 'named'", async () => {
  const { store, queries, deps } = setup(fixture.slice(0, 1));
  store.city = "Calicut";
  const r = await findBusiness(deps, user, { name: "navu", area: null, city: "Kozhikode" });
  assertEquals(queries, ["navu, Calicut"]);
  assertEquals(String(r.ok && r.next).startsWith("none in Calicut; it is in Bengaluru."), true);
  assertEquals(sameCity("Bangalore", "Bengaluru"), true);
  assertEquals(sameCity("New  Delhi", "Delhi"), true);
  assertEquals(sameCity("Kochi", "Kozhikode"), false);
});

Deno.test("nameFits", () => {
  assertEquals(nameFits("navu", "Navu Bar & Kitchen"), true);
  assertEquals(nameFits("toni and guy", "Toni&Guy"), true);
  assertEquals(nameFits("paragon", "Hotel Paragon Restaurant"), true);
  assertEquals(nameFits("navu", "Toit Brewpub"), false);
  assertEquals(nameFits("a", "Anything"), false);
});
