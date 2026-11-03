import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { assertTestTarget, benchReadiness, sameOrigin } from "./safety.ts";
import { CallRejected } from "../supabase/functions/_shared/sarvam.ts";

Deno.test("bench permits only the configured consenting test phone", () => {
  assertTestTarget("+919000000001", "+919000000001");
  throws(() => assertTestTarget("+919000000002", "+919000000001"), CallRejected);
  throws(() => assertTestTarget("+919000000001"), CallRejected);
  throws(() => assertTestTarget("9000000001", "9000000001"), CallRejected);
});
Deno.test("phone readiness requires an agent and provider configuration without exposing values", () => {
  const config: Record<string, string> = {
    OPENAI_API_KEY: "secret",
    SARVAM_API_KEY: "secret",
    SARVAM_ORG_ID: "org",
    SARVAM_WORKSPACE_ID: "workspace",
    SARVAM_APP_ID: "app",
    SARVAM_CONNECTION_ID: "connection",
    SARVAM_WEBHOOK_TOKEN: "secret",
    SARVAM_WEBHOOK_URL: "https://example.com/functions/v1/sarvam-webhook",
    DEV_TEST_PHONE: "+919000000001",
  };
  const ready = () => benchReadiness((k) => config[k]);
  equal(ready().phoneReady, true);
  equal(ready().mode, "simulation");
  equal(ready().testPhone, "•••• 0001");
  equal(JSON.stringify(ready()).includes("secret"), false);
  config.SARVAM_WEBHOOK_URL = "http://127.0.0.1/webhook";
  equal(ready().phoneReady, false);
  config.SARVAM_WEBHOOK_URL = "https://example.com/webhook";
  delete config.OPENAI_API_KEY;
  equal(ready().phoneReady, false);
  config.DESK_OPENAI_API_KEY = "secret";
  equal(ready().phoneReady, true);
  delete config.SARVAM_API_KEY;
  equal(ready().phoneReady, false);
  deepStrictEqual(ready().missing, ["SARVAM_API_KEY"]);
});
Deno.test("local bench rejects foreign origins, DNS rebinding and form submissions", () => {
  const request = (url: string, origin?: string, type = "application/json") =>
    new Request(url, {
      method: "POST",
      headers: { "content-type": type, ...(origin ? { origin } : {}) },
      body: "{}",
    });
  equal(sameOrigin(request("http://127.0.0.1:8787/api/message", "http://127.0.0.1:8787")), true);
  equal(sameOrigin(request("http://localhost:8787/api/message")), true);
  equal(sameOrigin(request("http://127.0.0.1:8787/api/message", "https://evil.example")), false);
  equal(sameOrigin(request("http://evil.example:8787/api/message")), false);
  equal(sameOrigin(request("http://localhost:8787/api/message", undefined, "text/plain")), false);
});
