/**
 * The `sample-size-advisory/v1` Run extension (issue #2978).
 *
 * A bare rate on a small n is the most common way honest people mislead themselves, and the
 * interval that n implies is computable before any compute is spent. The product prints it at the
 * lock and refuses to seal until the operator says the width is the one they want. This extension
 * is where that exchange survives the seal.
 *
 * Both fields are derivable from the sealed plan: `n` is the benchmark's item count times the
 * Run's `replicates`, and the width is a pure function of `n`. Recording them anyway is not
 * duplication — what the extension actually asserts is the thing that is NOT derivable, that the
 * operator was shown this width BEFORE the irreversible seal and locked at this n regardless. A
 * report can then show the tradeoff was made knowingly rather than stumbled into, and a reader can
 * recompute both numbers and see the claim is the one the plan supports.
 *
 * Namespaced and additive on exactly the terms `task-selection/v1` and `beacon-source/v1` are: a
 * Run that carries no acknowledgement seals byte-identical bytes to before this existed, and every
 * already-sealed Run keeps its digest. Absence reads as absence — {@link readRunSampleSizeAdvisory}
 * returns `undefined`, never a synthesized advisory for a lock nobody acknowledged.
 */

import { z } from "zod";
import { SAMPLE_SIZE_ADVISORY_EXTENSION } from "./identifiers.js";

/**
 * Strict, for the reason its two siblings are strict: sealing preserves the raw document, so an
 * unrecognized key would ride in the sealed bytes while every reader ignored it.
 */
export const RunSampleSizeAdvisoryExtensionSchema = z.strictObject({
  /** Per-arm scorable trials the seal commits to: benchmark items x replicates. */
  n: z.number().int().positive(),
  /**
   * The widest 95% interval `n` can produce, spelled as a fixed 4-decimal string the way every
   * other interval in a sealed record is spelled. A string rather than a number because the sealed
   * bytes are canonical: a binary float would be a spelling this package does not control.
   */
  expectedIntervalWidth: z.string().regex(/^\d\.\d{4}$/),
});

export type RunSampleSizeAdvisoryExtension = z.infer<typeof RunSampleSizeAdvisoryExtensionSchema>;

type ExtensibleRecord = Record<string, unknown>;

/** Construct the typed namespaced Run extension. Throws on a declaration this schema refuses. */
export function runSampleSizeAdvisoryExtension(value: unknown): RunSampleSizeAdvisoryExtension {
  return RunSampleSizeAdvisoryExtensionSchema.parse(value);
}

export function withRunSampleSizeAdvisoryExtension<T extends ExtensibleRecord>(
  record: T,
  extension: RunSampleSizeAdvisoryExtension,
): T & { [SAMPLE_SIZE_ADVISORY_EXTENSION]: RunSampleSizeAdvisoryExtension } {
  return {
    ...record,
    [SAMPLE_SIZE_ADVISORY_EXTENSION]: runSampleSizeAdvisoryExtension(extension),
  } as T & { [SAMPLE_SIZE_ADVISORY_EXTENSION]: RunSampleSizeAdvisoryExtension };
}

/** The acknowledged advisory, or `undefined` when the Run carries none. */
export function readRunSampleSizeAdvisory(
  record: ExtensibleRecord,
): RunSampleSizeAdvisoryExtension | undefined {
  const value = record[SAMPLE_SIZE_ADVISORY_EXTENSION];
  return value === undefined ? undefined : runSampleSizeAdvisoryExtension(value);
}
