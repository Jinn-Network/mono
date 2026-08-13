// SPDX-License-Identifier: MIT

import { documentDigest, serializeCanonicalJson } from "@jinn-network/benchmarking-records";
import type { PinningObservation, PinningObservationPort } from "@jinn-network/benchmarking-run";
import { effectiveRunPinning, pinnedValueForAxis, type PinningAxis } from "./axes.js";

/**
 * `sha256:<hex>` over the JCS bytes of a requirements map — the stack's sealing discipline,
 * reused so a gate receipt and the pinning it was issued against are comparable byte-exactly.
 */
export function requirementsDigest(
  pinning: Readonly<Record<string, unknown>>,
): `sha256:${string}` {
  return documentDigest(serializeCanonicalJson(pinning as never));
}

/**
 * The local backend's run-pinning admission result, mirrored structurally.
 *
 * The shape is `verifyRunPinning`'s (`task-execution-backend-local`
 * `assembly/src/pinning.ts`). It is mirrored rather than imported because the benchmarking
 * source-boundary guard forbids concrete-backend imports across the whole tree. The host that
 * ran the gate passes its result in through the injected evidence port.
 */
export interface LocalRunPinningCheck {
  readonly ready: boolean;
  readonly detail?: string;
  /**
   * `sha256:<hex>` over the JCS bytes of the requirements map the gate actually checked.
   *
   * It binds the gate result to a specific pinning map so a receipt cannot be reused against a
   * different one. It is required for an enforced axis to reach `match`; a bare `ready: true`
   * proves no identity and carries no weight.
   */
  readonly checkedRequirementsDigest: `sha256:${string}`;
}

/**
 * One value observed to have actually run on an axis, already normalized into the
 * requirements value shape. `runtime-observation` comes from an Evidence Runtime
 * Observation; `materialization` from the Workspace Provisioner's post-materialization
 * digest; `admission-probe` from the launcher readiness probe.
 *
 * The source is recorded for diagnosis only. It never upgrades a status: an observation
 * either corroborates the pin, contradicts it, or says nothing.
 */
export interface LocalAxisObservation {
  readonly axis: PinningAxis;
  readonly value: unknown;
  readonly source: "runtime-observation" | "materialization" | "admission-probe";
}

/** Everything the bridge knows about one cell's execution fidelity. */
export interface LocalCellPinningEvidence {
  /** The admission gate's verdict for the accounted dispatch. Absent ⇒ nothing established. */
  readonly admission?: LocalRunPinningCheck;
  readonly observations?: readonly LocalAxisObservation[];
  /**
   * Dispatch count for the cell. A cell that was never dispatched executed nothing, so no
   * axis — not even a vacuous one — can be said to have been honored on it.
   */
  readonly dispatches?: number;
}

/**
 * Whether anything was executed for this cell at all: a dispatch, an admission attempt, or a
 * recorded observation.
 *
 * The vacuous isolation axis needs this gate. Its match rests on "the venue could not have
 * run anything else", which presupposes that the venue ran something. An expected-but-never-
 * dispatched cell, or a cell the bridge knows nothing about, has no execution to characterize
 * and reports `unverifiable`.
 */
export function hasExecutionEvidence(
  evidence: LocalCellPinningEvidence | undefined,
): boolean {
  if (evidence === undefined) return false;
  if (evidence.dispatches !== undefined) return evidence.dispatches > 0;
  return evidence.admission !== undefined || (evidence.observations?.length ?? 0) > 0;
}

/**
 * Whether the evidence for an axis corroborates the pin, contradicts it, or is silent.
 *
 * `inconclusive` covers both "no observation at all" and "an observation that neither
 * confirms nor contradicts every field the pin declares" — the two are equally uninformative
 * and must never be distinguished in favor of the pin.
 */
export type AxisCorroboration = "corroborates" | "disagrees" | "inconclusive";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality over JSON-shaped values; no locale, no coercion. */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length
      && left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

/**
 * Compare one observed value against the pinned value.
 *
 * A pinned object is a *constraint*: every field it declares must hold, and fields it does
 * not declare are unconstrained (policy identity design §4.1 — a `{provider}`-only model pin
 * identifies a family, not a point; §7 — corroboration for a constraint-shaped value means
 * the observed value satisfies the constraint). So:
 *
 * - any declared field the observation carries with a different value ⇒ `disagrees`;
 * - every declared field carried and equal ⇒ `corroborates`;
 * - otherwise the observation is silent about at least one declared field ⇒ `inconclusive`.
 *
 * Scalars compare by equality. A non-object observation against an object pin (or the
 * reverse) is an affirmative disagreement about the value's shape.
 */
export function corroborate(pinned: unknown, observed: unknown): AxisCorroboration {
  if (isPlainObject(pinned)) {
    if (!isPlainObject(observed)) return "disagrees";
    let complete = true;
    for (const key of Object.keys(pinned)) {
      if (!Object.hasOwn(observed, key)) {
        complete = false;
        continue;
      }
      if (!deepEqual(pinned[key], observed[key])) return "disagrees";
    }
    return complete ? "corroborates" : "inconclusive";
  }
  return deepEqual(pinned, observed) ? "corroborates" : "disagrees";
}

/** Fold every observation for one axis into a single corroboration verdict. */
export function corroborationForAxis(
  pinned: unknown,
  observations: readonly LocalAxisObservation[],
  axis: PinningAxis,
): AxisCorroboration {
  let verdict: AxisCorroboration = "inconclusive";
  for (const observation of observations) {
    if (observation.axis !== axis) continue;
    const outcome = corroborate(pinned, observation.value);
    // A single affirmative disagreement is terminal: it is a fact about the cell.
    if (outcome === "disagrees") return "disagrees";
    if (outcome === "corroborates") verdict = "corroborates";
  }
  return verdict;
}

/**
 * Identity strength for one axis on this venue (policy identity design §4.3).
 *
 * On the local venue `harness`, `model`, and `loadout` are `enforced` — the launcher
 * readiness probe and the provisioner's digest-verified materialization reject the attempt
 * unless the pinned value verifiably ran. `isolation` is `vacuous`: the launcher inventory
 * admits one value, so agreement asserts nothing about containment. Strength is disclosed
 * by the identity design, not by the Matrix tri-state; the tri-state answers a different
 * question (was the pin honored?) and both surfaces are needed to read a cell.
 */
export type AxisStrength = "enforced" | "attested" | "vacuous";

export const LOCAL_AXIS_STRENGTH: Readonly<Record<PinningAxis, AxisStrength>> = {
  harness: "enforced",
  model: "enforced",
  loadout: "enforced",
  isolation: "vacuous",
};

/** Whether the venue's admission gate accepted the pin on one axis. */
export type AxisAdmission = "accepted" | "not-accepted";

export interface LocalPinningVenue {
  /**
   * Every isolation-policy value the venue's launchers can produce. Today every launcher
   * declares exactly `["unrestricted"]`. A singleton inventory equal to the pin means the
   * venue structurally could not have run anything else, which is what makes the vacuous
   * axis's admission check honest; a wider inventory would make membership uninformative.
   *
   * Required, deliberately: there is no safe default. A host that omits its inventory must
   * fail to compile rather than inherit someone else's assumption and get a silent `match`.
   */
  readonly isolationInventory: readonly string[];
}

/**
 * An id-only harness pin (`{id}` with neither `version` nor `digest`) is one the local
 * admission gate never inspects — it compares versions and digests, never ids — so its
 * acceptance says nothing about the harness that ran. Such a pin can never reach `match`
 * here. (The gate's silence on id is an upstream defect, filed separately; this is the
 * bridge-side refusal to launder it.)
 */
function isUninspectableHarnessPin(axis: PinningAxis, pinned: unknown): boolean {
  if (axis !== "harness" || !isPlainObject(pinned)) return false;
  return pinned["version"] === undefined && pinned["digest"] === undefined;
}

function admissionForAxis(
  axis: PinningAxis,
  pinned: unknown,
  pinning: Readonly<Record<string, unknown>>,
  evidence: LocalCellPinningEvidence | undefined,
  venue: LocalPinningVenue,
): AxisAdmission {
  if (axis === "isolation") {
    // `verifyRunPinning` never inspects the isolation axis; the launcher inventory is the
    // only admission boundary it has. The vacuous match additionally requires that something
    // was actually executed for this cell.
    if (!hasExecutionEvidence(evidence)) return "not-accepted";
    const inventory = venue.isolationInventory;
    return inventory.length === 1 && inventory[0] === pinned ? "accepted" : "not-accepted";
  }
  const admission = evidence?.admission;
  if (admission?.ready !== true) return "not-accepted";
  if (isUninspectableHarnessPin(axis, pinned)) return "not-accepted";
  // Missing identity is not proof. A receipt that names a different map is about another cell.
  if (admission.checkedRequirementsDigest !== requirementsDigest(pinning)) return "not-accepted";
  return "accepted";
}

/**
 * Per-axis treatment-fidelity status for one cell (policy identity design §7; benchmarking
 * design §8.1 owns the Matrix semantics and wins on any conflict).
 *
 * - `mismatch` — affirmative evidence that a different value ran.
 * - `match` — the pin is corroborated: on an enforced (or vacuous) axis the venue's
 *   admission gate accepted it and no observation contradicts it; on an attested axis only
 *   a corroborating Runtime Observation can get there.
 * - `unverifiable` — everything else, including an unpinned axis and a *rejected*
 *   admission. A rejection means nothing ran, which is not evidence that something else
 *   did. Nothing here ever upgrades `unverifiable`.
 */
export function pinningStatusForAxis(input: {
  readonly axis: PinningAxis;
  readonly pinning: Readonly<Record<string, unknown>>;
  readonly evidence?: LocalCellPinningEvidence;
  readonly venue: LocalPinningVenue;
  readonly strength?: AxisStrength;
}): PinningObservation[PinningAxis] {
  const { axis, pinning, venue } = input;
  const strength = input.strength ?? LOCAL_AXIS_STRENGTH[axis];
  const pinned = pinnedValueForAxis(pinning, axis);
  // An absent key and an explicit `null` both mean the requirements do not constrain the
  // axis (identity design §4.1 null-fills unconstrained core axes). Nothing to corroborate.
  if (pinned === undefined || pinned === null) return "unverifiable";

  const corroboration = corroborationForAxis(
    pinned,
    input.evidence?.observations ?? [],
    axis,
  );
  if (corroboration === "disagrees") return "mismatch";
  if (strength === "attested") {
    return corroboration === "corroborates" ? "match" : "unverifiable";
  }
  return admissionForAxis(axis, pinned, pinning, input.evidence, venue) === "accepted"
    ? "match"
    : "unverifiable";
}

/** The whole-cell answer: one status per axis. */
export function pinningObservationForCell(input: {
  readonly pinning: Readonly<Record<string, unknown>>;
  readonly evidence?: LocalCellPinningEvidence;
  readonly venue: LocalPinningVenue;
}): PinningObservation {
  return {
    harness: pinningStatusForAxis({ ...input, axis: "harness" }),
    model: pinningStatusForAxis({ ...input, axis: "model" }),
    loadout: pinningStatusForAxis({ ...input, axis: "loadout" }),
    isolation: pinningStatusForAxis({ ...input, axis: "isolation" }),
  };
}

export interface LocalPinningObservationInput extends LocalPinningVenue {
  /**
   * The Run's `policy.submissionBaseline`. `PinningObservationPort.observe` is handed only
   * `{cellKey, arm}`, so a baseline-pinned axis would otherwise be invisible to the bridge;
   * the host supplies it at construction and the bridge merges it exactly as launch does.
   */
  readonly submissionBaseline?: Readonly<Record<string, unknown>>;
  /** Per-cell admission + observation evidence. An unknown cell establishes nothing. */
  readonly evidenceFor: (
    cellKey: string,
  ) => LocalCellPinningEvidence | undefined | Promise<LocalCellPinningEvidence | undefined>;
}

const UNVERIFIABLE: PinningObservation = {
  harness: "unverifiable",
  model: "unverifiable",
  loadout: "unverifiable",
  isolation: "unverifiable",
};

function readArmContext(
  arm: unknown,
): { cellKey: string; pinning: Readonly<Record<string, unknown>> } | undefined {
  if (!isPlainObject(arm)) return undefined;
  const cellKey = arm["cellKey"];
  if (typeof cellKey !== "string") return undefined;
  const inner = arm["arm"];
  const pinning = isPlainObject(inner) && isPlainObject(inner["pinning"])
    ? inner["pinning"]
    : {};
  return { cellKey, pinning };
}

/**
 * The local venue's `PinningObservationPort`: admission-gate results plus Evidence Runtime
 * Observations in, per-axis `match | mismatch | unverifiable` out.
 *
 * An unrecognized call shape yields `unverifiable` on every axis rather than throwing —
 * assembly must stay total, and silence is the honest answer when the bridge cannot even
 * identify the cell.
 */
export function localPinningObservation(
  input: LocalPinningObservationInput,
): PinningObservationPort {
  return {
    async observe(_delivery, arm) {
      const context = readArmContext(arm);
      if (context === undefined) return { ...UNVERIFIABLE };
      const evidence = await input.evidenceFor(context.cellKey);
      return pinningObservationForCell({
        pinning: effectiveRunPinning(input.submissionBaseline, context.pinning),
        evidence,
        venue: { isolationInventory: input.isolationInventory },
      });
    },
  };
}
