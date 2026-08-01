// SPDX-License-Identifier: Apache-2.0

import type { DerivationLogger, DerivationStrategy, SupplyPool } from "@jinn-network/task-derivation";
import type {
  ChainAdmissionCandidate,
  ChainAdmissionReceiptV1,
  ChainAdmissionRefusalCode,
  ChainAdmissionResult,
} from "@jinn-network/task-admission";
import { digestsEqual, type Sha256Digest } from "./digest.js";
import { ScenarioError, type ScenarioErrorCategory } from "./errors.js";
import {
  buildScenarioEvaluationSpec,
  buildSealedScenarioTask,
  type SealedEvaluationSpec,
  type SealedScenarioTask,
} from "./seal-pair.js";
import { sealReferenceScript } from "./solution-script.js";
import type { ChainDerivationEnvironment, ChainScenarioCandidate } from "./template.js";

export interface ChainAdmissionRequest {
  readonly candidateId: string;
  readonly candidate: ChainAdmissionCandidate;
  readonly environmentCompositeDigest: Sha256Digest;
}

/**
 * The admission surface, as a port. This package never calls `admitChainCandidate` or
 * `sealChainReceipt` directly: both take injected deps and a signer, and binding them is
 * the composing application's job (program ruling R4). This package therefore holds no key
 * material and opens no socket.
 */
export interface ChainAdmissionPort {
  admit(request: ChainAdmissionRequest): Promise<ChainAdmissionResult>;
  publishReceipt(receipt: ChainAdmissionReceiptV1): Promise<{ readonly digest: Sha256Digest }>;
}

export interface ChainDerivationDeps {
  readonly admission: ChainAdmissionPort;
  readonly pool: SupplyPool;
  readonly logger?: DerivationLogger;
}

export interface WrittenPair {
  readonly candidateId: string;
  readonly taskDigest: Sha256Digest;
  readonly evaluationSpecDigest: Sha256Digest;
  readonly receiptDigest: Sha256Digest;
}

export interface RefusedCandidate {
  readonly candidateId: string;
  readonly code: ChainAdmissionRefusalCode;
}

export interface FailedCandidate {
  readonly candidateId: string;
  readonly reason: ScenarioErrorCategory;
  readonly message: string;
}

export interface ChainPoolWriteSummary {
  readonly strategyId: string;
  readonly environmentRecordDigest: Sha256Digest;
  readonly written: readonly WrittenPair[];
  readonly refused: readonly RefusedCandidate[];
  readonly failed: readonly FailedCandidate[];
}

function toChainAdmissionCandidate(
  candidate: ChainScenarioCandidate,
  spec: SealedEvaluationSpec,
  task: SealedScenarioTask,
  referenceScriptDigest: Sha256Digest,
): ChainAdmissionCandidate {
  return {
    taskDocumentDigest: task.digest as `sha256:${string}`,
    statementDigest: candidate.sourceCommitment as `sha256:${string}`,
    referenceScriptDigest: referenceScriptDigest as `sha256:${string}`,
    evaluationSpecBytes: spec.bytes,
    evalSemanticsVersion: candidate.predicateBlock.predicateSemanticsVersion,
  };
}

function assertReceiptIsAboutThisPair(
  receipt: ChainAdmissionReceiptV1,
  task: SealedScenarioTask,
  spec: SealedEvaluationSpec,
  env: ChainDerivationEnvironment,
  referenceScriptDigest: Sha256Digest,
): void {
  const bindings: readonly (readonly [string, string, string])[] = [
    ["task.documentDigest", receipt.task.documentDigest, task.digest],
    ["task.evaluationSpecDigest", receipt.task.evaluationSpecDigest, spec.digest],
    ["environment.compositeRecordDigest", receipt.environment.compositeRecordDigest, env.recordDigest],
    ["referenceScriptDigest", receipt.referenceScriptDigest, referenceScriptDigest],
  ];
  for (const [field, received, expected] of bindings) {
    if (!digestsEqual(received, expected)) {
      throw new ScenarioError(
        "receipt-mismatch",
        `receipt ${field} ${received} is not this pair's ${expected}, so the receipt is about `
          + "something else and the pair does not get written.",
      );
    }
  }
}

export async function runChainScenarioDerivation<TInputs>(
  deps: ChainDerivationDeps,
  strategy: DerivationStrategy<TInputs, ChainScenarioCandidate, ChainDerivationEnvironment>,
  env: ChainDerivationEnvironment,
  inputs: TInputs,
): Promise<ChainPoolWriteSummary> {
  const written: WrittenPair[] = [];
  const refused: RefusedCandidate[] = [];
  const failed: FailedCandidate[] = [];

  for await (const candidate of strategy.derive({ logger: deps.logger }, env, inputs)) {
    try {
      const spec = buildScenarioEvaluationSpec(candidate, env);
      const task = buildSealedScenarioTask(candidate, env, spec.digest);
      const referenceSealed = sealReferenceScript(candidate.referenceScript);
      const result = await deps.admission.admit({
        candidateId: candidate.id,
        candidate: toChainAdmissionCandidate(candidate, spec, task, referenceSealed.digest),
        environmentCompositeDigest: env.recordDigest,
      });

      if ("refusal" in result) {
        const { code } = result.refusal;
        refused.push({ candidateId: candidate.id, code });
        deps.logger?.candidateRefused({ candidateId: candidate.id, code });
        continue;
      }

      const { receipt } = result;
      assertReceiptIsAboutThisPair(receipt, task, spec, env, referenceSealed.digest);

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
          kind: "synthetic" as const,
          sourceCommitment: candidate.sourceCommitment,
          lineage: candidate.lineage,
        },
        rights: { sourceLicense: candidate.rights.sourceLicense },
      });

      written.push({
        candidateId: candidate.id,
        taskDigest: task.digest,
        evaluationSpecDigest: spec.digest,
        receiptDigest: recorded.receiptDigest,
      });
      deps.logger?.pairWritten({ candidateId: candidate.id, taskDigest: task.digest });
    } catch (error) {
      if (!(error instanceof ScenarioError)) throw error;
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
