import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { PlaceHit } from "./places.ts";
import { indianE164, serperClient, type WebPlace, withWebPhones } from "./serper.ts";

const hit = (over: Partial<PlaceHit>): PlaceHit => ({
  placeId: "p1",
  name: "Hotel Paragon",
  address: "Kannur Rd, Kozhikode",
  area: "Kannur Rd",
  city: "Kozhikode",
  phone: null,
  openingHours: null,
  closed: false,
  ...over,
});

Deno.test("indianE164: the ways local results write Indian numbers", () => {
  assertEquals(indianE164("+91 98470 12345"), "+919847012345");
  assertEquals(indianE164("098470 12345"), "+919847012345");
  assertEquals(indianE164("0495 270 0001"), "+914952700001");
  assertEquals(indianE164("9847012345"), "+919847012345");
  assertEquals(indianE164("12345"), null);
  assertEquals(indianE164(null), null);
});

Deno.test("a place with no phone gets one from the web only when the name fits, marked as such", async () => {
  const asked: string[] = [];
  const web = async (q: string): Promise<WebPlace[]> => {
    asked.push(q);
    return [
      { title: "Paragon Hotel Tours", address: null, phone: "0495 111 1111" },
      { title: "Hotel Paragon", address: "Kannur Rd, Kozhikode", phone: "0495 270 0001" },
    ];
  };
  const search = withWebPhones(async () => [hit({}), hit({ placeId: "p2", phone: "+914952700009" })], web);
  const out = await search({ text: "paragon" });
  assertEquals(asked, ["Hotel Paragon, Kannur Rd, Kozhikode"]);
  assertEquals([out[0].phone, out[0].phoneFromWeb], ["+914952700001", true]);
  assertEquals([out[1].phone, out[1].phoneFromWeb], ["+914952700009", undefined]);
});

Deno.test("no fitting name, a closed place, or a failing lookup: left without a phone", async () => {
  const none = withWebPhones(
    async () => [hit({})],
    async () => [{ title: "Other Place", address: null, phone: "9847012345" }],
  );
  assertEquals((await none({ text: "x" }))[0].phone, null);
  let calls = 0;
  const closed = withWebPhones(async () => [hit({ closed: true })], async () => (calls++, []));
  await closed({ text: "x" });
  assertEquals(calls, 0);
  const failing = withWebPhones(async () => [hit({})], async () => {
    throw new Error("429");
  });
  assertEquals((await failing({ text: "x" }))[0].phone, null);
});

Deno.test("serperClient: India, key header, places parsed", async () => {
  let req: Request | null = null;
  const client = serperClient("k", 1000, async (url, init) => {
    req = new Request(url as string, init);
    return Response.json({ places: [{ title: "Hotel Paragon", phoneNumber: "0495 270 0001" }] });
  });
  const out = await client("Hotel Paragon, Kozhikode");
  assertEquals(req!.headers.get("X-API-KEY"), "k");
  assertEquals(JSON.parse(await req!.text()).gl, "in");
  assertEquals(out, [{ title: "Hotel Paragon", address: null, phone: "0495 270 0001" }]);
});

Deno.test("same chain at another branch is not given the requested place's phone", async () => {
  const search = withWebPhones(async () => [hit({})], async () => [
    { title: "Hotel Paragon", address: "MG Road, Bengaluru", phone: "9847012345" },
    { title: "Hotel Paragon", address: "Kozhikode", phone: "9847012346" },
  ]);
  assertEquals((await search({ text: "paragon" }))[0].phone, null);
});

Deno.test("phone enrichment overlaps two bounded lookups and preserves search order", async () => {
  const releases: (() => void)[] = [];
  const search = withWebPhones(
    async () => [hit({ placeId: "a" }), hit({ placeId: "b" }), hit({ placeId: "c" })],
    async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return [];
    },
  );
  const pending = search({ text: "paragon" });
  await Promise.resolve();
  assertEquals(releases.length, 2);
  for (const release of releases) release();
  assertEquals((await pending).map((p) => p.placeId), ["a", "b", "c"]);
});
