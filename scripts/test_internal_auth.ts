import { strictEqual } from "node:assert/strict";

// Test the actual endpoint entrypoints, without any external service or real credential.
for (const endpoint of ["health", "reconcile", "follow-through", "dial", "wa-send"]) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--allow-env",
      "--allow-net=127.0.0.1,0.0.0.0:8000",
      `supabase/functions/${endpoint}/index.ts`,
    ],
    env: { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "local-auth-test-only" },
    stdout: "null",
    stderr: "piped",
  }).spawn();
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch("http://127.0.0.1:8000", { method: "POST" });
        await response.arrayBuffer();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (!ready) throw new Error(`${endpoint} did not start`);
    for (const token of [null, "public-anon-token", "ordinary-user-token"]) {
      const response = await fetch("http://127.0.0.1:8000", {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      await response.arrayBuffer();
      strictEqual(
        response.status,
        token ? 403 : 401,
        `${endpoint} must reject ${token ?? "missing credentials"}`,
      );
    }
    console.log(`${endpoint}: missing, anon, and user credentials rejected`);
  } finally {
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
    const status = await child.status;
    if (status.signal !== "SIGTERM" && status.code !== 0) {
      throw new Error(`${endpoint} exited unexpectedly (${status.code})`);
    }
    const stderr = await new Response(child.stderr).text();
    if (stderr.includes("error:")) console.error(stderr);
  }
}
