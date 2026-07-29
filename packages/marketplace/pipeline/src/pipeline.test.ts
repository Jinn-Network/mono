// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BackendCapabilities,
  PreflightReport,
  RunPinningKeySupport,
  TaskExecutionBackend,
} from "@jinn-network/task-execution-backend";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import {
  sealDelivery,
  sealSubmission,
  sealTask,
  sha256Hex,
} from "@jinn-network/task-execution-protocol";
import { createInMemoryBackend } from "@jinn-network/task-execution-testing";
import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA_TODAY, keccakEvidenceHash } from "@jinn-network/marketplace-binding";
import { takeEveryRunnable } from "./claim-predicate.js";
import { runPipeline, type PipelinePorts } from "./pipeline.js";
import type { SubmissionFacts } from "./types.js";

const PROFILE_URI = "https://jinn.network/task-profiles/repository-work/1.0";
const ATTEMPT_URI = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_ID = `0x${"b".repeat(64)}` as const;
const CLAIM_TX = `0x${"c".repeat(64)}` as const;

const DEFAULT_RUN_PINNING: RunPinningKeySupport[] = [
  { key: "harness", inventory: ["claude-code", "fake-harness-v1"], posture: "attested" },
  { key: "model", inventory: ["claude-haiku"], posture: "attested" },
];

function goldenTask(): Uint8Array {
  return sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: PROFILE_URI,
      digest: { sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6" },
    },
    instructions: "Fix the failing test.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
}

function goldenSubmission(taskBytes: Uint8Array): Uint8Array {
  return sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: "urn:uuid:22222222-2222-4222-8222-222222222222",
    task: { digest: { sha256: sha256Hex(taskBytes) } },
    requester: "urn:uuid:33333333-3333-4333-8333-333333333333",
    idempotencyKey: "key-1",
    nonce: "nonce-1",
    deadline: "2099-01-01T00:00:00Z",
  });
}

function goldenDelivery(attemptUri: string): Uint8Array {
  return sealDelivery({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    attempt: attemptUri,
    task: `sha256:${"1".repeat(64)}`,
    outputs: [],
    outcome: "fulfilled",
    executionIds: ["urn:uuid:44444444-4444-4444-8444-444444444444"],
    evidenceRecords: [{ family: "execution-evidence", digest: `sha256:${"2".repeat(64)}` }],
    createdAt: "2026-07-29T00:00:00Z",
  });
}

function baseFacts(overrides: Partial<SubmissionFacts> = {}): SubmissionFacts {
  return {
    taskId: 7n,
    taskDigest: `sha256:${"a".repeat(64)}`,
    submission: "urn:uuid:22222222-2222-4222-8222-222222222222",
    nonce: "nonce-1",
    profileUri: PROFILE_URI,
    requirements: {},
    runnable: true,
    intendedSpendWei: 1n,
    intendedAiUnits: 1,
    workKind: "repo-fix",
    ...overrides,
  };
}

function createPreflightBackend(options?: {
  taskProfiles?: string[];
  runPinning?: RunPinningKeySupport[];
  preflight?: TaskExecutionBackend["preflight"];
  capabilities?: Partial<BackendCapabilities>;
}): TaskExecutionBackend {
  const inner = createInMemoryBackend({ runPinning: options?.runPinning ?? DEFAULT_RUN_PINNING });
  const preflight = options?.preflight ?? (async (): Promise<PreflightReport> => ({ ready: true }));
  return {
    capabilities: async () => {
      const base = await inner.capabilities();
      return {
        ...base,
        taskProfiles: options?.taskProfiles ?? [PROFILE_URI],
        preflight: options?.capabilities?.preflight ?? true,
        runPinning: { keys: options?.runPinning ?? DEFAULT_RUN_PINNING },
        ...options?.capabilities,
      };
    },
    preflight,
    submit: (...args) => inner.submit(...args),
    observe: (...args) => inner.observe(...args),
    deliveries: (...args) => inner.deliveries(...args),
    fetchDelivery: (...args) => inner.fetchDelivery(...args),
    recover: (...args) => inner.recover(...args),
    cancel: async (...args) => {
      if (inner.cancel === undefined) throw new Error("in-memory backend missing cancel");
      return inner.cancel(...args);
    },
  };
}

function settlementPortsForDelivery(deliveryBytes: Uint8Array): PipelinePorts["settlement"] {
  const sha256Digest = `sha256:${sha256Hex(deliveryBytes)}` as const;
  const keccak = keccakEvidenceHash(deliveryBytes);
  return {
    pin: async () => {},
    verifySettlementGrade: async () => ({
      executorBinding: { status: "verified" },
      dispatchBinding: { status: "verified" },
      evaluationSpecification: { status: "not-applicable" },
    }),
    readMechDeliveryFacts: async () => ({
      requestId: REQUEST_ID,
      sha256CidDigest: sha256Digest,
    }),
    readRouterDeliveryFacts: async () => ({
      generation: "today",
      requestId: REQUEST_ID,
      keccakEvidenceHash: keccak,
    }),
    claimSolutionDelivery: async () => ({ status: "settled" }),
  };
}

function makePorts(overrides: Partial<PipelinePorts> = {}): PipelinePorts {
  const deliveryBytes = goldenDelivery(ATTEMPT_URI);
  return {
    claim: {
      taskDigest: `sha256:${"a".repeat(64)}`,
      submission: "urn:uuid:22222222-2222-4222-8222-222222222222",
      nonce: "nonce-1",
      priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace,
      capabilityMatch: async () => ({ ok: true }),
      claimTask: async () => ({
        attemptIndex: 3,
        requestId: REQUEST_ID,
        txHash: CLAIM_TX,
      }),
    },
    finality: {
      awaitFinalized: async () => ({ ok: true }),
    },
    deliveryWait: {
      waitForDelivery: async () => ({
        ok: true,
        deliveryBytes: goldenDelivery(ATTEMPT_URI),
      }),
    },
    settlement: settlementPortsForDelivery(deliveryBytes),
    ipfs: { pin: async () => {} },
    release: { releaseAttempt: async () => {} },
    ...overrides,
  };
}

const WIRING = [{
  workKind: "repo-fix",
  harness: "claude-code",
  model: "claude-haiku",
  plugins: ["git"],
  credentialRef: "cred-1",
}];

const PIPELINE_CONFIG = {
  chain: BASE_SEPOLIA_TODAY,
  predicate: takeEveryRunnable(),
  caps: { spendCapWei: 10n, aiUnitCap: 5 },
  wiring: WIRING,
  priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace,
} as const;

describe("runPipeline", () => {
  test("does not claim when the predicate declines", async () => {
    const claimTask = vi.fn();
    const result = await runPipeline(
      { facts: baseFacts({ runnable: false }), taskBytes: goldenTask(), submissionBytes: goldenSubmission(goldenTask()) },
      PIPELINE_CONFIG,
      createPreflightBackend(),
      makePorts({ claim: { ...makePorts().claim, claimTask } }),
    );
    expect(result).toEqual({ kind: "not-claimed", reason: "predicate-declined" });
    expect(claimTask).not.toHaveBeenCalled();
  });

  test("blocks over-cap spend before claim", async () => {
    const claimTask = vi.fn();
    const result = await runPipeline(
      { facts: baseFacts({ intendedSpendWei: 100n }), taskBytes: goldenTask(), submissionBytes: goldenSubmission(goldenTask()) },
      PIPELINE_CONFIG,
      createPreflightBackend(),
      makePorts({ claim: { ...makePorts().claim, claimTask } }),
    );
    expect(result).toEqual({ kind: "not-claimed", reason: "caps-exceeded" });
    expect(claimTask).not.toHaveBeenCalled();
  });

  test("declines pinning mismatches before claim", async () => {
    const claimTask = vi.fn();
    const result = await runPipeline(
      {
        facts: baseFacts({ runPinning: { harness: "codex" } }),
        taskBytes: goldenTask(),
        submissionBytes: goldenSubmission(goldenTask()),
      },
      PIPELINE_CONFIG,
      createPreflightBackend(),
      makePorts({ claim: { ...makePorts().claim, claimTask } }),
    );
    expect(result).toEqual({ kind: "not-claimed", reason: "pinning-mismatch" });
    expect(claimTask).not.toHaveBeenCalled();
  });

  test("does not claim on profile-mismatch preclaim gate", async () => {
    const claimTask = vi.fn();
    const result = await runPipeline(
      {
        facts: baseFacts({ profileUri: "https://example.com/other/1.0" }),
        taskBytes: goldenTask(),
        submissionBytes: goldenSubmission(goldenTask()),
      },
      PIPELINE_CONFIG,
      createPreflightBackend(),
      makePorts({ claim: { ...makePorts().claim, claimTask } }),
    );
    expect(result).toEqual({ kind: "not-claimed", reason: "profile-mismatch" });
    expect(claimTask).not.toHaveBeenCalled();
  });

  test("does not claim on unsupported-requirement preclaim gate", async () => {
    const claimTask = vi.fn();
    const result = await runPipeline(
      {
        facts: baseFacts({ requirements: { customFlag: true } }),
        taskBytes: goldenTask(),
        submissionBytes: goldenSubmission(goldenTask()),
      },
      PIPELINE_CONFIG,
      createPreflightBackend(),
      makePorts({ claim: { ...makePorts().claim, claimTask } }),
    );
    expect(result).toEqual({ kind: "not-claimed", reason: "unsupported-requirement" });
    expect(claimTask).not.toHaveBeenCalled();
  });

  test("does not claim when preflight capability is unavailable", async () => {
    const claimTask = vi.fn();
    const result = await runPipeline(
      {
        facts: baseFacts(),
        taskBytes: goldenTask(),
        submissionBytes: goldenSubmission(goldenTask()),
      },
      PIPELINE_CONFIG,
      createPreflightBackend({ capabilities: { preflight: false } }),
      makePorts({ claim: { ...makePorts().claim, claimTask } }),
    );
    expect(result).toEqual({ kind: "not-claimed", reason: "preflight-unavailable" });
    expect(claimTask).not.toHaveBeenCalled();
  });

  test("does not claim when preflight reports not ready", async () => {
    const claimTask = vi.fn();
    const result = await runPipeline(
      {
        facts: baseFacts(),
        taskBytes: goldenTask(),
        submissionBytes: goldenSubmission(goldenTask()),
      },
      PIPELINE_CONFIG,
      createPreflightBackend({
        preflight: async () => ({ ready: false, detail: "offline" }),
      }),
      makePorts({ claim: { ...makePorts().claim, claimTask } }),
    );
    expect(result).toEqual({ kind: "not-claimed", reason: "preflight-not-ready" });
    expect(claimTask).not.toHaveBeenCalled();
  });

  test("submits with the third engagement argument carrying the caller-minted Attempt URI", async () => {
    const backend = createPreflightBackend();
    const submitSpy = vi.spyOn(backend, "submit");
    const deliveryBytes = goldenDelivery(ATTEMPT_URI);
    const ports = makePorts({
      claim: {
        ...makePorts().claim,
        claimTask: async () => ({
          attemptIndex: 3,
          requestId: REQUEST_ID,
          txHash: CLAIM_TX,
        }),
      },
      deliveryWait: {
        waitForDelivery: async () => ({ ok: true, deliveryBytes }),
      },
      settlement: settlementPortsForDelivery(deliveryBytes),
    });

    const result = await runPipeline(
      { facts: baseFacts(), taskBytes: goldenTask(), submissionBytes: goldenSubmission(goldenTask()) },
      PIPELINE_CONFIG,
      backend,
      ports,
    );

    expect(result.kind).toBe("delivered");
    expect(submitSpy).toHaveBeenCalledOnce();
    const engagement = submitSpy.mock.calls[0]?.[2];
    expect(engagement?.attemptUri).toMatch(/^urn:uuid:/);
    expect(engagement?.dispatchContext.attempt).toBe(engagement?.attemptUri);
  });

  test("skips submit and releases on finality reorg", async () => {
    const backend = createPreflightBackend();
    const submitSpy = vi.spyOn(backend, "submit");
    const releaseAttempt = vi.fn(async () => {});
    const result = await runPipeline(
      { facts: baseFacts(), taskBytes: goldenTask(), submissionBytes: goldenSubmission(goldenTask()) },
      PIPELINE_CONFIG,
      backend,
      makePorts({
        finality: { awaitFinalized: async () => ({ ok: false, kind: "reorged" }) },
        release: { releaseAttempt },
      }),
    );
    expect(result).toEqual({ kind: "finality-failed", finalityKind: "reorged", released: true });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(releaseAttempt).toHaveBeenCalledWith({ taskId: 7n, attemptIndex: 3 });
  });

  test("releases and returns submit-rejected when the backend refuses engagement", async () => {
    const backend = createPreflightBackend();
    vi.spyOn(backend, "submit").mockResolvedValue({
      accepted: false,
      error: new TaskExecutionError("unsupported-requirement", { detail: "nope" }),
    });
    const releaseAttempt = vi.fn(async () => {});
    const result = await runPipeline(
      { facts: baseFacts(), taskBytes: goldenTask(), submissionBytes: goldenSubmission(goldenTask()) },
      PIPELINE_CONFIG,
      backend,
      makePorts({ release: { releaseAttempt } }),
    );
    expect(result.kind).toBe("submit-rejected");
    expect(releaseAttempt).toHaveBeenCalledOnce();
  });

  test("maps unsupported release to released:false without throwing", async () => {
    const backend = createPreflightBackend();
    vi.spyOn(backend, "submit").mockResolvedValue({
      accepted: false,
      error: new TaskExecutionError("unsupported-requirement", { detail: "nope" }),
    });
    const releaseAttempt = vi.fn(async () => ({ ok: false as const, kind: "unsupported" as const }));
    const result = await runPipeline(
      { facts: baseFacts(), taskBytes: goldenTask(), submissionBytes: goldenSubmission(goldenTask()) },
      PIPELINE_CONFIG,
      backend,
      makePorts({ release: { releaseAttempt } }),
    );
    expect(result).toMatchObject({ kind: "submit-rejected", released: false });
    expect(releaseAttempt).toHaveBeenCalledOnce();
  });

  test("maps settlement race loss without counting it as a settlement gate failure", async () => {
    const result = await runPipeline(
      { facts: baseFacts(), taskBytes: goldenTask(), submissionBytes: goldenSubmission(goldenTask()) },
      PIPELINE_CONFIG,
      createPreflightBackend(),
      makePorts({
        settlement: {
          ...makePorts().settlement,
          claimSolutionDelivery: async () => ({ status: "rejected" }),
        },
      }),
    );
    expect(result).toEqual({ kind: "race-lost", state: "rejected" });
  });
});

describe("pipeline import boundaries", () => {
  test("production sources do not import supervisor/workspace/launchers/projector/trust/discovery", () => {
    const sourceDir = join(dirname(fileURLToPath(import.meta.url)));
    const forbidden = [
      "@jinn-network/task-execution-supervisor",
      "@jinn-network/task-execution-workspace",
      "@jinn-network/task-execution-launchers",
      "@jinn-network/marketplace-projector",
      "@jinn-network/trust-core",
      "@jinn-network/record-discovery-protocol",
      "@jinn-network/task-execution-testing",
    ];
    const files = ["pipeline.ts", "engage.ts", "claim-predicate.ts", "caps.ts", "execution-wiring.ts", "preclaim.ts", "carve.ts"];
    for (const file of files) {
      const source = readFileSync(join(sourceDir, file), "utf8");
      for (const pkg of forbidden) {
        expect(source.includes(pkg), `${file} must not import ${pkg}`).toBe(false);
      }
    }
  });
});
