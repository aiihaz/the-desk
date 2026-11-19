import { DbCallStore } from "../_shared/call_store.ts";
import { reportCall } from "../_shared/chat/report.ts";
import { DbChatStore } from "../_shared/chat/store.ts";
import { claimChecker, verifier } from "../_shared/chat/verify.ts";
import { createDelivery } from "../_shared/messaging.ts";
import { observedResponsesClient as responsesClient } from "../_shared/model_client.ts";
import { DbStore, serviceClient } from "../_shared/store.ts";
import { getRecording, sarvamConfigFromEnv } from "../_shared/sarvam.ts";
import { handle } from "./handler.ts";

const store = new DbCallStore();
const chat = new DbChatStore();
const waStore = new DbStore();
const openai = responsesClient(Deno.env.get("OPENAI_API_KEY") ?? "");
const verify = verifier(chat, openai);
const checkClaim = claimChecker(chat, openai);

Deno.serve((req) =>
  handle(req, {
    store,
    webhookToken: Deno.env.get("SARVAM_WEBHOOK_TOKEN") ?? "",
    // deno-lint-ignore no-explicit-any
    background: (p) => (globalThis as any).EdgeRuntime?.waitUntil(p) ?? p,
    // Verify any booking, settle the request and tell the user what the call
    // established (chat/report.ts, chat/verify.ts).
    handOff: (callId, r) =>
      reportCall(
        {
          store: chat,
          create: openai,
          verify,
          checkClaim,
          send: createDelivery(waStore),
        },
        callId,
        r,
      ),
    // 0031: archive the call's recording to the private call-audio bucket. Runs only
    // when limits.comparison_mode is on (checked by the handler). A missing recording
    // on the provider's side leaves calls.audio_path null.
    archiveAudio: async (callId, interactionId) => {
      const wav = await getRecording(sarvamConfigFromEnv(), interactionId);
      if (!wav) return;
      const path = `${callId}.wav`;
      const { error } = await serviceClient().storage.from("call-audio").upload(path, wav, {
        contentType: "audio/wav",
        upsert: true,
      });
      if (error) throw new Error(`call-audio upload failed: ${error.message}`);
      await store.setAudioPath(callId, path);
    },
  })
);
