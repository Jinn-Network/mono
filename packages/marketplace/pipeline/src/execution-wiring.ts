// SPDX-License-Identifier: MIT

import type { ExecutionWiringEntry } from "./types.js";

export type { ExecutionWiringEntry };

export function resolveWiringEntry(
  workKind: string,
  wiring: readonly ExecutionWiringEntry[],
): ExecutionWiringEntry | undefined {
  return wiring.find((entry) => entry.workKind === workKind);
}

/**
 * Under the `attested` posture (§7), read pinning constraints from discovery facts. The
 * predicate uses this to decline work it will not run to the pin; after-the-fact verification
 * against the Evidence Runtime Observation is consumer-side, never protocol state.
 */
export function runPinningConstraint(facts: {
  readonly runPinning?: {
    readonly harness?: string;
    readonly model?: string;
    readonly loadout?: string;
    readonly effortFloor?: number;
    readonly isolationPolicy?: string;
  };
}): {
  readonly pinned: boolean;
  readonly harness?: string;
  readonly model?: string;
  readonly loadout?: string;
  readonly effortFloor?: number;
  readonly isolationPolicy?: string;
} {
  const pin = facts.runPinning;
  if (pin === undefined) {
    return { pinned: false };
  }
  const pinned = pin.harness !== undefined
    || pin.model !== undefined
    || pin.loadout !== undefined
    || pin.effortFloor !== undefined
    || pin.isolationPolicy !== undefined;
  return { pinned, ...pin };
}

/**
 * Returns false when the facts card pins a harness/model/loadout/isolation that the wiring
 * entry cannot honor. Effort floor is carried through for downstream verification only.
 */
export function wiringHonorsPinning(
  facts: {
    readonly runPinning?: {
      readonly harness?: string;
      readonly model?: string;
      readonly loadout?: string;
      readonly isolationPolicy?: string;
    };
  },
  wiring: ExecutionWiringEntry,
): boolean {
  const pin = runPinningConstraint(facts);
  if (!pin.pinned) return true;
  if (pin.harness !== undefined && pin.harness !== wiring.harness) return false;
  if (pin.model !== undefined && pin.model !== wiring.model) return false;
  if (pin.loadout !== undefined && !wiring.plugins.includes(pin.loadout)) return false;
  return true;
}
