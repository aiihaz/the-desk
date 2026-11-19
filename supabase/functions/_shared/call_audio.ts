import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { getRecording, sarvamConfigFromEnv } from "./sarvam.ts";

export type AudioJob = { call_id: string; interaction_id: string; token: string };
export type AudioWork = {
  prepare(): Promise<void>;
  deletions(): Promise<string[]>;
  remove(paths: string[]): Promise<void>;
  acknowledge(paths: string[]): Promise<void>;
  take(): Promise<AudioJob[]>;
  fetch(interactionId: string): Promise<Uint8Array | null>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
  finish(job: AudioJob, uploaded: boolean): Promise<void>;
};

// Cleanup always runs, including with archive permission off. A missing recording
// is durable work, not a successful archive. Every attempt is fenced by a DB lease.
// A backlog is left for the next run: erasure waits in the database until a user's
// queued deletions are gone, so nothing here has to fail to hold a confirmation back.
export async function processCallAudio(work: AudioWork, approved: boolean): Promise<void> {
  await work.prepare();
  for (let batch = 0; batch < 20; batch++) {
    const paths = await work.deletions();
    if (!paths.length) break;
    await work.remove(paths);
    await work.acknowledge(paths);
  }
  if (!approved) return;
  for (const job of await work.take()) {
    let uploaded = false;
    try {
      const bytes = await work.fetch(job.interaction_id);
      if (bytes) {
        await work.upload(`${job.call_id}.wav`, bytes);
        uploaded = true;
      }
    } catch {
      // Bounded by job expiry/retention. The database schedules the next attempt.
    }
    await work.finish(job, uploaded);
  }
}

// What the scheduled jobs call. Audio is side work: a Storage or provider outage is
// logged and reported, never thrown into the job that also settles calls, replays
// events and erases accounts.
export async function runCallAudio(
  work: AudioWork,
  approved: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await processCallAudio(work, approved);
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("call audio work failed", error);
    return { ok: false, error };
  }
}

export function audioWork(db: SupabaseClient): AudioWork {
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw error;
    return data;
  };
  return {
    prepare: async () => {
      await rpc("prepare_audio_cleanup");
    },
    deletions: async () => {
      const { data, error } = await db.from("call_audio_deletions").select("path").limit(100);
      if (error) throw error;
      return data.map((x) => x.path);
    },
    remove: async (paths) => {
      const { error } = await db.storage.from("call-audio").remove(paths);
      if (error) throw error;
    },
    acknowledge: async (paths) => {
      const { error } = await db.from("calls").update({ audio_path: null }).in("audio_path", paths);
      if (error) throw error;
      const removed = await db.from("call_audio_deletions").delete().in("path", paths);
      if (removed.error) throw removed.error;
    },
    take: () => rpc("take_audio_jobs"),
    fetch: (id) => getRecording(sarvamConfigFromEnv(), id),
    upload: async (path, bytes) => {
      const { error } = await db.storage.from("call-audio").upload(path, bytes, {
        contentType: "audio/wav",
        upsert: true,
      });
      if (error) throw error;
    },
    finish: async (job, uploaded) => {
      await rpc("finish_audio_job", { p_call_id: job.call_id, p_token: job.token, p_uploaded: uploaded });
    },
  };
}
