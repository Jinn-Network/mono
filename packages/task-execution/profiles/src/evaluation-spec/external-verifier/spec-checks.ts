import type { EvaluationSpec } from "../schema.js";
import { ProfilesError } from "../../errors.js";
import {
  EXTERNAL_VERIFIER_DIGEST_PATTERN,
  EXTERNAL_VERIFIER_FAMILY,
  ExternalVerifierBlockSchema,
} from "../family-blocks.js";

export type ExternalVerifierSpecCheckResult =
  | { ok: true }
  | { ok: false; code: "invalid-document"; reason: string };

function refused(reason: string): ExternalVerifierSpecCheckResult {
  return { ok: false, code: "invalid-document", reason };
}

/** Structural check for the `external-verifier-block` fixture family: parses a
 * `{family, block}` case and throws `ProfilesError("invalid-document")` on any violation, so
 * `runStructuralCheck` can project it to `{ok:false, code}`. */
export function checkExternalVerifierBlock(input: unknown): unknown {
  const { family, block } = input as { family: string; block: unknown };
  if (family !== EXTERNAL_VERIFIER_FAMILY) {
    throw new ProfilesError("invalid-document", `expected family "${EXTERNAL_VERIFIER_FAMILY}"`);
  }
  const parsed = ExternalVerifierBlockSchema.safeParse(block);
  if (!parsed.success) {
    throw new ProfilesError("invalid-document", "external-verifier block failed schema validation");
  }
  return parsed.data;
}

/**
 * The rules an `external-verifier` EvaluationSpec carries outside its block (proposal 0002,
 * sections 3, 4 and 6):
 *
 * - `grader` is a single descriptor, never a list. It names the harness's task package by the
 *   content hash the harness assigns, as bare `digest.sha256`, and inlines no `content`.
 * - At least one measurement is declared.
 * - A `harbor` reward is a number, so every measurement is declared with type `number`.
 *
 * The family fixes no verdict rule: what a reward means belongs to the benchmark, and the
 * spec's own `verdictRule` says it.
 */
export function checkExternalVerifierSpec(spec: EvaluationSpec): ExternalVerifierSpecCheckResult {
  if (spec.family !== EXTERNAL_VERIFIER_FAMILY) {
    return refused(`expected family "${EXTERNAL_VERIFIER_FAMILY}"`);
  }
  const block = ExternalVerifierBlockSchema.safeParse(spec.familyBlock);
  if (!block.success) {
    return refused("external-verifier block failed schema validation");
  }
  const { harness } = block.data;

  if (Array.isArray(spec.grader)) {
    return refused("grader must be a single descriptor naming the harness's task package, not a list");
  }
  const sha256 = spec.grader.digest?.["sha256"];
  if (typeof sha256 !== "string" || !EXTERNAL_VERIFIER_DIGEST_PATTERN.test(sha256)) {
    return refused(
      "grader requires digest.sha256, the harness's content hash of the task package, "
      + "as 64 lowercase hexadecimal digits with no prefix",
    );
  }
  if (spec.grader.content !== undefined) {
    return refused("grader must name the task package by digest; it carries no inline content");
  }

  if (spec.measurements.length === 0) {
    return refused("an external-verifier spec must declare at least one measurement");
  }
  for (const measurement of spec.measurements) {
    if (measurement.type !== "number") {
      return refused(
        `a ${harness} reward is a number: measurement "${measurement.name}" must be declared `
        + `with type "number", not "${measurement.type}"`,
      );
    }
  }
  return { ok: true };
}
