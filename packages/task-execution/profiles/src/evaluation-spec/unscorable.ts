import { z } from "zod";

/**
 * Unscorable dispositions (2, frozen, §7.4):
 * - `retryable-infrastructure` — no verdict; the Attempt terminates `failed {blame:
 *   infrastructure}`; never FAIL, never inconclusive.
 * - `recorded-inconclusive` — the verdict IS `inconclusive`, with a named, spec-bounded
 *   limitation (the class name in `EvaluationSpec.unscorable`).
 */
export const UNSCORABLE_DISPOSITIONS = ["retryable-infrastructure", "recorded-inconclusive"] as const;
export type UnscorableDisposition = (typeof UNSCORABLE_DISPOSITIONS)[number];

export const UnscorableClassSchema = z.object({
  name: z.string(),
  disposition: z.enum(UNSCORABLE_DISPOSITIONS),
});
export type UnscorableClass = z.infer<typeof UnscorableClassSchema>;

/** An EvaluationSpec's `unscorable` is `UnscorableClass[]` — the declared list bounds the
 * `recorded-inconclusive` vocabulary a delivery may cite (§7.4). */
export const UnscorableSchema = z.array(UnscorableClassSchema);
