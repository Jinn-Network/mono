// SPDX-License-Identifier: Apache-2.0

import type { EvaluationSpec } from "@jinn-network/task-execution-profiles";
import type {
  CompletedEvaluation,
  EvaluatorAdapter,
  ResourceDescriptor,
} from "./adapter.js";

export const INTERRUPTION_BEHAVIORS = [
  "repeatable",
  "recoverable",
  "nonrepeatable",
] as const;

export type InterruptionBehavior =
  (typeof INTERRUPTION_BEHAVIORS)[number];

export interface EvaluatorIdentity {
  readonly id: string;
}

/** Opaque reference-forward resolved beneath an Attempt's `secrets/` directory at sign time. */
export interface EvaluationSignerRegistration {
  readonly handle: string;
}

export interface EvaluatorRegistration {
  readonly registrationId: string;
  readonly adapter: EvaluatorAdapter;
  readonly evaluationMethod: ResourceDescriptor;
  readonly specificationCompatibility: (
    specification: EvaluationSpec,
  ) => boolean;
  readonly evaluatorIdentity: EvaluatorIdentity;
  readonly signer: EvaluationSignerRegistration;
  readonly outcomeValidator: (
    evaluation: CompletedEvaluation,
  ) => CompletedEvaluation;
  readonly interruptionBehavior: InterruptionBehavior;
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty`);
  }
}

/** A grant key is an exact logical handle, never a path selected by a Task. */
function signerHandle(value: string): void {
  nonEmpty(value, "signer.handle");
  if (
    value === "." || value === ".." || value.includes("/")
    || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("signer.handle must be one portable logical handle");
  }
}

export function defineEvaluatorRegistration(
  registration: EvaluatorRegistration,
): EvaluatorRegistration {
  nonEmpty(registration.registrationId, "registrationId");
  nonEmpty(registration.evaluatorIdentity.id, "evaluatorIdentity.id");
  signerHandle(registration.signer.handle);
  if (!INTERRUPTION_BEHAVIORS.includes(registration.interruptionBehavior)) {
    throw new TypeError("interruptionBehavior is invalid");
  }
  return Object.freeze(registration);
}

/** Validates the host-owned set once, before a Task can select a registration. */
export function validateEvaluatorRegistrationSet(
  registrations: readonly EvaluatorRegistration[],
): readonly EvaluatorRegistration[] {
  const ids = new Set<string>();
  for (const registration of registrations) {
    defineEvaluatorRegistration(registration);
    if (ids.has(registration.registrationId)) {
      throw new TypeError("EvaluatorRegistration registrationId values must be unique");
    }
    ids.add(registration.registrationId);
  }
  return Object.freeze([...registrations]);
}
