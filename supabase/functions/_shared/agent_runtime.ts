// Production: Meta's webhook into the chat agent, the same code the dev bench runs
// (chat/agent.ts). DESK_ECHO=1 swaps the agent for an echo, for the WhatsApp round-trip test.
import { DbCallStore } from "./call_store.ts";
import { callAfterConsent } from "./chat/calls.ts";
import { DbAdminStore } from "./chat/admin.ts";
import { runCommand } from "./chat/commands.ts";
import { type AgentDeps, handleInbound } from "./chat/agent.ts";
import { type LunaDeps, runLuna } from "./chat/luna.ts";
import { DbChatStore } from "./chat/store.ts";
import { deliver } from "./deliver.ts";
import { dial, type DialArgs } from "./dial.ts";
import { handleScreenshot } from "./chat/payment.ts";
import { jevClient } from "./jev.ts";
import { observedResponsesClient as responsesClient } from "./model_client.ts";
import { placesClient, type SearchPlaces } from "./places.ts";
import { serperClient, withWebPhones } from "./serper.ts";
import { sarvamConfigFromEnv, startCall } from "./sarvam.ts";
import { DbStore, serviceClient, type User } from "./store.ts";
import { downloadMedia, imageId, type Outbound, send as waSend, waConfigFromEnv } from "./whatsapp.ts";

export function createAgentRuntime() {
  const store = new DbStore();
  const chat = new DbChatStore();
  const calls = new DbCallStore();
  const wa = waConfigFromEnv();
  const sarvam = sarvamConfigFromEnv();
  const env = (k: string) => Deno.env.get(k) ?? "";

  const send = (user: User, msg: Outbound) => deliver(store, (to, m) => waSend(wa, to, m), user, msg);

  // Google Places, then a web lookup for places listed with no phone (eng plan 3.3).
  const places: SearchPlaces = env("GOOGLE_MAPS_API_KEY")
    ? placesClient(env("GOOGLE_MAPS_API_KEY"))
    : () => Promise.reject(new Error("GOOGLE_MAPS_API_KEY is not set"));
  const searchPlaces: SearchPlaces = env("SERPER_API_KEY")
    ? withWebPhones(places, serperClient(env("SERPER_API_KEY")))
    : places;

  // After an approval: reserve_call() and Sarvam, through dial().
  const dialer = (a: DialArgs) => dial({ store: calls, start: (c) => startCall(sarvam, c) }, a);
  const onApproved: LunaDeps["onApproved"] = (user, consent) =>
    callAfterConsent(
      { store: chat, send, dial: dialer, create: responsesClient(env("OPENAI_API_KEY")) },
      user,
      consent,
    );

  const luna: LunaDeps | null = env("OPENAI_API_KEY")
    ? {
      store: chat,
      send,
      create: responsesClient(env("OPENAI_API_KEY")),
      jev: env("TYPESAFE_API_KEY") ? jevClient(env("TYPESAFE_API_KEY")) : undefined,
      searchPlaces,
      onApproved,
    }
    : null;

  // Comma-separated wa_ids (no +), allowed the admin commands (chat/admin.ts).
  const adminStore = new DbAdminStore();
  const admins = new Set(env("DESK_ADMIN_WA_IDS").split(",").map((s) => s.trim()).filter(Boolean));

  const agent: AgentDeps = {
    store: chat,
    send,
    isAdmin: (waId) => admins.has(waId),
    luna: async (user, _text, msg, turnStore) => {
      const scoped = turnStore ?? chat;
      const scopedSend: typeof send = async (u, m) => {
        await scoped.assertTurn?.();
        return send(u, m);
      };
      if (luna) {
        return runLuna(
          {
            ...luna,
            store: scoped,
            send: scopedSend,
            onApproved: (u, c) =>
              callAfterConsent(
                {
                  store: scoped,
                  send: scopedSend,
                  create: luna.create,
                  dial: async (a) => {
                    await scoped.assertTurn?.();
                    return dial({
                      store: new DbCallStore(serviceClient(scoped.turnToken)),
                      start: async (c) => {
                        await scoped.assertTurn?.();
                        return startCall(sarvam, c);
                      },
                    }, a);
                  },
                },
                u,
                c,
              ),
          },
          user,
          msg.at,
          msg.messageId,
        );
      }
      // Misconfigured: say something rather than leave the user in silence.
      console.error("OPENAI_API_KEY is not set");
      const tpl = await chat.template("fallback_generic", (await chat.user(user.id)).language);
      if (tpl) await send(user, { kind: "text", body: tpl });
    },
    onCommand: (user, route) => runCommand({ store: chat, send, admin: adminStore }, user, route),
    // The payment screenshot check (eng plan 2.2), then the confirm call.
    onPayment: (user, _route, msg, turnStore) => {
      const scoped = turnStore ?? chat;
      const scopedSend: typeof send = async (u, m) => {
        await scoped.assertTurn?.();
        return send(u, m);
      };
      return handleScreenshot(
        {
          store: scoped,
          send: scopedSend,
          dial: async (a) => {
            await scoped.assertTurn?.();
            return dial({
              store: new DbCallStore(serviceClient(scoped.turnToken)),
              start: async (c) => {
                await scoped.assertTurn?.();
                return startCall(sarvam, c);
              },
            }, a);
          },
          create: responsesClient(env("OPENAI_API_KEY")),
          image: async (raw) => {
            const id = imageId(raw);
            return id ? await downloadMedia(wa, id) : null;
          },
          notAPayment: async (u) => {
            if (luna) await agent.luna(u, "", msg, scoped);
          },
        },
        user,
        msg.raw,
        msg.messageId,
      );
    },
  };

  return {
    store,
    chat,
    send,
    handOff: async (user: User, msg: import("./whatsapp.ts").Inbound) => {
      if (env("DESK_ECHO") === "1") {
        await send(user, { kind: "text", body: `The Desk got: ${msg.text ?? `(${msg.type})`}` });
        await chat.markHandled(msg.messageId);
      } else await handleInbound(user, msg, agent);
    },
  };
}
