/**
 * BP-20 deliverable B (spec §4.6 Quote row): "expected cell count; per-cell and total price (paid
 * venues) or time/disk estimates (local); hard-cap check; coverage facts; venue guarantee
 * summary." Exercises `runQuote`'s `presentation` field (`./run-quote.ts`) across run size,
 * coverage refusals, the hard-cap check, and the preview-derived wall-time estimate.
 *
 * A dependency-injected stub venue (adapted from `./run-quote.test.ts`'s own "dependency-injected
 * venue" describe block) is used throughout, rather than the real local venue — this keeps every
 * assertion here exact and independent of what launchers the real venue happens to wire up today.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AttemptUri, BackendCapabilities, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import type { AssurancePreset } from "../domain/draft.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import type { ProxiedBackend } from "../run/drive.js";
import { readPreviewLog } from "../run/preview-log.js";
import { draftPath } from "../workspace/layout.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runPreview } from "./preview.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp20-quote-presentation-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let ms = Date.parse("2026-08-06T00:00:00.000Z");
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

/** Sample benchmark = 3 items (`../intake/sample.ts`); default replicates = 1
 * (`DRAFT_SPEC_DEFAULTS`); default assurance = direct-check (minVerdicts 1). */
async function setUpTwoArmDraft(clock: () => string, draftId = "draft-1"): Promise<void> {
  initWorkspace(contextFor(clock));
  const draftResult = createDraft(contextFor(clock), { draftId, name: "Quote Presentation Test" });
  expect(draftResult.ok).toBe(true);
  await sampleInit(contextFor(clock), { draftId });
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
}

function forceAssurancePreset(draftId: string, preset: AssurancePreset): void {
  const document = readDraftDocument(workspaceDir, draftId);
  atomicWriteFileSync(
    draftPath(workspaceDir, draftId),
    JSON.stringify({ ...document, spec: { ...document.spec, assurance: { preset } } }, null, 2),
  );
}

function forceBudget(draftId: string, budget: { perCell: { solve: string; evaluate: string }; hardCap: string; unit: string }): void {
  const document = readDraftDocument(workspaceDir, draftId);
  atomicWriteFileSync(
    draftPath(workspaceDir, draftId),
    JSON.stringify({ ...document, spec: { ...document.spec, budget } }, null, 2),
  );
}

const DEFAULT_RUN_PINNING_KEYS: BackendCapabilities["runPinning"]["keys"] = [
  { key: "harness", inventory: ["prediction-v1-baseline", "sample-uniform"], posture: "enforced" },
  { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
];

/** Adapted from `./run-quote.test.ts`'s own "dependency-injected venue" stub. */
function stubVenue(keys: BackendCapabilities["runPinning"]["keys"] = DEFAULT_RUN_PINNING_KEYS): LocalVenue {
  return {
    backend: {
      async capabilities(): Promise<BackendCapabilities> {
        return {
          taskProfiles: [],
          inputMediaTypes: [],
          outputMediaTypes: [],
          cancel: false,
          watch: false,
          preflight: false,
          fetchArtifact: false,
          confidentialInputs: false,
          signedObservations: false,
          signedDeliveries: false,
          evidenceCapture: "none",
          deadlineEnforcement: false,
          isolation: ["unrestricted"],
          attempts: {},
          runPinning: { keys },
        };
      },
      submit: async () => {
        throw new Error("not used by runQuote");
      },
      observe: async () => {
        throw new Error("not used by runQuote");
      },
      recover: async () => {
        throw new Error("not used by runQuote");
      },
      deliveries: async () => [],
      fetchDelivery: async () => {
        throw new Error("not used by runQuote");
      },
    } as unknown as LocalVenue["backend"],
    verdictKeyId: "stub-key",
    prepareEvaluationCell: () => {
      throw new Error("not used by runQuote");
    },
    async shutdown() {},
  };
}

/** Solve-leg-only fake backend for `runPreview` — adapted from `./preview.test.ts`'s own
 * `makeSolveOnlyFakeBackend`. */
function makeSolveOnlyFakeBackend(): { backend: ProxiedBackend } {
  const byUri = new Map<string, { attempt: string; submission: string; deliveryDigestHex: string }>();
  const byIdempotencyKey = new Map<string, { bytesHash: string; ack: SubmissionAck }>();
  const bytesByHex = new Map<string, Uint8Array>();
  let counter = 0;

  function store(bytes: Uint8Array): string {
    const hex = sha256Hex(bytes);
    bytesByHex.set(hex, bytes);
    return hex;
  }

  const backend: ProxiedBackend = {
    async capabilities() {
      throw new Error("not used");
    },
    async submit(_taskBytes, submissionBytes) {
      const doc = JSON.parse(new TextDecoder().decode(submissionBytes)) as { idempotencyKey: string; submission: string };
      const bytesHash = sha256Hex(submissionBytes);
      const prior = byIdempotencyKey.get(doc.idempotencyKey);
      if (prior !== undefined) return prior.ack;
      counter += 1;
      const attempt = `urn:uuid:00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      const artifactHex = store(utf8({ probabilityYes: "0.5", submittedAt: "2026-01-01T00:00:00Z" }));
      const deliveryHex = store(utf8({ outputs: [{ name: "prediction", digest: { sha256: artifactHex } }] }));
      byUri.set(doc.submission, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      byUri.set(attempt, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      const ack: SubmissionAck = { accepted: true, submission: doc.submission as SubmissionUri, digest: `sha256:${bytesHash}` };
      byIdempotencyKey.set(doc.idempotencyKey, { bytesHash, ack });
      return ack;
    },
    async observe(ref) {
      const found = byUri.get(ref as string);
      if (found === undefined) throw new Error(`fake: no attempt for ${String(ref)}`);
      const snapshot: ObservationSnapshot = {
        descriptor: {
          attempt: found.attempt as `urn:uuid:${string}`,
          task: `sha256:${"0".repeat(64)}`,
          submission: found.submission as `urn:uuid:${string}`,
          derived: { state: "delivered", terminal: true, contradictory: false, cancelRequested: false, executionIds: [], deliveries: [] },
        },
        cursor: { sequence: "0" },
        observations: [],
      };
      return snapshot;
    },
    async recover() {
      throw new Error("not used");
    },
    async deliveries(attempt) {
      const found = byUri.get(attempt as string);
      return found === undefined ? [] : [{ attempt: attempt as AttemptUri, digest: `sha256:${found.deliveryDigestHex}` } as DeliveryRef];
    },
    async fetchDelivery(ref) {
      const bytes = bytesByHex.get(ref.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("fake: unknown delivery digest");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const sha256 = descriptor.digest?.["sha256"];
      const bytes = sha256 === undefined ? undefined : bytesByHex.get(sha256);
      if (bytes === undefined) throw new Error("fake: unknown artifact digest");
      return bytes;
    },
    async drain() {},
  };
  return { backend };
}

function previewVenue(backend: ProxiedBackend): LocalVenue {
  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: "fake-preview-verdict-key",
    prepareEvaluationCell: () => {
      throw new Error("not used");
    },
    async shutdown() {},
  };
}

describe("runQuote — presentation.runSize (spec §4.6)", () => {
  test("direct-check (minVerdicts 1): solveCells 6, evaluationCells 6, totalCells 12, perArm 3/3 each", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => stubVenue() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    const { runSize } = outcome.result.presentation;
    expect(runSize.solveCells).toBe(6);
    expect(runSize.evaluationCells).toBe(6);
    expect(runSize.totalCells).toBe(12);
    expect(runSize.perArm).toHaveLength(2);
    for (const arm of runSize.perArm) {
      expect(arm.solveCells).toBe(3);
      expect(arm.evaluationCells).toBe(3);
    }
    expect(new Set(runSize.perArm.map((arm) => arm.armId))).toEqual(new Set(["baseline", "sample"]));
  });

  test("evaluator-panel (minVerdicts 2): evaluationCells 12 overall, 6 per arm", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);
    forceAssurancePreset("draft-1", "evaluator-panel");

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => stubVenue() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    const { runSize } = outcome.result.presentation;
    expect(runSize.solveCells).toBe(6);
    expect(runSize.evaluationCells).toBe(12);
    expect(runSize.totalCells).toBe(18);
    for (const arm of runSize.perArm) {
      expect(arm.solveCells).toBe(3);
      expect(arm.evaluationCells).toBe(6);
    }
  });
});

describe("runQuote — presentation.coverage (spec §4.6)", () => {
  test("an arm pinning an unknown key produces a refusal naming the arm + key, consistent with quote.errors", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    const draftResult = createDraft(contextFor(clock), { draftId: "draft-1", name: "Coverage Test" });
    expect(draftResult.ok).toBe(true);
    await sampleInit(contextFor(clock), { draftId: "draft-1" });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), {
      draftId: "draft-1",
      armId: "sample",
      pinning: { harness: { id: "sample-uniform", version: "0.1.0" }, gadget: "x" },
    });

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => stubVenue() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    const { presentation, quote } = outcome.result;
    expect(presentation.coverage.supportedKeys).toEqual(["harness", "isolationPolicy"]);

    const refusal = presentation.coverage.refusals.find((entry) => entry.armId === "sample" && entry.key === "gadget");
    expect(refusal, JSON.stringify(presentation.coverage.refusals)).toBeDefined();

    const expectedUnsupportedCount = quote.errors.filter((error) => error.code === "unsupported-requirement").length;
    expect(presentation.coverage.refusals).toHaveLength(expectedUnsupportedCount);
    expect(quote.ok).toBe(false);
  });

  test("no unsupported pinning: coverage.refusals is empty and quote.ok stays true", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => stubVenue() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.presentation.coverage.refusals).toEqual([]);
    expect(outcome.result.quote.ok).toBe(true);
  });
});

describe("runQuote — presentation.hardCap (spec §4.6)", () => {
  test("no budget: declared false, breached false", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => stubVenue() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.presentation.hardCap).toEqual({ declared: false, breached: false });
  });

  test("budget breaching the hard cap: declared true, breached true, with detail", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);
    forceBudget("draft-1", { perCell: { solve: "1", evaluate: "1" }, hardCap: "0.01", unit: "USD" });

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => stubVenue() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    const { hardCap } = outcome.result.presentation;
    expect(hardCap.declared).toBe(true);
    expect(hardCap.breached).toBe(true);
    expect(hardCap.detail).toBeDefined();
    const breachError = outcome.result.quote.errors.find((error) => error.code === "hard-cap-breach");
    expect(hardCap.detail).toBe(breachError?.detail);
  });

  test("budget within the hard cap: declared true, breached false", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);
    forceBudget("draft-1", { perCell: { solve: "1", evaluate: "1" }, hardCap: "1000", unit: "USD" });

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => stubVenue() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.presentation.hardCap).toEqual({ declared: true, breached: false });
    expect(outcome.result.quote.ok).toBe(true);
  });
});

describe("runQuote — presentation.estimatedWallTime (spec §4.6 local-venue time estimates; §7.2)", () => {
  test("absent when this draft has no preview history", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => stubVenue() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.presentation.estimatedWallTime).toBeUndefined();
  });

  test("present after two previews; arithmetic matches the persisted preview log exactly", async () => {
    const clock = makeClock();
    await setUpTwoArmDraft(clock);

    const { backend } = makeSolveOnlyFakeBackend();
    const firstPreview = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => previewVenue(backend) });
    expect(firstPreview.ok, JSON.stringify(firstPreview)).toBe(true);
    const secondPreview = await runPreview(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => previewVenue(backend) });
    expect(secondPreview.ok, JSON.stringify(secondPreview)).toBe(true);

    const log = readPreviewLog(workspaceDir, "draft-1");
    expect(log?.count).toBe(2);
    if (log === undefined) throw new Error("unreachable");
    const rehearsedCells = log.previews.reduce((sum, preview) => sum + preview.cellCount, 0);
    expect(rehearsedCells).toBeGreaterThan(0);
    const totalElapsedMs = log.previews.reduce((sum, preview) => sum + preview.elapsedMs, 0);
    const expectedMeanCellMs = Math.round(totalElapsedMs / rehearsedCells);

    const outcome = await runQuote(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => stubVenue() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    const { estimatedWallTime, runSize } = outcome.result.presentation;
    expect(estimatedWallTime).toEqual({
      source: "estimate-from-rehearsal",
      previewCount: 2,
      rehearsedCells,
      meanCellMs: expectedMeanCellMs,
      projectedSolveMs: Math.round(expectedMeanCellMs * runSize.solveCells),
    });
  });
});
