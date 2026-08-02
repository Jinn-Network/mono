// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * The closed chain-admission refusal taxonomy, sibling to `ADMISSION_REFUSAL_CODES` and
 * deliberately separate from it (design §6.3 is a different policy over different
 * evidence, and the SWE taxonomy is asserted exactly equal to its own kit's reachable set).
 * Small on purpose: a consumer routes on these codes, so every addition is a contract
 * change. Sorted by code so the tuple reads as the closed set it is.
 *
 * - `do-nothing-satisfies`   the empty script's success CONJUNCTION evaluated true, so the
 *   task does not demand action. (Individual predicates holding at baseline is expected and
 *   is never a refusal — "health factor above 1.5" is true before borrowing.)
 * - `env-record-mismatch`    the candidate's EvaluationSpec references an environment record
 *   digest other than the composite digest admission was given.
 * - `execution-failed`       the injected observation port threw, or reported executing a
 *   script other than the one the request named.
 * - `inconsistent-observation`  the port's self-reported conjunction disagrees with its own
 *   per-predicate outcome vector, so its answers cannot be attributed.
 * - `invalid-candidate`      structurally unusable: not the state-predicate family, an
 *   EvaluationSpec whose bytes are not its canonical sealing, an empty success-predicate
 *   list, or a repeated predicate id.
 * - `reference-unsatisfied`  the reference script ran and the success conjunction was still
 *   false: the task is not solvable by the path its own author committed.
 * - `safety-violated`        the reference run violated a declared safety constraint, so the
 *   intended path is not admissible under the task's own rules.
 * - `slice-insufficient`     the reference run read outside the committed world (design §4.2's
 *   slice-sufficiency half): the intended path does not fit inside the sealed slice.
 * - `unstable-observations`  the two repeats on a side were not canonical-JSON identical.
 */
export const CHAIN_ADMISSION_REFUSAL_CODES = [
  "do-nothing-satisfies",
  "env-record-mismatch",
  "execution-failed",
  "inconsistent-observation",
  "invalid-candidate",
  "reference-unsatisfied",
  "safety-violated",
  "slice-insufficient",
  "unstable-observations",
] as const;

export type ChainAdmissionRefusalCode = (typeof CHAIN_ADMISSION_REFUSAL_CODES)[number];
export const ChainAdmissionRefusalCodeSchema = z.enum(CHAIN_ADMISSION_REFUSAL_CODES);

export interface ChainAdmissionRefusal {
  readonly code: ChainAdmissionRefusalCode;
  readonly detail: string;
}

export class ChainAdmissionRefusalError extends Error {
  readonly refusal: ChainAdmissionRefusal;

  constructor(code: ChainAdmissionRefusalCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ChainAdmissionRefusalError";
    this.refusal = { code, detail };
  }
}

export function refuseChain(code: ChainAdmissionRefusalCode, detail: string): never {
  throw new ChainAdmissionRefusalError(code, detail);
}
