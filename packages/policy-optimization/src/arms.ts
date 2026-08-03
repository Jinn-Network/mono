// SPDX-License-Identifier: MIT

/**
 * Arms: turning admitted candidates into a Run's pinning maps (product design §6.1).
 *
 * > arms = policy tuples expressed as Submission run pinning per the substrate's expression rule
 * > (a candidate's loadout digest pinned via `loadout`; every arm pinned byte-identically to the
 * > campaign's `frozenAxes` values)
 *
 * Two readings of that sentence were available and only one of them is the design's.
 *
 * - **Chosen:** each arm's `pinning` is the *whole* tuple expression, and `policy.submissionBaseline`
 *   is empty. The sentence says the arms are the tuples expressed by the substrate's rule, and
 *   `expressAsRunPinning` expresses a tuple, not the part of it that varies.
 * - **Rejected:** hoist the frozen axes into `policy.submissionBaseline` and leave each arm carrying
 *   only its mutable axis. That would make byte-identity across arms *structural* rather than
 *   checked — genuinely attractive — but it is a different expression rule, and it would mean no
 *   arm's `pinning` is ever a policy tuple. See FINDING F-C7b-1: the byte-identity this package
 *   loses by not hoisting is bought back by `assertArmsAgreeOnFrozenAxes`, which is run on every
 *   plan and asserted directly by a test.
 *
 * The Run schema forbids an arm key colliding with a `submissionBaseline` key (records §7.79), so
 * the two readings are mutually exclusive — hoisting *and* expressing would fail to seal.
 */

import {
  compareCodeUnitStrings,
  expressAsRunPinning,
  canonicalJsonText,
  type ExecutionPolicyTuple,
} from "@jinn-network/policy-identity";
import { childPath, issue, refuseAll, type PolicyOptimizationIssue } from "./errors.js";
import { axisValuesByteShare, isExactPin } from "./frozen-axes.js";
import type { CampaignDocument, JsonValue } from "./types.js";
import type { AdmittedCandidate, WaveArm } from "./wave-types.js";

/** records §7.1's `armId` grammar, mirrored so a bad id is refused before `sealRun` sees it. */
const ARM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Does this candidate's tuple satisfy the campaign's axis contract?
 *
 * Two rules, both from §5.1 and re-run here rather than trusted from admission: the frozen axes
 * must byte-share the campaign's values, and every mutable axis must carry an exact pin. Admission
 * (C7c) checks the same thing when the candidate enters the population; checking again at wave
 * composition costs one canonicalization per axis and closes the window in which a population
 * outlives the campaign document it was admitted against.
 */
export function checkCandidateAgainstCampaign(
  campaign: CampaignDocument,
  candidate: AdmittedCandidate,
  path: string,
): readonly PolicyOptimizationIssue[] {
  const errors: PolicyOptimizationIssue[] = [];
  const tuple = candidate.tuple as Record<string, unknown>;

  for (const [axis, frozen] of Object.entries(campaign.frozenAxes)) {
    const actual = Object.hasOwn(tuple, axis) ? tuple[axis] : undefined;
    if (axisValuesByteShare(actual, frozen)) continue;
    errors.push(issue("frozen-axis-disagreement", childPath(path, axis),
      `candidate does not byte-share the campaign's frozen ${axis}: `
      + `${canonicalJsonText((actual === undefined ? null : actual) as JsonValue)} `
      + `vs ${canonicalJsonText(frozen as JsonValue)}`));
  }
  for (const axis of campaign.mutationSurface) {
    const actual = Object.hasOwn(tuple, axis) ? tuple[axis] : undefined;
    if (isExactPin(axis, actual)) continue;
    errors.push(issue("constraint-shaped-pin", childPath(path, axis),
      `candidate's mutable axis ${axis} must carry an exact pin; the search dimension is what the arms are compared on`));
  }
  return errors;
}

/**
 * Every arm agrees, byte-for-byte, on every frozen axis.
 *
 * This is the property the rejected `submissionBaseline` hoist would have made structural. It is
 * asserted over the *expressed* pinning rather than over the tuples, because the expression is
 * what the backend receives and what the Matrix grades — a check on the tuples would be a check on
 * something one step removed from the artifact that matters.
 */
export function assertArmsAgreeOnFrozenAxes(
  campaign: CampaignDocument,
  arms: readonly WaveArm[],
): void {
  const errors: PolicyOptimizationIssue[] = [];
  for (const axis of Object.keys(campaign.frozenAxes)) {
    const [first, ...rest] = arms;
    if (first === undefined) break;
    const expected = (first.pinning as Record<string, unknown>)[axis];
    for (const arm of rest) {
      const actual = (arm.pinning as Record<string, unknown>)[axis];
      if (axisValuesByteShare(actual, expected)) continue;
      errors.push(issue("frozen-axis-disagreement", childPath(`arms.${arm.armId}.pinning`, axis),
        `arm ${arm.armId} does not byte-share arm ${first.armId}'s frozen ${axis}`));
    }
  }
  if (errors.length > 0) refuseAll(errors);
}

/**
 * Builds the wave's arms from admitted candidates, in `armId` order.
 *
 * Ordering is fixed here rather than left to the caller because the sealed Run's bytes depend on
 * it: two hosts planning the same wave from the same population must produce the same digest, and
 * "whatever order the caller's array happened to be in" is not a property anyone can replay.
 */
export function buildWaveArms(
  campaign: CampaignDocument,
  candidates: readonly AdmittedCandidate[],
): readonly WaveArm[] {
  const errors: PolicyOptimizationIssue[] = [];
  if (candidates.length === 0) {
    refuseAll([issue("wave-composition", "arms", "a wave with no arms compares nothing")]);
  }

  const seenArmIds = new Set<string>();
  const seenTuples = new Set<string>();
  const arms: WaveArm[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const path = childPath("candidates", index);
    if (!ARM_ID_PATTERN.test(candidate.armId)) {
      errors.push(issue("wave-composition", childPath(path, "armId"),
        "armId must match [A-Za-z0-9_-]{1,64} (records §7.1)"));
    }
    if (seenArmIds.has(candidate.armId)) {
      errors.push(issue("wave-composition", childPath(path, "armId"),
        `duplicate armId ${candidate.armId}`));
    }
    seenArmIds.add(candidate.armId);
    // Population membership is keyed by tupleDigest (§7.3): the same tuple twice is one arm, not
    // two, and silently collapsing it would lose an admission the caller believes it made.
    if (seenTuples.has(candidate.tupleDigest)) {
      errors.push(issue("wave-composition", childPath(path, "tupleDigest"),
        `tuple ${candidate.tupleDigest} is already an arm; population membership is keyed by tupleDigest (§7.3)`));
    }
    seenTuples.add(candidate.tupleDigest);
    errors.push(...checkCandidateAgainstCampaign(campaign, candidate, childPath(path, "tuple")));

    let pinning;
    try {
      pinning = expressAsRunPinning(candidate.tuple as ExecutionPolicyTuple);
    } catch (cause) {
      errors.push(issue("wave-composition", childPath(path, "tuple"),
        `tuple does not express as run pinning: ${cause instanceof Error ? cause.message : String(cause)}`));
      continue;
    }
    if (Object.keys(pinning).length === 0) {
      errors.push(issue("wave-composition", childPath(path, "tuple"),
        "a tuple that constrains no axis expresses to an empty pinning map and pins nothing"));
    }
    arms.push({
      armId: candidate.armId,
      tupleDigest: candidate.tupleDigest,
      source: candidate.source,
      pinning,
    });
  }

  if (errors.length > 0) refuseAll(errors);
  arms.sort((left, right) => compareCodeUnitStrings(left.armId, right.armId));
  assertArmsAgreeOnFrozenAxes(campaign, arms);
  return arms;
}
