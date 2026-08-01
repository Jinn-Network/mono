// SPDX-License-Identifier: Apache-2.0

import type {
  AdmissionCandidate,
  AdmissionRefusalCode,
  AdmissionResult,
  DifferentialAdmissionReceiptV3,
} from "@jinn-network/task-admission";
import type { Candidate } from "./candidate.js";
import { assertCandidate } from "./candidate.js";
import { digestsEqual, type Sha256Digest } from "./digest.js";
import { DerivationError, type DerivationErrorCategory } from "./errors.js";
import type { GoldRef, GoldStore } from "./gold.js";
import { compareCodeUnitStrings } from "./order.js";
import type { SupplyPool } from "./pool.js";
import {
  buildCandidateEvaluationSpec,
  buildSealedTask,
  type SealedEvaluationSpec,
  type SealedTask,
} from "./seal-pair.js";
import { computeSourceCommitment, statementDigest } from "./source-commitment.js";
import type { DerivationEnvironment, DerivationLogger, DerivationStrategy } from "./strategy.js";

/**
 * One admission request. `candidateId` rides beside the candidate because C3's
 * `AdmissionCandidate` carries no human-facing identifier at all — it is digests, transitions
 * and sealed bytes (admission is source-agnostic by construction, and an upstream instance id
 * is source information). Derivation still needs to name the candidate in its own summary and
 * logs, so the id travels in the envelope rather than being smuggled into a foreign type.
 */
export interface AdmissionRequest {
  readonly candidateId: string;
  readonly candidate: AdmissionCandidate;
  readonly environmentRecordBytes: Uint8Array;
}

/**
 * The admission surface, as a port. C4 never calls `admitCandidate` or `sealReceipt`
 * directly: both take injected deps and a signer, and binding them is the composing
 * application's job (design §3.1, program ruling R4). This package therefore holds no key
 * material.
 */
export interface AdmissionPort {
  admit(request: AdmissionRequest): Promise<AdmissionResult>;
  /** Seals the receipt and persists it, returning the digest the pool entry cites. */
  publishReceipt(receipt: DifferentialAdmissionReceiptV3): Promise<{ readonly digest: Sha256Digest }>;
}

export interface DerivationDeps {
  readonly admission: AdmissionPort;
  readonly pool: SupplyPool;
  readonly goldStore: GoldStore;
  readonly logger?: DerivationLogger;
}

export interface WrittenPair {
  readonly candidateId: string;
  readonly taskDigest: Sha256Digest;
  readonly evaluationSpecDigest: Sha256Digest;
  readonly receiptDigest: Sha256Digest;
}

/**
 * An admission refusal: a first-class outcome, summarized and discarded (design §7.2).
 *
 * `code` keeps C3's closed refusal taxonomy rather than widening it to `string` — a consumer
 * routes on these codes, so a value outside the union would be a contract change made silently.
 */
export interface RefusedCandidate {
  readonly candidateId: string;
  readonly code: AdmissionRefusalCode;
}

export interface FailedCandidate {
  readonly candidateId: string;
  readonly reason: DerivationErrorCategory;
  readonly message: string;
}

export interface PoolWriteSummary {
  readonly strategyId: string;
  readonly environmentRecordDigest: Sha256Digest;
  readonly written: readonly WrittenPair[];
  readonly refused: readonly RefusedCandidate[];
  readonly failed: readonly FailedCandidate[];
}

/**
 * A test node id names the repository file before `::`. Admission runs the environment's test
 * command against *paths*, so the declared transitions are what determine which paths a
 * candidate needs run — deduplicated and code-unit ordered so the request is stable.
 */
function testPathsOf(candidate: Candidate): string[] {
  const paths = new Set<string>();
  for (const nodeId of [...candidate.transitions.failToPass, ...candidate.transitions.passToPass]) {
    const separator = nodeId.indexOf("::");
    const path = separator === -1 ? nodeId : nodeId.slice(0, separator);
    if (path.length > 0) paths.add(path);
  }
  return [...paths].sort(compareCodeUnitStrings);
}

/**
 * The single place C3's candidate shape appears (planning Finding (b)). The EvaluationSpec
 * bytes handed over are the sealed ones, so the inline image/platform/parser admission
 * compares against the record are the record's own values (Task 6).
 *
 * The plan assumed a candidate carrying `instanceId`, an inline `statement`, the parsed spec
 * and the gold *bytes*. The symbol on `supply/c3-task-admission` carries none of those: it is
 * `{taskDocumentDigest, statementDigest, testMaterialDigests, transitions, goldPatchHash,
 * evaluationSpecBytes, testPaths, evalSemanticsVersion}` — digests and sealed bytes only,
 * because admission never holds patch content. Two consequences, both confined here and to
 * `runDerivation`'s ordering: the Task is sealed BEFORE admission (its digest is a candidate
 * field), and the candidate id travels in `AdmissionRequest` rather than in the candidate.
 */
function toAdmissionCandidate(
  candidate: Candidate,
  spec: SealedEvaluationSpec,
  task: SealedTask,
  gold: GoldRef,
): AdmissionCandidate {
  return {
    taskDocumentDigest: task.digest,
    statementDigest: statementDigest(candidate.statement),
    testMaterialDigests: candidate.testMaterial.map((material) => material.digest),
    transitions: {
      failToPass: [...candidate.transitions.failToPass],
      passToPass: [...candidate.transitions.passToPass],
    },
    goldPatchHash: gold.goldPatchHash,
    evaluationSpecBytes: spec.bytes,
    testPaths: testPathsOf(candidate),
    evalSemanticsVersion: spec.document.semanticsVersion,
  };
}

/**
 * Every binding by which a receipt names the pair it is about, checked before that receipt is
 * published and cited.
 *
 * The port is a foreign adapter owned by the composing application (program ruling R4) and may
 * be remote, so its answer is data, not truth: a stale, swapped or buggy response would
 * otherwise be written straight into `PoolEntry.receiptDigest` — the pinned field (R5) every
 * downstream consumer joins on to claim this pair earned a receipt. Gold is checked separately
 * and keeps its own category, because the stored gold, not the sealed pair, is what it binds to.
 */
function assertReceiptIsAboutThisPair(
  receipt: DifferentialAdmissionReceiptV3,
  task: SealedTask,
  spec: SealedEvaluationSpec,
  env: DerivationEnvironment,
): void {
  const bindings: readonly (readonly [string, string, string])[] = [
    ["task.documentDigest", receipt.task.documentDigest, task.digest],
    ["task.evaluationSpecDigest", receipt.task.evaluationSpecDigest, spec.digest],
    ["environment.recordDigest", receipt.environment.recordDigest, env.recordDigest],
  ];
  for (const [field, received, expected] of bindings) {
    if (!digestsEqual(received, expected)) {
      throw new DerivationError(
        "receipt-mismatch",
        `receipt ${field} ${received} is not this pair's ${expected}, so the receipt is about `
          + "something else and the pair does not get written.",
      );
    }
  }
}

/**
 * Pipes a strategy's candidates through admission and writes the survivors to the pool as
 * sealed pairs.
 *
 * A `DerivationError` on one candidate becomes a `failed` row and the run continues;
 * anything else propagates, so a port outage aborts loudly instead of producing a summary
 * full of spurious failures.
 */
export async function runDerivation<TInputs>(
  deps: DerivationDeps,
  strategy: DerivationStrategy<TInputs>,
  env: DerivationEnvironment,
  inputs: TInputs,
): Promise<PoolWriteSummary> {
  const written: WrittenPair[] = [];
  const refused: RefusedCandidate[] = [];
  const failed: FailedCandidate[] = [];

  for await (const candidate of strategy.derive({ logger: deps.logger }, env, inputs)) {
    try {
      assertCandidate(candidate);

      const spec = buildCandidateEvaluationSpec(candidate, env);
      const task = buildSealedTask(candidate, env, spec.digest);
      const gold = await deps.goldStore.put(candidate.goldPatch);
      const result = await deps.admission.admit({
        candidateId: candidate.id,
        candidate: toAdmissionCandidate(candidate, spec, task, gold),
        environmentRecordBytes: env.recordBytes,
      });

      if ("refusal" in result) {
        const { code } = result.refusal;
        refused.push({ candidateId: candidate.id, code });
        deps.logger?.candidateRefused({ candidateId: candidate.id, code });
        continue;
      }

      const { receipt } = result;
      if (!digestsEqual(receipt.goldPatchHash, gold.goldPatchHash)) {
        // The receipt and the stored gold must describe the same bytes; if they do not,
        // one of the two is about something else and the pair does not get written.
        throw new DerivationError(
          "gold-mismatch",
          `receipt goldPatchHash ${receipt.goldPatchHash} does not match the stored gold `
            + `${gold.goldPatchHash}.`,
        );
      }
      assertReceiptIsAboutThisPair(receipt, task, spec, env);

      const { digest: receiptDigest } = await deps.admission.publishReceipt(receipt);

      const recorded = await deps.pool.put({
        taskDigest: task.digest,
        taskBytes: task.bytes,
        evaluationSpecDigest: spec.digest,
        evaluationSpecBytes: spec.bytes,
        receiptDigest,
        environmentRecordDigest: env.recordDigest,
        strategyId: strategy.id,
        provenance: {
          kind: candidate.provenance.kind,
          sourceCommitment: computeSourceCommitment(
            candidate.provenance.upstream,
            candidate.statement,
          ),
          upstream: candidate.provenance.upstream,
        },
        rights: { sourceLicense: candidate.rights.sourceLicense },
      });

      written.push({
        candidateId: candidate.id,
        taskDigest: task.digest,
        evaluationSpecDigest: spec.digest,
        // What the pool RECORDED, not what this run published: re-putting an existing pair keeps
        // the first writer's receipt (pool.ts's conflict key excludes it), so reporting
        // `receiptDigest` here would name a receipt the entry does not cite.
        receiptDigest: recorded.receiptDigest,
      });
      deps.logger?.pairWritten({ candidateId: candidate.id, taskDigest: task.digest });
    } catch (error) {
      if (!(error instanceof DerivationError)) throw error;
      failed.push({
        candidateId: candidate.id,
        reason: error.category,
        message: error.message,
      });
    }
  }

  return {
    strategyId: strategy.id,
    environmentRecordDigest: env.recordDigest,
    written,
    refused,
    failed,
  };
}
