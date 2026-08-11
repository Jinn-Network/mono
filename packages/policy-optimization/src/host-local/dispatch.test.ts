import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellIdempotencyKey, submissionExtensionBlock } from "@jinn-network/benchmarking-records";
import type { TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import { documentDigest, sealSubmission, sealTask } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import { submitPreparedDispatch } from "./dispatch.js";
import { LiveHostJournal } from "./journal.js";

const CAMPAIGN = `sha256:${"1".repeat(64)}`;
const RUN = `sha256:${"2".repeat(64)}`;
const SPLIT = `sha256:${"3".repeat(64)}`;
const TUPLE = `sha256:${"4".repeat(64)}`;
const CELL = `${"5".repeat(64)}/armA/1`;
const SUBMISSION = "urn:uuid:11111111-1111-5111-8111-111111111111" as const;
const ATTEMPT = "urn:uuid:22222222-2222-5222-8222-222222222222" as const;
const AT = "2026-08-05T12:00:00Z";

function hasPreparedSubmission(root: string): boolean {
  if (!existsSync(root)) return false;
  return readdirSync(root, { withFileTypes: true }).some((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? hasPreparedSubmission(path) : entry.name === "submission.sealed.json";
  });
}

function fixture(root: string) {
  const requirements = { loadout: { id: "learner-public", version: "1" } };
  const taskBytes = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "6".repeat(64) },
    },
    instructions: "Fix the bug.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
  const taskDigest = documentDigest(taskBytes);
  const idempotencyKey = cellIdempotencyKey(RUN, CELL, 1);
  const submissionBytes = sealSubmission({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: SUBMISSION,
    task: { digest: { sha256: taskDigest.slice("sha256:".length) } },
    requester: "urn:jinn:requester",
    idempotencyKey,
    nonce: `${CELL}:1`,
    deadline: "2026-08-05T13:00:00Z",
    requirements,
    annotations: submissionExtensionBlock(RUN, CELL, "armA"),
  });
  return {
    stateRoot: root,
    campaign: CAMPAIGN,
    run: RUN,
    cellKey: CELL,
    armId: "armA",
    dispatch: 1,
    dispatchId: "solver/1",
    requester: "urn:jinn:requester",
    nonce: `${CELL}:1`,
    idempotencyKey,
    requirements,
    taskBytes,
    submissionBytes,
  };
}

function backend(root: string, ready = true) {
  let submissions = 0;
  const taskDigest = { value: "" };
  const instance: TaskExecutionBackend = {
    capabilities: async () => ({
      taskProfiles: [],
      inputMediaTypes: [],
      outputMediaTypes: [],
      cancel: true,
      watch: false,
      preflight: true,
      fetchArtifact: false,
      confidentialInputs: false,
      signedObservations: false,
      signedDeliveries: true,
      evidenceCapture: "none",
      deadlineEnforcement: true,
      isolation: [],
      attempts: {},
      runPinning: { keys: [] },
    }),
    preflight: async () => ({ ready }),
    submit: async (taskBytes, submissionBytes) => {
      submissions += 1;
      expect(hasPreparedSubmission(root)).toBe(true);
      taskDigest.value = documentDigest(taskBytes);
      return { accepted: true, submission: SUBMISSION, digest: documentDigest(submissionBytes) };
    },
    observe: async () => ({
      descriptor: {
        attempt: ATTEMPT,
        task: taskDigest.value as `sha256:${string}`,
        submission: SUBMISSION,
        derived: {
          state: "pending", terminal: false, contradictory: false, cancelRequested: false,
          executionIds: [], deliveries: [],
        },
      },
      cursor: { sequence: "0000000000000001" },
      observations: [],
    }),
    recover: async () => ({ classification: "matching" }),
    deliveries: async () => [],
    fetchDelivery: async () => new Uint8Array(),
  };
  return { instance, submissions: () => submissions, taskDigest };
}

async function initialize(journal: LiveHostJournal) {
  await journal.transact(async (transaction) => {
    transaction.append({
      recordedAt: AT, type: "plan-recorded", payload: { planDigest: TUPLE, splitManifestDigest: SPLIT },
    });
    transaction.append({
      recordedAt: AT,
      type: "run-recorded",
      payload: { runDigest: RUN, kind: "training", arms: [{ armId: "armA", tupleDigest: TUPLE }] },
    });
  });
}

describe("live prepared dispatch", () => {
  test("persists before submit, requires positive admission, and recovers without resubmitting", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-live-dispatch-"));
    const hostJournal = new LiveHostJournal(root, CAMPAIGN, "urn:jinn:journal-author");
    await initialize(hostJournal);
    const local = backend(root);
    const input = fixture(root);
    const first = await hostJournal.transact(async (transaction) => submitPreparedDispatch({
      ...input, role: "solver", backend: local.instance, transaction, recordedAt: AT,
    }));
    expect(first.recovered).toBe(false);
    expect(local.submissions()).toBe(1);
    local.taskDigest.value = documentDigest(input.taskBytes);
    const recovered = await hostJournal.transact(async (transaction) => submitPreparedDispatch({
      ...input, role: "solver", backend: local.instance, transaction, recordedAt: AT,
    }));
    expect(recovered.recovered).toBe(true);
    expect(local.submissions()).toBe(1);
  });

  test("does not submit when pinning admission is not positively ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-live-admission-"));
    const hostJournal = new LiveHostJournal(root, CAMPAIGN, "urn:jinn:journal-author");
    await initialize(hostJournal);
    const local = backend(root, false);
    await expect(hostJournal.transact(async (transaction) => submitPreparedDispatch({
      ...fixture(root), role: "solver", backend: local.instance, transaction, recordedAt: AT,
    }))).rejects.toThrow(/positive pinning admission/u);
    expect(local.submissions()).toBe(0);
  });
});
