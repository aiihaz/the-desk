export const event = () => ({
  webhook_version: "2026-02-03",
  event_type: "message.received",
  data: {
    id: "inbound-id",
    direction: "inbound",
    chat: { id: "chat-id", is_group: false },
    sender_handle: { handle: "+919876543210", is_me: false },
    parts: [{ type: "text", value: "Book for two" }],
    sent_at: "2026-11-03T12:00:00Z",
    reply_to: { message_id: "plan-id" },
  },
});

export const SECRET = "whsec_" + btoa("test signing secret, not a credential");
export async function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test signing secret, not a credential"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const id = "event-id";
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": "v1," + btoa(String.fromCharCode(...mac)),
  });
}
