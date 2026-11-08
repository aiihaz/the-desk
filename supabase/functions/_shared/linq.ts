// Linq v3, pinned to the 2026-02-03 webhook shape (official SDK schema).
import { e164ToWaId, waIdToE164 } from "./e164.ts";
import type { Inbound, Outbound } from "./whatsapp.ts";

export type LinqConfig = { token: string; shareContactCard?: boolean; timeoutMs?: number };
const TRANSPORT_TIMEOUT_MS = 15_000;
export const MAX_LINQ_IMAGE_BYTES = 10 * 1024 * 1024;
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
    case "reaction":
      throw new Error("a reaction has no text; send it with sendReaction");
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
  if (msg.kind === "reaction") return sendReaction(cfg, msg, fetcher);
  const value = textContent(msg);
  if (!value.trim()) throw new Error("empty Linq message");
  // Let Linq select the existing healthy line and its iMessage/RCS/SMS service.
  const res = await fetcher("https://api.linqapp.com/api/partner/v3/messages", {
    method: "POST",
    signal: AbortSignal.timeout(cfg.timeoutMs ?? TRANSPORT_TIMEOUT_MS),
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

// iMessage's own tapbacks, by the emoji each shows; any other emoji goes as a custom tapback.
const TAPBACKS: Record<string, string> = {
  "❤️": "love",
  "👍": "like",
  "👎": "dislike",
  "😂": "laugh",
  "‼️": "emphasize",
  "❓": "question",
};

// A tapback on one of their messages (Linq: POST /v3/messages/{id}/reactions). Linq returns
// no message id for it, so the id stored for the Desk's line is its own, marked as a reaction.
async function sendReaction(
  cfg: LinqConfig,
  msg: Extract<Outbound, { kind: "reaction" }>,
  fetcher: typeof fetch,
): Promise<string> {
  if (!msg.messageId || msg.messageId.startsWith("linq-reaction:")) {
    throw new Error("a reaction needs a message of theirs to go on");
  }
  if (!msg.emoji) throw new Error("a reaction needs an emoji");
  const type = TAPBACKS[msg.emoji];
  const res = await fetcher(
    `https://api.linqapp.com/api/partner/v3/messages/${encodeURIComponent(msg.messageId)}/reactions`,
    {
      method: "POST",
      signal: AbortSignal.timeout(cfg.timeoutMs ?? TRANSPORT_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        type ? { operation: "add", type } : { operation: "add", type: "custom", custom_emoji: msg.emoji },
      ),
    },
  );
  if (!res.ok) throw new Error(`linq reaction failed ${res.status}`);
  return `linq-reaction-out:${crypto.randomUUID()}`;
}

// Read receipts and typing are courtesy signals: short timeouts, and a failure is
// only logged, so neither can hold up or fail a reply.
const PRESENCE_TIMEOUT_MS = 3_000;
// One start shows typing for about 85–90s; Linq says to refresh every 60s.
const TYPING_REFRESH_MS = 60_000;

// From a normalized inbound: a message carries its chat, a reaction event names it.
export function linqChatId(raw: unknown): string | null {
  const r = raw as { linq?: { chat?: { id?: unknown } }; linq_event?: Event };
  const id = r?.linq?.chat?.id ?? r?.linq_event?.data?.chat_id;
  return typeof id === "string" && id ? id : null;
}

async function presence(
  cfg: LinqConfig,
  chatId: string,
  path: "read" | "typing",
  method: "POST" | "DELETE",
  fetcher: typeof fetch,
): Promise<void> {
  if (!cfg.token) throw new Error("LINQ_API_TOKEN is not set");
  const res = await fetcher(
    `https://api.linqapp.com/api/partner/v3/chats/${encodeURIComponent(chatId)}/${path}`,
    {
      method,
      signal: AbortSignal.timeout(PRESENCE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${cfg.token}` },
    },
  );
  await res.body?.cancel();
  if (!res.ok) throw new Error(`linq ${path} ${method} failed ${res.status}`);
}

export async function markRead(cfg: LinqConfig, chatId: string, fetcher = fetch): Promise<void> {
  await presence(cfg, chatId, "read", "POST", fetcher).catch((e) => console.warn(String(e?.message ?? e)));
}

export type Typing = {
  // A sent message clears typing on Linq's side; stop refreshing so it doesn't come back.
  sent(): void;
  // Clears it. Awaited before the turn is released, so a replacing turn's start comes after.
  stop(): Promise<void>;
};

// Shows typing until stop(). Calls go out one at a time, so a slow start can't land
// after the stop and leave the indicator up.
export function startTyping(
  cfg: LinqConfig,
  chatId: string,
  fetcher = fetch,
  refreshMs = TYPING_REFRESH_MS,
): Typing {
  let queue = Promise.resolve();
  const call = (method: "POST" | "DELETE") =>
    queue = queue.then(() => presence(cfg, chatId, "typing", method, fetcher))
      .catch((e) => console.warn(String(e?.message ?? e)));
  call("POST");
  const refresh = setInterval(() => call("POST"), refreshMs);
  let stopped: Promise<void> | null = null;
  return {
    sent: () => clearInterval(refresh),
    stop: () => {
      clearInterval(refresh);
      return stopped ??= call("DELETE");
    },
  };
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
  event_id?: string;
  created_at?: string;
  event_type?: string;
  data?: {
    id?: string;
    is_from_me?: boolean;
    reaction_type?: string;
    custom_emoji?: string | null;
    from_handle?: { handle?: string };
    message_id?: string;
    reacted_at?: string;
    chat_id?: string;
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
  const reaction = event?.event_type === "reaction.added" || event?.event_type === "reaction.removed";
  if (event?.event_type !== "message.received" && !reaction) return null;
  if (event.webhook_version !== "2026-02-03") throw new Error("expected webhook version 2026-02-03");
  if (reaction) return parseReaction(event);
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

// Verified against @linqapp/sdk 0.31.0 ReactionEventBase and ReactionAddedWebhookEvent.
// Reaction events have no group flag. Ingestion MUST verify the target belongs to
// this sender's stored direct conversation before accepting the normalized input.
function parseReaction(event: Event): Inbound | null {
  const r = event.data;
  if (!r || r.is_from_me !== false) return null;
  const phone = r.from_handle?.handle;
  if (!phone || !/^\+[1-9]\d{6,14}$/.test(phone)) return null;
  const at = new Date(r.reacted_at ?? event.created_at ?? "");
  if (!event.event_id || !r.message_id || !Number.isFinite(at.getTime())) {
    throw new Error("invalid Linq reaction");
  }
  const tapbacks: Record<string, string> = {
    love: "❤️",
    like: "👍",
    dislike: "👎",
    laugh: "😂",
    emphasize: "‼️",
    question: "❓",
  };
  const emoji = event.event_type === "reaction.removed"
    ? ""
    : r.reaction_type === "custom"
    ? r.custom_emoji
    : tapbacks[r.reaction_type ?? ""];
  if (typeof emoji !== "string") return null; // Stickers cannot convey textual approval.
  return {
    waId: e164ToWaId(phone),
    name: null,
    messageId: `linq-reaction:${event.event_id}`,
    at,
    type: "reaction",
    text: emoji,
    replyId: null,
    quotedId: r.message_id,
    raw: {
      type: "reaction",
      reaction: { emoji, message_id: r.message_id },
      context: { id: r.message_id },
      linq_event: event,
    },
  };
}

// Stored bodies use the normalized shape; recovery must reconstruct a Linq
// message, rather than pass it through Meta's parser.
export function parseStoredLinqMessage(raw: unknown): Inbound | null {
  const storedEvent = (raw as { linq_event?: unknown })?.linq_event;
  if (storedEvent) return parseLinqWebhook(storedEvent);
  const data = (raw as { linq?: unknown })?.linq;
  return data
    ? parseLinqWebhook({
      event_type: "message.received",
      webhook_version: "2026-02-03",
      data,
    })
    : null;
}

export async function downloadLinqImage(
  raw: unknown,
  fetcher: typeof fetch = fetch,
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ mime: string; bytes: Uint8Array } | null> {
  const parts = (raw as { linq?: { parts?: Part[] } })?.linq?.parts;
  const image = parts?.find((p) => p.type === "media" && p.mime_type?.startsWith("image/") && p.url);
  if (!image?.url) return null;
  const url = new URL(image.url);
  if (url.protocol !== "https:") throw new Error("invalid Linq attachment URL");
  // Presigned URL: do not forward the Linq API token to the storage host.
  const signal = AbortSignal.timeout(limits.timeoutMs ?? TRANSPORT_TIMEOUT_MS);
  const res = await fetcher(url, { redirect: "error", signal });
  if (!res.ok) throw new Error(`Linq attachment download failed ${res.status}`);
  const maxBytes = limits.maxBytes ?? MAX_LINQ_IMAGE_BYTES;
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await res.body?.cancel();
    throw new Error("Linq attachment exceeds size limit");
  }
  if (!res.body) throw new Error("empty Linq attachment");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Linq attachment exceeds size limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { mime: image.mime_type!, bytes };
}
