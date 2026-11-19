import { deepStrictEqual as eq } from "node:assert/strict";
import { type AudioWork, processCallAudio, runCallAudio } from "./call_audio.ts";

function fake() {
  const log: string[] = [];
  let deletes = ["old.wav"];
  const work: AudioWork = {
    prepare: async () => {
      log.push("prepare");
    },
    deletions: async () => deletes,
    remove: async () => {
      log.push("remove");
    },
    acknowledge: async () => {
      log.push("ack");
      deletes = [];
    },
    take: async () => [{ call_id: "call", interaction_id: "recording", token: "lease" }],
    fetch: async () => null,
    upload: async () => {
      log.push("upload");
    },
    finish: async (_j, uploaded) => {
      log.push(`finish:${uploaded}`);
    },
  };
  return { work, log };
}
Deno.test("audio approval OFF: cleanup runs but no recording is fetched", async () => {
  const { work, log } = fake();
  work.take = () => {
    throw Error("must not take archive work");
  };
  await processCallAudio(work, false);
  eq(log, ["prepare", "remove", "ack"]);
});
Deno.test("audio not yet ready remains failed durable work, then later ready upload succeeds", async () => {
  const { work, log } = fake();
  await processCallAudio(work, true);
  eq(log, ["prepare", "remove", "ack", "finish:false"]);
  work.fetch = async () => new Uint8Array([1, 2]);
  await processCallAudio(work, true);
  eq(log.slice(-3), ["prepare", "upload", "finish:true"]);
});
Deno.test("audio storage failure is retried and erasure is not acknowledged before removal", async () => {
  const { work, log } = fake();
  work.remove = async () => {
    throw Error("storage unavailable");
  };
  let failed = false;
  try {
    await processCallAudio(work, false);
  } catch {
    failed = true;
  }
  eq(failed, true);
  eq(log, ["prepare"]);
});
Deno.test("audio upload failure persists a retry instead of claiming success", async () => {
  const { work, log } = fake();
  work.fetch = async () => new Uint8Array([1]);
  work.upload = async () => {
    throw Error("upload failed");
  };
  await processCallAudio(work, true);
  eq(log.at(-1), "finish:false");
});
Deno.test("scheduled audio work reports a Storage outage instead of throwing into the job", async () => {
  const { work } = fake();
  work.remove = async () => {
    throw Error("storage unavailable");
  };
  const res = await runCallAudio(work, true);
  eq(res, { ok: false, error: "storage unavailable" });
});
Deno.test("a deletion backlog is left for the next run, not thrown", async () => {
  const { work, log } = fake();
  work.acknowledge = async () => {
    log.push("ack"); // the queue never empties
  };
  await processCallAudio(work, false);
  eq(log.filter((x) => x === "remove").length, 20);
});
