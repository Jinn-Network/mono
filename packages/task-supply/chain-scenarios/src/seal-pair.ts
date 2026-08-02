// SPDX-License-Identifier: Apache-2.0

import { CRYPTO_ENVIRONMENT_MEDIA_TYPE } from "@jinn-network/chain-environment-record";
import type { CryptoEnvironmentRecord } from "@jinn-network/chain-environment-record";
import {
  EVAL_SEMANTICS_VERSION,
  EVALUATION_SPEC_FORMAT_URI,
  STATE_PREDICATE_FAMILY,
  STATE_PREDICATE_RESERVED_MEASUREMENTS,
  STATE_PREDICATE_UNEVALUABLE_CLASS,
  STATE_PREDICATE_VERDICT_RULE,
  StatePredicateBlockSchema,
  TASK_PROFILE_FORMAT_URI,
  sealEvaluationSpec,
  sealTaskProfile,
  type EvaluationSpec,
  type TaskProfileDocument,
} from "@jinn-network/task-execution-profiles";
import { TASK_EXECUTION_PROTOCOL_URI, sealTask } from "@jinn-network/task-execution-protocol";

import { documentDigest, toBareHex, type Sha256Digest } from "./digest.js";
import { ScenarioError } from "./errors.js";
import { CHAIN_SOLUTION_MEDIA_TYPE } from "./solution-script.js";
import type { ChainDerivationEnvironment, ChainScenarioCandidate } from "./template.js";

/**
 * F-CE5-4: profiles reserves `repository-work/1.0` and `evaluation-task/1.0` only. This
 * document is built against profiles' schema exactly the way `buildRepositoryWorkProfile`
 * is; adding the URI to profiles' reserved list is proposed at the program review.
 */
export const CHAIN_WORK_PROFILE_URI = "https://jinn.network/task-profiles/chain-work/1.0" as const;

export const CHAIN_SCENARIO_ENVELOPE_VIOLATION_CLASS = "envelope-violation" as const;
export const CHAIN_SCENARIO_REPLAY_INFRASTRUCTURE_CLASS = "replay-infrastructure-failure" as const;
export const CHAIN_SCENARIO_MISSING_SOLUTION_SCRIPT_CLASS = "missing-solution-script" as const;

export interface SealedEvaluationSpec {
  readonly document: EvaluationSpec;
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
}

export interface SealedScenarioTask {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
}

export interface SealedScenarioPair {
  readonly evaluationSpec: SealedEvaluationSpec;
  readonly task: SealedScenarioTask;
}

export function buildChainWorkProfile(): TaskProfileDocument {
  return {
    protocol: TASK_PROFILE_FORMAT_URI,
    profile: CHAIN_WORK_PROFILE_URI,
    description:
      "Work inside a sealed sandboxed chain world: a composite environment record referenced "
      + "by digest and an instruction, delivered as a deterministic solution script that "
      + "evaluation replays on a fresh instance (design §6.4).",
    payloadSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        provenance: {
          type: "object",
          additionalProperties: true,
          properties: {
            kind: { enum: ["mined", "synthetic", "live"] },
            sourceCommitment: { type: "string" },
            lineage: { type: "object", additionalProperties: true },
          },
          required: ["kind"],
        },
        rights: { type: "object", additionalProperties: true },
      },
      required: ["provenance"],
    },
    inputConventions: {
      slots: [
        { name: "crypto-environment", required: true, descriptorMustCarry: ["digest"] },
        { name: "knowledge-packet", required: false, descriptorMustCarry: [] },
      ],
    },
    outputConventions: {
      slots: [
        { name: "solution-script", required: true, mediaType: CHAIN_SOLUTION_MEDIA_TYPE },
        { name: "summary", required: false, mediaType: "text/markdown" },
        { name: "evidence", required: false, mediaType: "application/json" },
      ],
    },
    evaluationFamilies: ["state-predicate"],
    requirementKeys: [{ key: "effort", comparisonClass: "floor" }],
  };
}

function measurementTypeForObservation(kind: string): "number" | "string" {
  return kind === "reportedValue" ? "string" : "number";
}

function resolvePinnedReplayerDescriptor(record: CryptoEnvironmentRecord, env: ChainDerivationEnvironment) {
  const replayRuntime =
    record.serviceRuntimes.find((runtime) => runtime.id === "replay")
    ?? record.serviceRuntimes[0];

  if (replayRuntime !== undefined) {
    return {
      name: replayRuntime.id,
      digest: { sha256: toBareHex(replayRuntime.image.manifestDigest, "service runtime manifestDigest") },
      accessClass: "public" as const,
    };
  }

  return {
    name: "chain-replayer",
    digest: {
      sha256: toBareHex(env.chainRecord.runtime.image.manifestDigest, "chain runtime manifestDigest"),
    },
    accessClass: "public" as const,
  };
}

export function buildScenarioEvaluationSpec(
  candidate: ChainScenarioCandidate,
  env: ChainDerivationEnvironment,
): SealedEvaluationSpec {
  const familyBlock = StatePredicateBlockSchema.parse(candidate.predicateBlock);

  const authorMeasurements = familyBlock.measurements.map((measurement) => ({
    name: measurement.name,
    type: measurementTypeForObservation(measurement.observe.kind),
    required: false,
  }));

  const reservedMeasurements = STATE_PREDICATE_RESERVED_MEASUREMENTS.map((name) => ({
    name,
    type: "boolean" as const,
    required: true,
  }));

  const document: EvaluationSpec = {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: STATE_PREDICATE_FAMILY,
    grader: resolvePinnedReplayerDescriptor(env.record, env),
    familyBlock,
    measurements: [...reservedMeasurements, ...authorMeasurements],
    verdictRule: STATE_PREDICATE_VERDICT_RULE,
    unscorable: [
      { name: CHAIN_SCENARIO_ENVELOPE_VIOLATION_CLASS, disposition: "retryable-infrastructure" },
      { name: CHAIN_SCENARIO_REPLAY_INFRASTRUCTURE_CLASS, disposition: "retryable-infrastructure" },
      { name: CHAIN_SCENARIO_MISSING_SOLUTION_SCRIPT_CLASS, disposition: "retryable-infrastructure" },
      { name: STATE_PREDICATE_UNEVALUABLE_CLASS, disposition: "recorded-inconclusive" },
    ],
    evidenceConventions: { requiredRefs: ["solution-script"] },
  };

  const { bytes, digest } = sealEvaluationSpec(document);
  return { document, bytes, digest };
}

export function buildSealedScenarioTask(
  candidate: ChainScenarioCandidate,
  env: ChainDerivationEnvironment,
  evaluationSpecDigest: Sha256Digest,
): SealedScenarioTask {
  const profile = buildChainWorkProfile();
  const profileDigest = sealTaskProfile(profile).digest;

  const outputs = profile.outputConventions.slots.map((slot) => {
    if (slot.mediaType === undefined) {
      throw new ScenarioError(
        "invalid-input",
        `chain-work output slot "${slot.name}" declares no mediaType.`,
      );
    }
    return { name: slot.name, mediaType: slot.mediaType, required: slot.required };
  });

  const task = {
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: CHAIN_WORK_PROFILE_URI,
      digest: { sha256: toBareHex(profileDigest, "chain-work profile digest") },
    },
    instructions: candidate.instructions,
    payload: {
      provenance: {
        kind: "synthetic" as const,
        sourceCommitment: candidate.sourceCommitment,
        lineage: candidate.lineage,
      },
      rights: { sourceLicense: candidate.rights.sourceLicense },
    },
    inputs: [
      {
        name: "crypto-environment",
        digest: { sha256: toBareHex(env.recordDigest, "crypto-environment record digest") },
        mediaType: CRYPTO_ENVIRONMENT_MEDIA_TYPE,
      },
    ],
    outputs,
    evaluation: {
      digest: { sha256: toBareHex(evaluationSpecDigest, "evaluation spec digest") },
    },
  };

  const bytes = sealTask(task);
  return { bytes, digest: documentDigest(bytes) };
}

export function buildSealedScenarioPair(
  candidate: ChainScenarioCandidate,
  env: ChainDerivationEnvironment,
): SealedScenarioPair {
  const evaluationSpec = buildScenarioEvaluationSpec(candidate, env);
  const task = buildSealedScenarioTask(candidate, env, evaluationSpec.digest);
  return { evaluationSpec, task };
}
