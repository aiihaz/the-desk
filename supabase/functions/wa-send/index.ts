import { createDelivery } from "../_shared/messaging.ts";
// Internal: other functions POST {"wa_id": "...", "message": Outbound}.
// verify_jwt is on, so only callers holding the service role key get here.
import { OutsideServiceWindow } from "../_shared/deliver.ts";
import { DbStore } from "../_shared/store.ts";
import { type Outbound } from "../_shared/whatsapp.ts";

const store = new DbStore();
const send = createDelivery(store);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const { wa_id, message } = await req.json() as { wa_id: string; message: Outbound };
  const user = await store.upsertUser(wa_id, null);
  try {
    const id = await send(user, message);
    return Response.json({ wa_message_id: id });
  } catch (e) {
    if (e instanceof OutsideServiceWindow) {
      return Response.json({ error: "outside_service_window" }, { status: 409 });
    }
    return Response.json({ error: String(e) }, { status: 502 });
  }
});
