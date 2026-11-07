import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { User } from "../store.ts";
import { parsePlaces, type PlaceHit } from "../places.ts";
import { findBusiness, type FindDeps, nameFits } from "./find.ts";
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

type Match = { name: string; area: string | null; city: string | null };
const matches = (r: { ok: boolean; [k: string]: unknown }) => (r.matches ?? []) as Match[];

Deno.test("results are facts, not a script: callable places with name, area and city", async () => {
  const { store, queries, deps } = setup();
  const r = await findBusiness(deps, user, { query: "navu", area: null, city: "Bengaluru", byKind: false });
  assertEquals(queries, ["navu, Bengaluru"]);
  // No phone and permanently closed are dropped: they can't be called. Google's guess
  // (Toit) stays, for Luna to weigh against what the user meant.
  assertEquals(matches(r).map((m) => [m.name, m.area]), [
    ["Navu Bar & Kitchen", "Ashok Nagar"],
    ["Navu", "Indiranagar"],
    ["Toit Brewpub", null],
  ]);
  assertEquals(r.searched_in, "Bengaluru");
  assertEquals("next" in r, false);
  assertEquals(store.saved, ["test-place-mg-road", "test-place-indiranagar", "test-place-guess"]);
});

Deno.test("the city is passed as Luna names it; the saved city fills in, and isn't overwritten", async () => {
  const { store, queries, deps } = setup(fixture.slice(1, 2));
  await findBusiness(deps, user, {
    query: "Navu",
    area: "Indiranagar",
    city: "Thiruvananthapuram",
    byKind: false,
  });
  assertEquals(queries, ["Navu, Indiranagar, Thiruvananthapuram"]);
  assertEquals(store.city, "Kozhikode");
  await findBusiness(deps, user, { query: "Navu", area: null, city: null, byKind: false });
  assertEquals(queries[1], "Navu, Kozhikode");
});

Deno.test("no city known: nothing is searched, and a city named for one search isn't saved", async () => {
  const { store, queries, deps } = setup();
  store.city = null;
  const r = await findBusiness(deps, user, { query: "navu", area: null, city: null, byKind: false });
  assertEquals(r.ok, false);
  assertEquals(queries, []);
  await findBusiness(deps, user, { query: "navu", area: null, city: "Bengaluru", byKind: false });
  assertEquals(queries, ["navu, Bengaluru"]);
  assertEquals(store.city, null);
});

Deno.test("search by kind: allowed by the limit, listed unranked; refused when it is off (P12)", async () => {
  const { store, queries, deps } = setup(fixture.slice(0, 2));
  store.limits.place_search_by_kind = true;
  const r = await findBusiness(deps, user, {
    query: "dentist",
    area: "Koramangala",
    city: "Bengaluru",
    byKind: true,
  });
  assertEquals(queries, ["dentist, Koramangala, Bengaluru"]);
  assertEquals(r.by_kind, true);
  store.limits.place_search_by_kind = false;
  const off = await findBusiness(deps, user, { query: "dentist", area: null, city: null, byKind: true });
  assertEquals(off.ok, false);
  assertEquals(queries.length, 1);
});

Deno.test("nothing callable, and a search error", async () => {
  const { deps } = setup(fixture.slice(2, 4));
  const r = await findBusiness(deps, user, { query: "navu", area: null, city: null, byKind: false });
  assertEquals(matches(r), []);
  assertEquals(r.not_callable, "found, but no phone number listed");
  const bad: FindDeps = { ...deps, searchPlaces: () => Promise.reject(new Error("quota")) };
  const e = await findBusiness(bad, user, { query: "navu", area: null, city: null, byKind: false });
  assertEquals(e.ok, false);
});

Deno.test("nameFits", () => {
  assertEquals(nameFits("navu", "Navu Bar & Kitchen"), true);
  assertEquals(nameFits("toni and guy", "Toni&Guy"), true);
  assertEquals(nameFits("paragon", "Hotel Paragon Restaurant"), true);
  assertEquals(nameFits("navu", "Toit Brewpub"), false);
  assertEquals(nameFits("a", "Anything"), false);
});

Deno.test("a match whose number reached someone else before is marked, not hidden (R3)", async () => {
  const { store, deps } = setup();
  store.wrongNumbers.add("b:test-place-indiranagar");
  const r = await findBusiness(deps, user, { query: "navu", area: null, city: "Bengaluru", byKind: false });
  const marked = (r.matches as Record<string, unknown>[]).map((
    m,
  ) => [m.name, "number_reached_someone_else_before" in m]);
  assertEquals(marked, [["Navu Bar & Kitchen", false], ["Navu", true], ["Toit Brewpub", false]]);
});

Deno.test("a search by kind is a short list to choose from; a name search keeps every branch", async () => {
  const hit = (n: number): PlaceHit => ({
    placeId: `p${n}`,
    name: `Place ${n}`,
    address: null,
    area: `Area ${n}`,
    city: "Bengaluru",
    phone: `+9199999999${String(n).padStart(2, "0")}`,
    openingHours: null,
    closed: false,
  });
  const five = [1, 2, 3, 4, 5].map(hit);
  const { store, deps } = setup(five);
  store.limits.place_search_by_kind = true;
  const byKind = await findBusiness(deps, user, {
    query: "restaurant",
    area: "Indiranagar",
    city: null,
    byKind: true,
  });
  assertEquals(matches(byKind).length, 3);
  const byName = await findBusiness(deps, user, { query: "place", area: null, city: null, byKind: false });
  assertEquals(matches(byName).length, 5);
});
