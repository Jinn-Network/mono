// SPDX-License-Identifier: MIT

/**
 * The four core pinning axes and the two surface names they carry.
 *
 * The benchmarking Matrix names the isolation axis `isolation` in its `verification` block;
 * the requirements vocabulary (and the policy-identity tuple) names the same axis
 * `isolationPolicy`. One axis, two names — the mapping is pinned by the policy identity
 * design §4.1 and reproduced here because this package sits on the seam.
 */
export type PinningAxis = "harness" | "model" | "loadout" | "isolation";

export const PINNING_AXES: readonly PinningAxis[] = [
  "harness",
  "model",
  "loadout",
  "isolation",
] as const;

/** Requirements-vocabulary key for each Matrix axis name. */
export const REQUIREMENT_KEY_FOR_AXIS: Readonly<Record<PinningAxis, string>> = {
  harness: "harness",
  model: "model",
  loadout: "loadout",
  isolation: "isolationPolicy",
};

/**
 * Effective run pinning for a cell: the Run's `policy.submissionBaseline` overlaid by the
 * arm's own `pinning`. This reproduces `benchmarking-run`'s launch-side merge exactly — the
 * two must agree, or the bridge would grade a cell against pins the cell never carried.
 * The Run schema already forbids a baseline/arm key collision, so the overlay is total.
 */
export function effectiveRunPinning(
  submissionBaseline: Readonly<Record<string, unknown>> | undefined,
  armPinning: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return { ...(submissionBaseline ?? {}), ...(armPinning ?? {}) };
}

/** The pinned value for one axis, or `undefined` when the axis is unpinned. */
export function pinnedValueForAxis(
  pinning: Readonly<Record<string, unknown>>,
  axis: PinningAxis,
): unknown {
  const key = REQUIREMENT_KEY_FOR_AXIS[axis];
  return Object.hasOwn(pinning, key) ? pinning[key] : undefined;
}
