// SPDX-License-Identifier: Apache-2.0

import {
  defineEvaluatorRegistration,
  type EvaluatorRegistration,
  type ResourceDescriptor,
} from "@jinn-network/task-execution-evaluation-harness";
import type {
  DeterministicProcessBlock,
  EvaluationSpec,
  ParserIdentity,
} from "@jinn-network/task-execution-profiles";
import { parserAllowlistKey } from "@jinn-network/task-execution-profiles";
import { PREDICTION_PARSER, SWE_REBENCH_PARSER } from "./parser-identity.js";
import {
  createPredictionEvaluatorAdapter,
  type ResolutionSnapshotSource,
} from "./prediction/adapter.js";
import {
  createSweRebenchEvaluatorAdapter,
  type GraderReportSource,
} from "./swe-rebench/adapter.js";

export const SWE_REBENCH_REGISTRATION_ID = "swe-rebench-v2";
export const PREDICTION_REGISTRATION_ID = "prediction-market";

export interface EvaluatorRegistrationOptions {
  readonly evaluatorId: string;
  readonly signerHandle: string;
  readonly evaluationMethod: ResourceDescriptor;
}

/**
 * Compatibility is exact parser identity — id, version, and digest together. A drifted digest
 * is a different semantic commitment and must not be served by this adapter.
 */
function matchesParser(parser: ParserIdentity) {
  const expected = parserAllowlistKey(parser);
  return (specification: EvaluationSpec): boolean => {
    if (specification.family !== "deterministic-process") return false;
    const block = specification.familyBlock as DeterministicProcessBlock;
    return parserAllowlistKey(block.parser) === expected;
  };
}

export function createSweRebenchEvaluatorRegistration(
  options: EvaluatorRegistrationOptions & {
    readonly graderReportSource: GraderReportSource;
    readonly maxTestLogBytes?: number;
  },
): EvaluatorRegistration {
  return defineEvaluatorRegistration({
    registrationId: SWE_REBENCH_REGISTRATION_ID,
    adapter: createSweRebenchEvaluatorAdapter({
      graderReportSource: options.graderReportSource,
      ...(options.maxTestLogBytes === undefined
        ? {}
        : { maxTestLogBytes: options.maxTestLogBytes }),
    }),
    evaluationMethod: options.evaluationMethod,
    specificationCompatibility: matchesParser(SWE_REBENCH_PARSER),
    evaluatorIdentity: { id: options.evaluatorId },
    signer: { handle: options.signerHandle },
    outcomeValidator: (evaluation) => evaluation,
    interruptionBehavior: "repeatable",
  });
}

export function createPredictionEvaluatorRegistration(
  options: EvaluatorRegistrationOptions & {
    readonly resolutionSnapshotSource: ResolutionSnapshotSource;
  },
): EvaluatorRegistration {
  return defineEvaluatorRegistration({
    registrationId: PREDICTION_REGISTRATION_ID,
    adapter: createPredictionEvaluatorAdapter({
      resolutionSnapshotSource: options.resolutionSnapshotSource,
    }),
    evaluationMethod: options.evaluationMethod,
    specificationCompatibility: matchesParser(PREDICTION_PARSER),
    evaluatorIdentity: { id: options.evaluatorId },
    signer: { handle: options.signerHandle },
    outcomeValidator: (evaluation) => evaluation,
    interruptionBehavior: "repeatable",
  });
}
