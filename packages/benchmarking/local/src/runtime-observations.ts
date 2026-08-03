// SPDX-License-Identifier: MIT

import { PINNING_AXES, REQUIREMENT_KEY_FOR_AXIS, type PinningAxis } from "./axes.js";
import type { LocalAxisObservation } from "./pinning-bridge.js";

/**
 * The Evidence `resource`-kind Runtime Observation shape, mirrored structurally.
 *
 * Mirrored rather than imported: the benchmarking source-boundary guard forbids every
 * evidence package across the whole tree, and the policy identity design §2 takes the same
 * posture for evidence envelope shapes. A `ResourceRuntimeObservationCapture` from
 * `@jinn-network/execution-recorder` satisfies this structurally.
 */
export interface LocalRuntimeObservationCapture {
  readonly kind: string;
  readonly propertyId?: string;
  readonly name?: string;
  readonly value?: string | number | boolean;
}

/**
 * Property IRI namespace for pinning-axis Runtime Observations.
 *
 * No producer emits these yet — the local backend captures only `process-exit` today. This
 * is the read contract the bridge honors the moment a producer lands; until then the bridge
 * simply sees no observations, which keeps enforced axes on the admission-gate leg and
 * leaves attested axes `unverifiable`.
 */
export const RUN_PINNING_PROPERTY_PREFIX = "https://jinn.network/properties/run-pinning/";

/**
 * The IRI segment is the **requirements-vocabulary** key, not the Matrix axis name — so the
 * isolation axis is published as `.../run-pinning/isolationPolicy`. Producers speak the
 * requirements vocabulary; the Matrix name is a rendering concern on the far side of this
 * package.
 */
export function runPinningPropertyId(axis: PinningAxis): string {
  return `${RUN_PINNING_PROPERTY_PREFIX}${REQUIREMENT_KEY_FOR_AXIS[axis]}`;
}

const AXIS_BY_PROPERTY_ID = new Map<string, PinningAxis>(
  PINNING_AXES.map((axis) => [runPinningPropertyId(axis), axis]),
);

/**
 * Decode a captured observation value into requirements value shape.
 *
 * `ResourceRuntimeObservationCapture.value` admits only string, number, or boolean, so an
 * object-shaped axis value (harness, model, loadout) travels as its JSON text. A string that
 * does not parse as a JSON object or array is taken literally — which is exactly what the
 * scalar `isolationPolicy` axis needs.
 */
function decodeValue(value: string | number | boolean): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/**
 * Project `resource`-kind Runtime Observations onto axis observations.
 *
 * Captures outside the run-pinning property namespace, non-`resource` kinds, and captures
 * with no value are skipped: an unreadable capture establishes nothing, and establishing
 * nothing must never be confused with contradicting the pin.
 */
export function axisObservationsFromRuntimeObservations(
  captures: readonly LocalRuntimeObservationCapture[],
): readonly LocalAxisObservation[] {
  const observations: LocalAxisObservation[] = [];
  for (const capture of captures) {
    if (capture.kind !== "resource") continue;
    if (capture.propertyId === undefined) continue;
    const axis = AXIS_BY_PROPERTY_ID.get(capture.propertyId);
    if (axis === undefined) continue;
    if (capture.value === undefined) continue;
    observations.push({
      axis,
      value: decodeValue(capture.value),
      source: "runtime-observation",
    });
  }
  return observations;
}
