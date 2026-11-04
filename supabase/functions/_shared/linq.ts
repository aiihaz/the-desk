// Linq v3, pinned to the 2026-02-03 webhook shape (official SDK schema).
import { e164ToWaId, waIdToE164 } from "./e164.ts";
import type { Inbound, Outbound } from "./whatsapp.ts";

export type LinqConfig = { token: string; shareContactCard?: boolean };
export const linqConfigFromEnv = (): LinqConfig => ({
  token: Deno.env.get("LINQ_API_TOKEN") ?? "",
  shareContactCard: Deno.env.get("LINQ_SHARE_CONTACT_CARD") === "1",
});

export type LinqSentMessage = {
  messageId: string;
  chatId: string | null;
  from: string | null;
  service: string | null;
};

export function textContent(msg: Outbound): string {
  switch (msg.kind) {
    case "text":
      return msg.body;
    case "buttons":
      return [msg.body, ...msg.buttons.map((b) => b.title)].join("\n");
    case "list":
      return [msg.body, ...msg.rows.map((r) => `${r.title}${r.description ? ` — ${r.description}` : ""}`)]
        .join("\n");
    case "template":
      throw new Error("Linq does not support WhatsApp templates; send the original text");
  }
}

export async function send(
  cfg: LinqConfig,
  to: string,
  msg: Outbound,
  fetcher = fetch,
  afterSend?: (sent: LinqSentMessage) => Promise<void>,
): Promise<string> {
  if (!cfg.token) throw new Error("LINQ_API_TOKEN is not set");
  const value = textContent(msg);
  if (!value.trim()) throw new Error("empty Linq message");
  // Let Linq select the existing healthy line and its iMessage/RCS/SMS service.
  const res = await fetcher("https://api.linqapp.com/api/partner/v3/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: [waIdToE164(to)], message: { parts: [{ type: "text", value }] } }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`linq send failed ${res.status}`);
  if (typeof body?.message?.id !== "string") throw new Error("Linq response missing message.id");
  if (afterSend) {
    try {
      await afterSend({
        messageId: body.message.id,
        chatId: typeof body.chat_id === "string" ? body.chat_id : null,
        from: typeof body.from === "string" ? body.from : null,
        service: body.service ?? body.message.service ?? null,
      });
    } catch {
      // Identity sharing must never turn an accepted text into a failed delivery
      // that reconciliation retries, sending the same text again.
      console.warn("Linq post-send identity sharing failed");
    }
  }
  return body.message.id;
}

export async function verifyLinqSignature(
  body: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!secret || !id || !timestamp || !/^\d+$/.test(timestamp) || !signatures) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    for (const signature of signatures.split(" ")) {
      if (!signature.startsWith("v1,")) continue;
      const bytes = Uint8Array.from(atob(signature.slice(3)), (c) => c.charCodeAt(0));
      if (
        await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(`${id}.${timestamp}.${body}`))
      ) return true;
    }
  } catch {
    return false;
  }
  return false;
}

type Part = { type: string; value?: string; mime_type?: string; url?: string };
type Event = {
  webhook_version?: string;
  event_type?: string;
  data?: {
    id?: string;
    direction?: string;
    chat?: { is_group?: boolean };
    sender_handle?: { handle?: string; is_me?: boolean };
    parts?: Part[];
    sent_at?: string;
    reply_to?: { message_id?: string };
  };
};

export function parseLinqWebhook(payload: unknown): Inbound | null {
  const event = payload as Event;
  if (event?.event_type !== "message.received") return null;
  if (event.webhook_version !== "2026-02-03") throw new Error("expected webhook version 2026-02-03");
  const m = event.data;
  if (!m || m.direction !== "inbound" || m.sender_handle?.is_me || m.chat?.is_group !== false) return null;
  // Desk requires a phone number for its calling workflow. Email handles are unsupported.
  const phone = m.sender_handle?.handle;
  if (!phone || !/^\+[1-9]\d{6,14}$/.test(phone)) return null;
  const at = new Date(m.sent_at ?? "");
  if (!m.id || !Array.isArray(m.parts) || !Number.isFinite(at.getTime())) {
    throw new Error("invalid Linq message");
  }
  const text = m.parts.filter((p) => p.type === "text" && typeof p.value === "string").map((p) => p.value)
    .join("\n");
  const image = m.parts.find((p) => p.type === "media" && p.mime_type?.startsWith("image/") && p.url);
  const type = image ? "image" : text ? "text" : "unknown";
  // Normalized storage keeps conversation history, quoted replies, and consent ordering intact.
  const raw = { type, text: { body: text }, context: { id: m.reply_to?.message_id }, linq: m };
  return {
    waId: e164ToWaId(phone),
    name: null,
    messageId: m.id,
    at,
    type,
    text: text || null,
    replyId: null,
    quotedId: m.reply_to?.message_id ?? null,
    raw,
  };
}

// Stored bodies use the normalized shape; recovery must reconstruct a Linq
// message, rather than pass it through Meta's parser.
export function parseStoredLinqMessage(raw: unknown): Inbound | null {
  const data = (raw as { linq?: unknown })?.linq;
  return data
    ? parseLinqWebhook({
      event_type: "message.received",
      webhook_version: "2026-02-03",
      data,
    })
    : null;
}

export async function downloadLinqImage(raw: unknown): Promise<{ mime: string; bytes: Uint8Array } | null> {
  const parts = (raw as { linq?: { parts?: Part[] } })?.linq?.parts;
  const image = parts?.find((p) => p.type === "media" && p.mime_type?.startsWith("image/") && p.url);
  if (!image?.url) return null;
  const url = new URL(image.url);
  if (url.protocol !== "https:") throw new Error("invalid Linq attachment URL");
  // Presigned URL: do not forward the Linq API token to the storage host.
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) throw new Error(`Linq attachment download failed ${res.status}`);
  return { mime: image.mime_type!, bytes: new Uint8Array(await res.arrayBuffer()) };
}
