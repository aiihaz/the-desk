// Database access for the WhatsApp functions. The interface lets tests use a fake.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { waIdToE164 } from "./e164.ts";
import type { Inbound, Outbound } from "./whatsapp.ts";

export type User = { id: string; waId: string; blocked: boolean };

export interface Store {
  // false if this exact webhook body was already stored (Meta redelivery).
  saveEvent(externalId: string, payload: unknown): Promise<boolean>;
  upsertUser(waId: string, name: string | null): Promise<User>;
  // false if the message id was already stored.
  saveInbound(userId: string, msg: Inbound): Promise<boolean>;
  lastInboundAt(userId: string): Promise<Date | null>;
  saveOutbound(userId: string, waMessageId: string, msg: Outbound): Promise<void>;
}

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
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
    const { data, error } = await this.db.from("messages")
      .upsert({
        user_id: userId,
        wa_message_id: msg.messageId,
        direction: "in",
        body: msg.raw,
        at: msg.at.toISOString(),
      }, { onConflict: "wa_message_id", ignoreDuplicates: true })
      .select("id");
    if (error) throw error;
    return data.length > 0;
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
