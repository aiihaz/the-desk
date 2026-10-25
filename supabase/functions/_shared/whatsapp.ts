// Meta WhatsApp Cloud API: webhook signature, inbound parsing, outbound payloads.
// Pure functions except send(); the edge functions wire them to the database.

export type Inbound = {
  waId: string;
  name: string | null;
  messageId: string;
  at: Date;
  type: string;
  // Text body, or the title of the tapped button / list row.
  text: string | null;
  // id of the tapped button / list row (our option ids), else null.
  replyId: string | null;
  // id of the message this one quotes (a WhatsApp reply), else null.
  quotedId: string | null;
  raw: unknown;
};

export type StatusUpdate = {
  messageId: string;
  status: string;
  waId: string;
  at: Date;
};

export type Outbound =
  | { kind: "text"; body: string }
  | { kind: "buttons"; body: string; buttons: { id: string; title: string }[] }
  | {
    kind: "list";
    body: string;
    button: string;
    rows: { id: string; title: string; description?: string }[];
  }
  | { kind: "template"; name: string; language: string; params?: string[] };

const encoder = new TextEncoder();

// X-Hub-Signature-256: "sha256=<hex HMAC of the raw body with the app secret>".
export async function verifySignature(
  rawBody: Uint8Array<ArrayBuffer>,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const given = hexToBytes(header.slice("sha256=".length));
  if (!given) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  return timingSafeEqual(expected, given);
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// deno-lint-ignore no-explicit-any
type Json = any;

export function parseWebhook(payload: Json): { messages: Inbound[]; statuses: StatusUpdate[] } {
  const messages: Inbound[] = [];
  const statuses: StatusUpdate[] = [];
  if (payload?.object !== "whatsapp_business_account") return { messages, statuses };

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c.wa_id) names.set(c.wa_id, c.profile?.name ?? null);
      }
      for (const m of value.messages ?? []) {
        if (!m.id || !m.from) continue;
        const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
        messages.push({
          waId: m.from,
          name: names.get(m.from) ?? null,
          messageId: m.id,
          at: new Date(Number(m.timestamp) * 1000),
          type: m.type,
          text: m.text?.body ?? reply?.title ?? m.button?.text ?? null,
          replyId: reply?.id ?? m.button?.payload ?? null,
          quotedId: m.context?.id ?? null,
          raw: m,
        });
      }
      for (const s of value.statuses ?? []) {
        statuses.push({
          messageId: s.id,
          status: s.status,
          waId: s.recipient_id,
          at: new Date(Number(s.timestamp) * 1000),
        });
      }
    }
  }
  return { messages, statuses };
}

// Meta limits: body 1024 chars for interactive (4096 for text), up to 3 buttons with
// 20-char titles, up to 10 list rows with 24-char titles, row and button ids up to 256.
export function buildPayload(to: string, msg: Outbound): Json {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (msg.kind) {
    case "text":
      check(msg.body.length > 0 && msg.body.length <= 4096, "text body must be 1-4096 chars");
      return { ...base, type: "text", text: { body: msg.body, preview_url: false } };
    case "buttons":
      check(msg.body.length > 0 && msg.body.length <= 1024, "button body must be 1-1024 chars");
      check(msg.buttons.length >= 1 && msg.buttons.length <= 3, "1-3 buttons");
      for (const b of msg.buttons) {
        check(b.title.length >= 1 && b.title.length <= 20, `button title too long: ${b.title}`);
        check(b.id.length >= 1 && b.id.length <= 256, "button id must be 1-256 chars");
      }
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: msg.body },
          action: {
            buttons: msg.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
          },
        },
      };
    case "list":
      check(msg.body.length > 0 && msg.body.length <= 1024, "list body must be 1-1024 chars");
      check(msg.button.length >= 1 && msg.button.length <= 20, "list button must be 1-20 chars");
      check(msg.rows.length >= 1 && msg.rows.length <= 10, "1-10 list rows");
      for (const r of msg.rows) {
        check(r.title.length >= 1 && r.title.length <= 24, `row title too long: ${r.title}`);
        check((r.description ?? "").length <= 72, "row description over 72 chars");
      }
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: msg.body },
          action: { button: msg.button, sections: [{ title: "Options", rows: msg.rows }] },
        },
      };
    case "template":
      return {
        ...base,
        type: "template",
        template: {
          name: msg.name,
          language: { code: msg.language },
          components: msg.params?.length
            ? [{
              type: "body",
              parameters: msg.params.map((text) => ({ type: "text", text })),
            }]
            : [],
        },
      };
  }
}

function check(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`whatsapp: ${message}`);
}

// Free-form messages are allowed only within 24 hours of the user's last message;
// outside it Meta accepts templates only.
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function needsTemplate(lastInboundAt: Date | null, now: Date): boolean {
  return !lastInboundAt || now.getTime() - lastInboundAt.getTime() >= SERVICE_WINDOW_MS;
}

export type WaConfig = { token: string; phoneNumberId: string; graphVersion: string };

export function waConfigFromEnv(): WaConfig {
  return {
    token: Deno.env.get("WA_ACCESS_TOKEN") ?? "",
    phoneNumberId: Deno.env.get("WA_PHONE_NUMBER_ID") ?? "",
    graphVersion: Deno.env.get("WA_GRAPH_VERSION") ?? "v23.0",
  };
}

// Returns Meta's message id (wamid...).
export async function send(cfg: WaConfig, to: string, msg: Outbound): Promise<string> {
  const res = await fetch(
    `https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(to, msg)),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`whatsapp send failed ${res.status}: ${JSON.stringify(body?.error ?? body)}`);
  }
  return body.messages?.[0]?.id;
}
