// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { MarketplaceChainConfig, TwoPartyEngagement } from "@jinn-network/marketplace-binding";
import {
  createMarketplaceProjectionState,
  projectReorgObservation,
  type DerivationAnnotation,
} from "@jinn-network/marketplace-projector";
import { TaskExecutionError, type AttemptUri, type SubmissionUri } from "@jinn-network/task-execution-backend";
import { documentDigest, type ProtocolObservation } from "@jinn-network/task-execution-protocol";
import type { ChainLogSource } from "../log-source/chain-log-source.js";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import { createProjectorObservePort } from "./projector-observe.js";

const CHAIN: MarketplaceChainConfig = {
  chainId: 84532,
  taskCoordinator: "0x1111111111111111111111111111111111111111",
  jinnRouter: "0x2222222222222222222222222222222222222222",
  mechMarketplace: "0x3333333333333333333333333333333333333333",
  activityChecker: "0x4444444444444444444444444444444444444444",
  generation: "revised",
};

const SOURCE = "urn:jinn:marketplace-projector:eip155:84532:0x1111111111111111111111111111111111111111";
const TASK_DIGEST = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
const ATTEMPT_A = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as AttemptUri;
const ATTEMPT_B = "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as AttemptUri;
const SUBMISSION_A = "urn:uuid:cccccccc-cccc-4ccc-8ccc-cccccccccccc" as SubmissionUri;
const SUBMISSION_B = "urn:uuid:dddddddd-dddd-4ddd-8ddd-dddddddddddd" as SubmissionUri;

function derivation(overrides: Partial<DerivationAnnotation> = {}): DerivationAnnotation {
  return {
    chainId: 84532,
    contract: CHAIN.taskCoordinator,
    event: "TaskAttemptCreated",
    blockNumber: 100,
    blockHash: `0x${"2".repeat(64)}`,
    txHash: `0x${"3".repeat(64)}`,
    logIndex: 1,
    finalityTier: "safe",
    contractGeneration: "revised",
    ...overrides,
  };
}

function engagedObservation(input: {
  readonly attempt: AttemptUri;
  readonly submission: SubmissionUri;
  readonly sequence: string;
  readonly derivation: DerivationAnnotation;
  readonly annotations?: Record<string, unknown>;
}): ProtocolObservation {
  return {
    specversion: "1.0",
    id: `${input.attempt}:engaged`,
    source: SOURCE,
    subject: input.attempt,
    time: "2026-07-30T00:00:00.000Z",
    datacontenttype: "application/json",
    sequence: input.sequence,
    taskdigest: TASK_DIGEST,
    derivation: input.derivation,
    type: "network.jinn.task-execution.attempt-engaged.v1",
    data: {
      attempt: input.attempt,
      task: TASK_DIGEST,
      submission: input.submission,
      executor: "0x9999999999999999999999999999999999999999",
      effectiveDeadline: "2026-08-30T00:00:00.000Z",
      source: SOURCE,
      dispatchContext: { uri: "urn:jinn:marketplace:dispatch-context:x", digest: { sha256: "8".repeat(64) } },
      ...(input.annotations !== undefined ? { annotations: input.annotations } : {}),
    },
  } as ProtocolObservation;
}

function progressObservation(
  attempt: AttemptUri,
  sequence: string,
  derivationOverrides: Partial<DerivationAnnotation> = {},
): ProtocolObservation {
  return {
    specversion: "1.0",
    id: `${attempt}:progress:${sequence}`,
    source: SOURCE,
    subject: attempt,
    time: "2026-07-30T00:01:00.000Z",
    datacontenttype: "application/json",
    sequence,
    derivation: derivation(derivationOverrides),
    type: "network.jinn.task-execution.progress.v1",
    data: { fraction: 0.5 },
  } as ProtocolObservation;
}

function fakeLogSource(orphaned: ReadonlySet<string> = new Set()): ChainLogSource {
  return {
    poll: () => Promise.reject(new Error("not used in this test")),
    cursor: () => undefined,
    finalizedCheckpoint: () => undefined,
    logsInRange: () => Promise.resolve([]),
    orphanedBlockHashes: () => orphaned,
    close: () => undefined,
  };
}

let root: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-projector-observe-"));
  state = openVenueState(join(root, "venue.db"));
});

afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

describe("createProjectorObservePort (design §7, Task 16 -- retires the in-memory stub)", () => {
  test("observe(attemptUri) folds only observations for that Attempt and the cursor advances monotonically", async () => {
    const engagedA = engagedObservation({
      attempt: ATTEMPT_A, submission: SUBMISSION_A, sequence: "0000000000000001", derivation: derivation(),
    });
    const engagedB = engagedObservation({
      attempt: ATTEMPT_B, submission: SUBMISSION_B, sequence: "0000000000000001",
      derivation: derivation({ blockNumber: 200, blockHash: `0x${"9".repeat(64)}`, txHash: `0x${"8".repeat(64)}` }),
    });
    let fixture: ProtocolObservation[] = [engagedA, engagedB];
    const port = createProjectorObservePort({
      chain: CHAIN, state, logSource: fakeLogSource(), observations: async () => fixture,
    });

    const first = await port.observe(ATTEMPT_A);
    expect(first.descriptor.attempt).toBe(ATTEMPT_A);
    expect(first.observations.every((observation) => observation.subject === ATTEMPT_A)).toBe(true);
    expect(first.cursor.sequence).toBe("0000000000000001");

    fixture = [...fixture, progressObservation(ATTEMPT_A, "0000000000000002")];
    const second = await port.observe(ATTEMPT_A);
    expect(second.observations).toHaveLength(2);
    expect(second.cursor.sequence).toBe("0000000000000002");
  });

  test("an observation on an orphaned block is excluded -- a reorged claim never presents as a live attempt", async () => {
    const engaged = engagedObservation({
      attempt: ATTEMPT_A, submission: SUBMISSION_A, sequence: "0000000000000001", derivation: derivation(),
    });
    const orphanedBlockHash = `0x${"5".repeat(64)}` as const;
    const orphanedFact = progressObservation(ATTEMPT_A, "0000000000000002", { blockHash: orphanedBlockHash });
    const port = createProjectorObservePort({
      chain: CHAIN, state, logSource: fakeLogSource(new Set([orphanedBlockHash])),
      observations: async () => [engaged, orphanedFact],
    });

    const snapshot = await port.observe(ATTEMPT_A);

    expect(snapshot.observations.map((observation) => observation.id)).toEqual([engaged.id]);
  });

  test("an explicit lost correction for an orphaned terminal is retained, folding the Attempt to lost", async () => {
    const engaged = engagedObservation({
      attempt: ATTEMPT_A, submission: SUBMISSION_A, sequence: "0000000000000001", derivation: derivation(),
    });
    const orphanedTerminalDerivation = derivation({
      event: "VerdictDeliveryClaimed", blockNumber: 150,
      blockHash: `0x${"6".repeat(64)}`, txHash: `0x${"7".repeat(64)}`, logIndex: 2,
    });
    const orphanedTerminal: ProtocolObservation = {
      specversion: "1.0",
      id: "verdict-1",
      source: SOURCE,
      subject: ATTEMPT_A,
      time: "2026-07-30T00:02:00.000Z",
      datacontenttype: "application/json",
      sequence: "0000000000000002",
      derivation: orphanedTerminalDerivation,
      type: "network.jinn.task-execution.attempt-terminal.v1",
      data: { state: "delivered" },
    } as ProtocolObservation;
    const corrected = projectReorgObservation({
      priorObservation: orphanedTerminal,
      derivation: orphanedTerminalDerivation,
      reorgedBlockHash: orphanedTerminalDerivation.blockHash,
      timestamp: "2026-07-30T00:03:00.000Z",
      state: createMarketplaceProjectionState(),
    });
    const lost = corrected.observation;
    if (lost === undefined) throw new Error("expected a lost correction observation");

    const port = createProjectorObservePort({
      chain: CHAIN, state, logSource: fakeLogSource(new Set([orphanedTerminalDerivation.blockHash])),
      observations: async () => [engaged, orphanedTerminal, lost],
    });

    const snapshot = await port.observe(ATTEMPT_A);

    expect(snapshot.descriptor.derived).toMatchObject({ state: "lost", terminal: true, contradictory: false });
  });

  test("observe(submissionUri) resolves through the recorded scope's engagement to the same Attempt", async () => {
    const engaged = engagedObservation({
      attempt: ATTEMPT_A, submission: SUBMISSION_A, sequence: "0000000000000001", derivation: derivation(),
    });
    const port = createProjectorObservePort({
      chain: CHAIN, state, logSource: fakeLogSource(), observations: async () => [engaged],
    });
    const submissionBytes = new TextEncoder().encode("submission-a");
    const claim = await port.claimSubmissionScope({
      requester: "0xrequester1111111111111111111111111111111",
      idempotencyKey: "idem-1",
      submissionUri: SUBMISSION_A,
      digest: documentDigest(submissionBytes),
      submissionBytes,
      taskDigest: TASK_DIGEST,
      creatorSafe: "0x1111111111111111111111111111111111111111",
      venueNamespace: "test:venue",
      commandDigest: `sha256:${"d".repeat(64)}`,
      postingIntentKey: `0x1111111111111111111111111111111111111111|${TASK_DIGEST}|${documentDigest(submissionBytes)}`,
    });
    if (claim.kind !== "owner") throw new Error("expected owner");
    const engagement: TwoPartyEngagement = {
      attemptUri: ATTEMPT_A,
      dispatchContext: { taskDigest: TASK_DIGEST, submission: SUBMISSION_A, nonce: "1", attempt: ATTEMPT_A },
    };
    await port.resolveSubmissionScope({
      taskDigest: TASK_DIGEST,
      submissionDigest: documentDigest(submissionBytes),
      submissionBytes,
      submission: { requester: "0xrequester1111111111111111111111111111111", idempotencyKey: "idem-1" },
      outcome: { taskId: 1n, txHash: `0x${"e".repeat(64)}` as `0x${string}` },
      engagement,
    }, claim.ownerToken);

    const snapshot = await port.observe(SUBMISSION_A);

    expect(snapshot.descriptor.attempt).toBe(ATTEMPT_A);
  });

  // Defect #48. Attempt URIs and Submission URIs share the `urn:uuid:` shape, so a ref can only be
  // classified by what the log says about it -- and observations ARE emitted against a Submission
  // subject (`submission-closed.v1`, from `TaskAttemptCreated`'s capacity close and from
  // `VerdictDeliveryClaimed`). The subject-identity branch used to run first and swallowed the ref,
  // so a requester adopting a closed task got `attempt-not-found` for an Attempt that was engaged,
  // delivered and judged.
  test("observe(submissionUri) resolves to the engaged Attempt even when the Submission is itself an observation subject", async () => {
    const engaged = engagedObservation({
      attempt: ATTEMPT_A, submission: SUBMISSION_A, sequence: "0000000000000002", derivation: derivation(),
    });
    const submissionClosed = {
      specversion: "1.0",
      id: `${SUBMISSION_A}:closed`,
      source: SOURCE,
      subject: SUBMISSION_A,
      time: "2026-07-30T00:00:30.000Z",
      datacontenttype: "application/json",
      sequence: "0000000000000001",
      taskdigest: TASK_DIGEST,
      derivation: derivation({ event: "VerdictDeliveryClaimed" }),
      type: "network.jinn.task-execution.submission-closed.v1",
      data: { reason: "capacity" },
    } as unknown as ProtocolObservation;
    const port = createProjectorObservePort({
      chain: CHAIN, state, logSource: fakeLogSource(), observations: async () => [submissionClosed, engaged],
    });

    const snapshot = await port.observe(SUBMISSION_A);

    expect(snapshot.descriptor.attempt).toBe(ATTEMPT_A);
    expect(snapshot.descriptor.submission).toBe(SUBMISSION_A);
  });

  test("observe on an unknown ref throws TaskExecutionError(\"attempt-not-found\")", async () => {
    const port = createProjectorObservePort({
      chain: CHAIN, state, logSource: fakeLogSource(), observations: async () => [],
    });

    try {
      await port.observe("urn:uuid:00000000-0000-4000-8000-000000000000" as AttemptUri);
      throw new Error("expected observe to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskExecutionError);
      expect((error as TaskExecutionError).category).toBe("attempt-not-found");
    }
  });

  describe("recover", () => {
    async function resolvedScope(port: ReturnType<typeof createProjectorObservePort>, input: {
      readonly requester: string;
      readonly idempotencyKey: string;
      readonly submission: SubmissionUri;
      readonly attempt: AttemptUri;
    }): Promise<void> {
      const submissionBytes = new TextEncoder().encode(input.idempotencyKey);
      const claim = await port.claimSubmissionScope({
        requester: input.requester,
        idempotencyKey: input.idempotencyKey,
        submissionUri: input.submission,
        digest: documentDigest(submissionBytes),
        submissionBytes,
        taskDigest: TASK_DIGEST,
        creatorSafe: "0x1111111111111111111111111111111111111111",
        venueNamespace: "test:venue",
        commandDigest: `sha256:${"d".repeat(64)}`,
        postingIntentKey: `0x1111111111111111111111111111111111111111|${TASK_DIGEST}|${documentDigest(submissionBytes)}`,
      });
      if (claim.kind !== "owner") throw new Error("expected owner");
      await port.resolveSubmissionScope({
        taskDigest: TASK_DIGEST,
        submissionDigest: documentDigest(submissionBytes),
        submissionBytes,
        submission: { requester: input.requester, idempotencyKey: input.idempotencyKey },
        outcome: { taskId: 1n, txHash: `0x${"e".repeat(64)}` as `0x${string}` },
        engagement: {
          attemptUri: input.attempt,
          dispatchContext: { taskDigest: TASK_DIGEST, submission: input.submission, nonce: "1", attempt: input.attempt },
        },
      }, claim.ownerToken);
    }

    test("returns matching when the chain-derived fold agrees with the durable scope record", async () => {
      const engaged = engagedObservation({
        attempt: ATTEMPT_A, submission: SUBMISSION_A, sequence: "0000000000000001", derivation: derivation(),
      });
      const port = createProjectorObservePort({
        chain: CHAIN, state, logSource: fakeLogSource(), observations: async () => [engaged],
      });
      await resolvedScope(port, {
        requester: "0xrequester1111111111111111111111111111111", idempotencyKey: "idem-a",
        submission: SUBMISSION_A, attempt: ATTEMPT_A,
      });

      expect(await port.recover(SUBMISSION_A)).toEqual({ classification: "matching" });
    });

    test("returns absent when the scope exists but the chain shows no attempt", async () => {
      const port = createProjectorObservePort({
        chain: CHAIN, state, logSource: fakeLogSource(), observations: async () => [],
      });
      await resolvedScope(port, {
        requester: "0xrequester2222222222222222222222222222222", idempotencyKey: "idem-b",
        submission: SUBMISSION_B, attempt: ATTEMPT_B,
      });

      const report = await port.recover(SUBMISSION_B);

      expect(report.classification).toBe("absent");
    });

    test("returns contradictory when the chain shows an attempt bound to a different Submission", async () => {
      const otherSubmission = "urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff" as SubmissionUri;
      const engagedForOtherSubmission = engagedObservation({
        attempt: ATTEMPT_A, submission: otherSubmission, sequence: "0000000000000001", derivation: derivation(),
      });
      const port = createProjectorObservePort({
        chain: CHAIN, state, logSource: fakeLogSource(), observations: async () => [engagedForOtherSubmission],
      });
      await resolvedScope(port, {
        requester: "0xrequester3333333333333333333333333333333", idempotencyKey: "idem-c",
        submission: SUBMISSION_A, attempt: ATTEMPT_A,
      });

      const report = await port.recover(SUBMISSION_A);

      expect(report.classification).toBe("contradictory");
    });
  });

  test("drive appends host-supplied observations without rewriting chain-derived ones", async () => {
    const engaged = engagedObservation({
      attempt: ATTEMPT_A, submission: SUBMISSION_A, sequence: "0000000000000001", derivation: derivation(),
    });
    const fixture: ProtocolObservation[] = [engaged];
    const port = createProjectorObservePort({
      chain: CHAIN, state, logSource: fakeLogSource(), observations: async () => fixture,
    });
    const before = await port.observe(ATTEMPT_A);
    expect(before.observations).toHaveLength(1);

    await port.drive(ATTEMPT_A, [progressObservation(ATTEMPT_A, "0000000000000002")]);

    const after = await port.observe(ATTEMPT_A);
    expect(after.observations).toHaveLength(2);
    expect(fixture).toHaveLength(1);
  });

  test("simulateReconciliation overrides the next recover result for exactly one call", async () => {
    const engaged = engagedObservation({
      attempt: ATTEMPT_A, submission: SUBMISSION_A, sequence: "0000000000000001", derivation: derivation(),
    });
    const port = createProjectorObservePort({
      chain: CHAIN, state, logSource: fakeLogSource(), observations: async () => [engaged],
    });

    port.simulateReconciliation(ATTEMPT_A, { classification: "contradictory", detail: "forced" });
    expect(await port.recover(ATTEMPT_A)).toEqual({ classification: "contradictory", detail: "forced" });
    expect(await port.recover(ATTEMPT_A)).toEqual({ classification: "matching" });
  });
});
