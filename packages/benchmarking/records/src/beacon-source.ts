/**
 * The `beacon-source/v1` Run extension (issue #3426).
 *
 * `beacon-binding/1` binds a run to a beacon value that postdates its seal, and issue #3322 closed
 * the ROUND choice: for a scheduled source `(source, sealedAt)` determines exactly one admissible
 * round. The SOURCE choice survived that, and it is not a swap between two equally constrained
 * beacons -- one admitted source is indexed by block height, where no round follows from a seal at
 * all. So an operator who did not like the round the seal named could select that source instead
 * and choose any height the chain carries. This declaration closes it the only way it can be
 * closed: the run names its beacon in the sealed record itself, before the beacon values exist.
 *
 * Two constraints shaped the carrier, and are the same two `task-selection/v1` states:
 *
 * - **Shape only, never the beacon registry.** The admitted sources and their chain parameters
 *   live in the reference verifier, which depends on this package; mirroring the id list here
 *   would be a second list free to drift from the one the derivation actually uses. The producer
 *   validates the declared value against that registry before sealing, and refuses a source no
 *   procedure admits.
 * - **Namespaced, so it is additive.** A Run that declares nothing seals byte-identical bytes to
 *   before this existed, and every already-sealed Run keeps its digest.
 *
 * Absence stays legal and reads as absence: {@link readBeaconSource} returns `undefined`, never a
 * default source. A binding on a run that declared nothing is exactly what it was before -- the
 * operator's choice of beacon -- and the report face says so.
 *
 * `sealedAt` (issue #3370) closes the other half of the pair this extension exists to fix. The
 * header above states that `(source, sealedAt)` determines exactly one admissible round; sealing
 * only the source left the seal instant outside the sealed bytes, readable nowhere but the
 * producer's own workspace state. A published bundle therefore had no way to check that the seal
 * time a binding names is the seal time the run actually had -- so a publisher free to write it
 * could lower it until a beacon that predated the real seal passed the postdating check, or solve
 * for it until any chosen round became the seal-derived one. Declaring it here makes the pair
 * checkable from the sealed record alone. It is optional because every Run sealed before this
 * field existed declares none, and those runs keep their digests and stay verifiable on the
 * checks their bytes do support.
 */

import { z } from "zod";
import { BEACON_SOURCE_EXTENSION } from "./identifiers.js";
import { isCalendarStrictRfc3339 } from "./rfc3339.js";

/**
 * Strict, for the reason `task-selection/v1` is strict: sealing preserves the raw document, so an
 * unrecognized key would ride in the sealed bytes while every reader ignored it.
 */
export const RunBeaconSourceExtensionSchema = z.strictObject({
  /** The beacon source id this run will bind to, e.g. `drand/quicknet`. */
  source: z.string().min(1),
  /**
   * The instant this run was sealed, written at `run lock` from the same clock reading that becomes
   * the workspace's own lock instant, so the two cannot diverge. Optional: a Run sealed before this
   * field existed declares none, and a reader must treat its absence as absence rather than as a
   * seal at some default time.
   */
  sealedAt: z
    .string()
    .refine(isCalendarStrictRfc3339, "must be a calendar-valid RFC 3339 timestamp")
    .optional(),
});

export type RunBeaconSourceExtension = z.infer<typeof RunBeaconSourceExtensionSchema>;

type ExtensibleRecord = Record<string, unknown>;

/** Construct the typed namespaced Run extension. Throws on a declaration this schema refuses. */
export function runBeaconSourceExtension(value: unknown): RunBeaconSourceExtension {
  return RunBeaconSourceExtensionSchema.parse(value);
}

export function withRunBeaconSourceExtension<T extends ExtensibleRecord>(
  record: T,
  extension: RunBeaconSourceExtension,
): T & { [BEACON_SOURCE_EXTENSION]: RunBeaconSourceExtension } {
  return {
    ...record,
    [BEACON_SOURCE_EXTENSION]: runBeaconSourceExtension(extension),
  } as T & { [BEACON_SOURCE_EXTENSION]: RunBeaconSourceExtension };
}

export function readRunBeaconSourceExtension(record: ExtensibleRecord): RunBeaconSourceExtension | undefined {
  const value = record[BEACON_SOURCE_EXTENSION];
  return value === undefined ? undefined : runBeaconSourceExtension(value);
}

/** The declared beacon source, or `undefined` when the Run carries no declaration. */
export function readBeaconSource(record: ExtensibleRecord): string | undefined {
  return readRunBeaconSourceExtension(record)?.source;
}

/**
 * The seal instant the Run declares, or `undefined` when it declares none -- either because the Run
 * carries no `beacon-source/v1` declaration at all, or because it was sealed before the field
 * existed. A caller comparing a binding's `sealedAt` against this must skip the comparison on
 * `undefined` rather than treat it as a mismatch: absence is the legal, pre-existing case, and
 * failing it would refuse every already-published run.
 */
export function readRunDeclaredSealInstant(record: ExtensibleRecord): string | undefined {
  return readRunBeaconSourceExtension(record)?.sealedAt;
}
