import { assertEquals } from "jsr:@std/assert@1.0.8";
import { type Deps, handle, type JoinResult, toE164 } from "./handler.ts";

function setup(result: JoinResult = { ok: true, new: true }) {
  const joined: { phone: string; handle: string; ipHash: string | null }[] = [];
  const deps: Deps = {
    join: async (phone, handle, ipHash) => {
      joined.push({ phone, handle, ipHash });
      return result;
    },
    hashIp: async (ip) => `hash(${ip})`,
  };
  return { deps, joined };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x/waitlist", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

Deno.test("an Indian number without a country code is stored in E.164, with the hashed IP", async () => {
  const { deps, joined } = setup();
  const res = await handle(
    post({ handle: "  @ihaz ", phone: "98765 43210" }, { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(joined, [{ phone: "+919876543210", handle: "@ihaz", ipHash: "hash(1.2.3.4)" }]);
});

Deno.test("a number already listed gets the same answer as a new one", async () => {
  const { deps } = setup({ ok: true, new: false });
  const res = await handle(post({ handle: "@ihaz", phone: "+919876543210" }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
});

Deno.test("no IP header: joins with no hash", async () => {
  const { deps, joined } = setup();
  await handle(post({ handle: "@ihaz", phone: "+919876543210" }), deps);
  assertEquals(joined[0].ipHash, null);
});

Deno.test("the hidden field filled: thanked, nothing stored", async () => {
  const { deps, joined } = setup();
  const res = await handle(post({ handle: "@bot", phone: "+919876543210", hp: "spam.example" }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(joined, []);
});

Deno.test("rate limited by the database: 429", async () => {
  const { deps } = setup({ ok: false, reason: "rate_limited" });
  const res = await handle(post({ handle: "@ihaz", phone: "+919876543210" }), deps);
  assertEquals(res.status, 429);
  assertEquals(await res.json(), { error: "rate_limited" });
});

Deno.test("bad input is refused before the database", async () => {
  const { deps, joined } = setup();
  const cases: [unknown, number, string][] = [
    ["{not json", 400, "bad_json"],
    [{ phone: "+919876543210" }, 400, "bad_handle"],
    [{ handle: "   ", phone: "+919876543210" }, 400, "bad_handle"],
    [{ handle: "x".repeat(101), phone: "+919876543210" }, 400, "bad_handle"],
    [{ handle: "@ihaz" }, 400, "bad_phone"],
    [{ handle: "@ihaz", phone: "12345" }, 400, "bad_phone"],
    [{ handle: "@ihaz", phone: 9876543210 }, 400, "bad_phone"],
    [{ handle: "@ihaz", phone: "x".repeat(3000) }, 413, "too_large"],
  ];
  for (const [body, status, error] of cases) {
    const res = await handle(post(body), deps);
    assertEquals([res.status, await res.json()], [status, { error }], JSON.stringify(body).slice(0, 40));
  }
  assertEquals(joined, []);
});

Deno.test("preflight and other methods", async () => {
  const { deps } = setup();
  const pre = await handle(new Request("http://x/waitlist", { method: "OPTIONS" }), deps);
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  const get = await handle(new Request("http://x/waitlist"), deps);
  assertEquals(get.status, 405);
});

Deno.test("phone formats", () => {
  assertEquals(toE164("+91 98765 43210"), "+919876543210");
  assertEquals(toE164("098765-43210"), "+919876543210");
  assertEquals(toE164("919876543210"), "+919876543210");
  assertEquals(toE164("(987) 654-3210"), "+919876543210");
  assertEquals(toE164("0091 98765 43210"), "+919876543210");
  assertEquals(toE164("+91 098765 43210"), "+919876543210");
  assertEquals(toE164("0044 20 7946 0958"), null);
  assertEquals(toE164("+1 415 555 0100"), null);
  assertEquals(toE164("+9198765432"), null);
  assertEquals(toE164("+91 98765 4321"), null);
  assertEquals(toE164("+91 98765 432100"), null);
  assertEquals(toE164("5876543210"), null);
  assertEquals(toE164("+0123456789"), null);
  assertEquals(toE164("phone"), null);
});
