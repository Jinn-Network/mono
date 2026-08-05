import { BENCHMARKING_CELL_EXTENSION } from "./cell-authority.js";
import { describeOrderingConformance } from "@jinn-network/benchmarking-testing";
import { deriveMarketplaceAttemptUri } from "@jinn-network/marketplace-binding";
import { createMarketplaceProjectionState } from "@jinn-network/marketplace-projector";
import { sealSubmission } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import type { AuthorityProjection } from "./authority-projection.js";
import {
  AnchoredOrderingViolationError,
  buildAnchoredOrderingTranscript,
  deriveEarliestCellPostAt,
  deriveRunDigestAnchorAt,
  enforceAnchoredOrderingGate,
} from "./ordering-leg-b.js";

const RUN_DIGEST = `sha256:${"a".repeat(64)}` as const;
const COORDINATOR = "0x1111111111111111111111111111111111111111" as const;
const ATTEMPT = deriveMarketplaceAttemptUri({
  chainId: 84532,
  coordinator: COORDINATOR,
  taskId: 42n,
  attemptIndex: 0,
});
const TASK_DIGEST = "7777777777777777777777777777777777777777777777777777777777777777";
const SUBMISSION_URN = "urn:uuid:11111111-1111-4111-8111-111111111111";

function sealedSubmissionBytes() {
  const doc = {
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: SUBMISSION_URN,
    task: { digest: { sha256: TASK_DIGEST } },
    requester: "urn:uuid:20000000-0000-5000-8000-000000000002",
    nonce: "ordering-test",
    idempotencyKey: "ordering/test/1",
    deadline: "2026-08-04T00:00:00Z",
    requirements: { isolationPolicy: "fixture" },
    [BENCHMARKING_CELL_EXTENSION]: {
      run: RUN_DIGEST,
      cellKey: `${TASK_DIGEST}/armA/1`,
      armId: "armA",
    },
  };
  return sealSubmission(doc);
}

function projectionWithMaterialTimes(input: {
  runAnchorTime: string;
  cellPostTime: string;
}): { projection: AuthorityProjection; material: { sealedSubmissionBytes: () => Uint8Array } } {
  const bytes = sealedSubmissionBytes();
  const projection: AuthorityProjection = {
    observations: [{
      specversion: "1.0",
      id: "submission-accepted",
      source: "urn:jinn:backend:marketplace",
      subject: SUBMISSION_URN,
      time: input.runAnchorTime,
      datacontenttype: "application/json",
      sequence: "0000000000000001",
      type: "network.jinn.task-execution.submission-accepted.v1",
      data: {
        submission: SUBMISSION_URN,
        task: `sha256:${TASK_DIGEST}`,
      },
      derivation: {
        chainId: 84532,
        contract: COORDINATOR,
        event: "TaskCreated",
        blockNumber: 100,
        blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        logIndex: 0,
        finalityTier: "finalized",
        contractGeneration: "revised",
      },
    }, {
      specversion: "1.0",
      id: "attempt-obs",
      source: "urn:jinn:backend:marketplace",
      subject: ATTEMPT,
      time: input.cellPostTime,
      datacontenttype: "application/json",
      sequence: "0000000000000002",
      type: "network.jinn.task-execution.attempt-engaged.v1",
      data: {
        attempt: ATTEMPT,
        task: `sha256:${TASK_DIGEST}`,
        submission: SUBMISSION_URN,
        executor: "0x3333333333333333333333333333333333333333",
        effectiveDeadline: "2026-08-04T00:00:00Z",
        source: "urn:jinn:backend:marketplace",
        dispatchContext: {
          uri: "urn:jinn:marketplace:dispatch-context:42:0",
          digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
        },
        annotations: {
          requestId: `0x${"4".repeat(64)}`,
          [BENCHMARKING_CELL_EXTENSION]: {
            run: RUN_DIGEST,
            cellKey: `${TASK_DIGEST}/armA/1`,
            armId: "armA",
          },
        },
      },
      derivation: {
        chainId: 84532,
        contract: COORDINATOR,
        event: "TaskAttemptCreated",
        blockNumber: 101,
        blockHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
        txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        logIndex: 1,
        finalityTier: "finalized",
        contractGeneration: "revised",
      },
    }],
    events: [],
    state: createMarketplaceProjectionState(),
  };
  return {
    projection,
    material: {
      sealedSubmissionBytes: () => bytes,
    },
  };
}

describe("enforceAnchoredOrderingGate", () => {
  test("passes when Run digest anchor precedes earliest cell post with exact bytes", async () => {
    const { projection, material } = projectionWithMaterialTimes({
      runAnchorTime: "2026-08-03T09:00:00Z",
      cellPostTime: "2026-08-03T09:00:01Z",
    });
    const transcript = await enforceAnchoredOrderingGate({
      projection,
      runDigest: RUN_DIGEST,
      material,
    });
    expect(transcript.check.ok).toBe(true);
    expect(transcript.runDigestAnchorAt).toBe("2026-08-03T09:00:00Z");
    expect(transcript.earliestCellPostAt).toBe("2026-08-03T09:00:01Z");
  });

  test("allows equality between Run digest anchor and earliest cell post", async () => {
    const { projection, material } = projectionWithMaterialTimes({
      runAnchorTime: "2026-08-03T09:00:00Z",
      cellPostTime: "2026-08-03T09:00:00Z",
    });
    await expect(enforceAnchoredOrderingGate({
      projection,
      runDigest: RUN_DIGEST,
      material,
    })).resolves.toMatchObject({ check: { ok: true } });
  });

  test("throws before assembly on ordering violation", async () => {
    const { projection, material } = projectionWithMaterialTimes({
      runAnchorTime: "2026-08-03T09:00:02Z",
      cellPostTime: "2026-08-03T09:00:01Z",
    });
    await expect(enforceAnchoredOrderingGate({
      projection,
      runDigest: RUN_DIGEST,
      material,
    })).rejects.toThrow(AnchoredOrderingViolationError);
  });

  test("throws when exact Submission bytes are missing", async () => {
    const { projection } = projectionWithMaterialTimes({
      runAnchorTime: "2026-08-03T09:00:00Z",
      cellPostTime: "2026-08-03T09:00:01Z",
    });
    await expect(enforceAnchoredOrderingGate({
      projection,
      runDigest: RUN_DIGEST,
    })).rejects.toThrow(AnchoredOrderingViolationError);
  });
});

describe("deriveRunDigestAnchorAt / deriveEarliestCellPostAt", () => {
  test("ignore observations for other Run digests", async () => {
    const { projection, material } = projectionWithMaterialTimes({
      runAnchorTime: "2026-08-03T09:00:01Z",
      cellPostTime: "2026-08-03T09:00:01Z",
    });
    expect(await deriveRunDigestAnchorAt({
      projection,
      runDigest: `sha256:${"b".repeat(64)}`,
      material,
    })).toBeUndefined();
    expect(await deriveEarliestCellPostAt({
      projection,
      runDigest: `sha256:${"b".repeat(64)}`,
      material,
    })).toBeUndefined();
  });
});

describe("ordering leg (b) kit conformance", () => {
  describeOrderingConformance({
    anchored: {
      runAnnouncedAt: "2026-08-03T09:00:00Z",
      earliestCellPostAt: "2026-08-03T09:00:01Z",
      violatesOrder: false,
    },
  });
});

describe("buildAnchoredOrderingTranscript", () => {
  test("returns evidence only after gate pass", () => {
    const transcript = buildAnchoredOrderingTranscript({
      runDigestAnchorAt: "2026-08-03T09:00:00Z",
      earliestCellPostAt: "2026-08-03T09:00:01Z",
      check: { ok: true },
    });
    expect(transcript.runDigestAnchorAt).toBe("2026-08-03T09:00:00Z");
    expect(transcript.check.ok).toBe(true);
  });
});
