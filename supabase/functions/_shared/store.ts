// Database access for the WhatsApp functions. The interface lets tests use a fake.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { waIdToE164 } from "./e164.ts";
import type { Inbound, Outbound } from "./whatsapp.ts";

export type User = { id: string; waId: string; blocked: boolean };

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
  constructor(private db: SupabaseClient = serviceClient()) {}

  async saveEvent(externalId: string, payload: unknown): Promise<boolean> {
    const { data, error } = await this.db.from("webhook_events")
      .upsert({ source: "meta", external_id: externalId, payload }, {
        onConflict: "source,external_id",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) throw error;
    return data.length > 0;
  }

  async completeEvent(externalId: string): Promise<void> {
    const { error } = await this.db.from("webhook_events").update({ ingested_at: new Date().toISOString() })
      .eq("source", "meta").eq("external_id", externalId);
    if (error) throw error;
  }
  async pendingEvents() {
    const { data, error } = await this.db.from("webhook_events").select("external_id,payload")
      .eq("source", "meta").is("ingested_at", null).order("received_at").limit(20);
    if (error) throw error;
    return data;
  }

  async upsertUser(waId: string, name: string | null): Promise<User> {
    // Never overwrite a stored name: the user may have told the Desk a different one.
    const { error } = await this.db.from("users")
      .upsert({ wa_id: waId, name, phone_e164: waIdToE164(waId) }, {
        onConflict: "wa_id",
        ignoreDuplicates: true,
      });
    if (error) throw error;
    const { data, error: e2 } = await this.db.from("users")
      .select("id, wa_id, blocked").eq("wa_id", waId).single();
    if (e2) throw e2;
    return { id: data.id, waId: data.wa_id, blocked: data.blocked };
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
    return data as { user_id: string; wa_id: string; blocked: boolean; body: unknown }[];
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
