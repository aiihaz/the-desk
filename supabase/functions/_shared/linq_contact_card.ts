import type { Sender } from "./deliver.ts";
import { type LinqConfig, type LinqSentMessage, send } from "./linq.ts";
import type { Store } from "./store.ts";

const BASE = "https://api.linqapp.com/api/partner/v3";

// Called only after a text was accepted by Linq, so the first outbound remains
// plain text. The card is iMessage's native Name and Photo Sharing, not a file.
export async function shareContactCardAfterReply(
  store: Store,
  userId: string,
  cfg: LinqConfig,
  sent: LinqSentMessage,
  fetcher = fetch,
): Promise<void> {
  if (!cfg.shareContactCard || sent.service !== "iMessage" || !sent.chatId || !sent.from) return;
  if (!store.claimLinqContactShare || !store.finishLinqContactShare) return;
  let claim: string | null = null;
  let shared = false;
  try {
    claim = await store.claimLinqContactShare(userId, sent.chatId);
    if (!claim) return;
    const headers = { Authorization: `Bearer ${cfg.token}` };
    const query = new URLSearchParams({ phone_number: sent.from });
    const cards = await fetcher(`${BASE}/contact_card?${query}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await cards.json();
    if (!cards.ok) throw new Error(`contact card lookup ${cards.status}`);
    const active = body?.contact_cards?.some((card: { phone_number?: string; is_active?: boolean }) =>
      card.phone_number === sent.from && card.is_active === true
    );
    if (!active) return;
    const result = await fetcher(`${BASE}/chats/${encodeURIComponent(sent.chatId)}/share_contact_card`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    // Consume the response even for a 204 (there is no message/file to log).
    await result.arrayBuffer();
    if (!result.ok) throw new Error(`contact card share ${result.status}`);
    shared = true;
  } catch {
    console.warn("Linq contact card unavailable; text delivery remains successful");
  } finally {
    if (claim) {
      await store.finishLinqContactShare(sent.chatId, claim, shared).catch(() => {
        console.warn("Linq contact card cooldown could not be saved");
      });
    }
  }
}

export function linqSender(store: Store, userId: string, cfg: LinqConfig, fetcher = fetch): Sender {
  return (to, msg) =>
    send(cfg, to, msg, fetcher, (sent) => shareContactCardAfterReply(store, userId, cfg, sent, fetcher));
}
