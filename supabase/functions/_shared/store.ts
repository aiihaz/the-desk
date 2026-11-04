// Database access for the WhatsApp functions. The interface lets tests use a fake.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { waIdToE164 } from "./e164.ts";
import type { Inbound, Outbound } from "./whatsapp.ts";

export type MessagingChannel = "whatsapp" | "linq";
export type User = { id: string; waId: string; blocked: boolean; channel?: MessagingChannel };

// Keep existing WhatsApp keys and unique constraints intact. Linq identities get
// a separate user UUID even when the same phone uses both channels.
export function identityKey(phoneDigits: string, channel: MessagingChannel): string {
  waIdToE164(phoneDigits);
  return channel === "linq" ? `linq:${phoneDigits}` : phoneDigits;
}

export function storedUser(row: {
  id: string;
  wa_id: string;
  blocked: boolean;
  phone_e164: string | null;
  channel: string;
}): User {
  if (row.channel !== "whatsapp" && row.channel !== "linq") throw new Error("unknown messaging channel");
  return {
    id: row.id,
    waId: row.channel === "linq" ? (row.phone_e164 ?? "").slice(1) : row.wa_id,
    blocked: row.blocked,
    channel: row.channel,
  };
}

export interface Store {
  // false if this exact webhook body was already stored (Meta redelivery).
  saveEvent(externalId: string, payload: unknown): Promise<boolean>;
  completeEvent?(externalId: string): Promise<void>;
  inboundPending?(messageId: string): Promise<boolean>;
  upsertUser(waId: string, name: string | null): Promise<User>;
  // false if the message id was already stored.
  saveInbound(userId: string, msg: Inbound): Promise<boolean>;
  lastInboundAt(userId: string): Promise<Date | null>;
  saveOutbound(userId: string, waMessageId: string, msg: Outbound): Promise<void>;
  // Resolve by UUID, including for delayed reports whose legacy wa_id is namespaced.
  deliveryTarget?(userId: string): Promise<User>;
  claimLinqContactShare?(userId: string, chatId: string): Promise<string | null>;
  finishLinqContactShare?(chatId: string, claim: string, shared: boolean): Promise<void>;
}

export function serviceClient(turnToken?: string): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      auth: { persistSession: false },
      global: {
        headers: turnToken ? { "x-desk-turn": turnToken } : {},
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
              : AbortSignal.timeout(10_000),
          }),
      },
    },
  );
}

export class DbStore implements Store {
  constructor(private db: SupabaseClient = serviceClient(), private source: "meta" | "linq" = "meta") {}

  async saveEvent(externalId: string, payload: unknown): Promise<boolean> {
    const { data, error } = await this.db.from("webhook_events")
      .upsert({ source: this.source, external_id: externalId, payload }, {
        onConflict: "source,external_id",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) throw error;
    return data.length > 0;
  }

  async completeEvent(externalId: string): Promise<void> {
    const { error } = await this.db.from("webhook_events").update({ ingested_at: new Date().toISOString() })
      .eq("source", this.source).eq("external_id", externalId);
    if (error) throw error;
  }
  async pendingEvents() {
    const { data, error } = await this.db.from("webhook_events").select("external_id,payload")
      .eq("source", this.source).is("ingested_at", null).order("received_at").limit(20);
    if (error) throw error;
    return data;
  }

  async upsertUser(waId: string, name: string | null): Promise<User> {
    const channel = this.source === "linq" ? "linq" : "whatsapp";
    const key = identityKey(waId, channel);
    // Never overwrite a stored name: the user may have told the Desk a different one.
    const { error } = await this.db.from("users")
      .upsert({ wa_id: key, name, phone_e164: waIdToE164(waId), channel }, {
        onConflict: "wa_id",
        ignoreDuplicates: true,
      });
    if (error) throw error;
    const { data, error: e2 } = await this.db.from("users")
      .select("id, wa_id, blocked, phone_e164, channel").eq("wa_id", key).single();
    if (e2) throw e2;
    return storedUser(data);
  }

  async deliveryTarget(userId: string): Promise<User> {
    const { data, error } = await this.db.from("users")
      .select("id, wa_id, blocked, phone_e164, channel").eq("id", userId).single();
    if (error) throw error;
    return storedUser(data);
  }

  async claimLinqContactShare(userId: string, chatId: string): Promise<string | null> {
    const { data, error } = await this.db.rpc("claim_linq_contact_share", {
      p_user_id: userId,
      p_chat_id: chatId,
    });
    if (error) throw error;
    return data;
  }

  async finishLinqContactShare(chatId: string, claim: string, shared: boolean): Promise<void> {
    const { error } = await this.db.rpc("finish_linq_contact_share", {
      p_chat_id: chatId,
      p_claim: claim,
      p_shared: shared,
    });
    if (error) throw error;
  }

  async saveInbound(userId: string, msg: Inbound): Promise<boolean> {
    const { data, error } = await this.db.rpc("ingest_inbound", {
      p_user_id: userId,
      p_message_id: msg.messageId,
      p_body: msg.raw,
      p_at: msg.at.toISOString(),
    });
    if (error) throw error;
    return data === true;
  }

  async inboundPending(messageId: string): Promise<boolean> {
    const { data, error } = await this.db.from("messages").select("id")
      .eq("wa_message_id", messageId).is("handled_at", null).maybeSingle();
    if (error) throw error;
    return !!data;
  }

  async pendingInbound() {
    const { data, error } = await this.db.rpc("pending_inbound");
    if (error) throw error;
    return data as {
      user_id: string;
      wa_id: string;
      blocked: boolean;
      channel: MessagingChannel;
      body: unknown;
    }[];
  }

  async lastInboundAt(userId: string): Promise<Date | null> {
    const { data, error } = await this.db.from("messages")
      .select("at").eq("user_id", userId).eq("direction", "in")
      .order("at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? new Date(data.at) : null;
  }

  async saveOutbound(userId: string, waMessageId: string, msg: Outbound): Promise<void> {
    const { error } = await this.db.from("messages")
      .insert({ user_id: userId, wa_message_id: waMessageId, direction: "out", body: msg });
    if (error) throw error;
  }
}
