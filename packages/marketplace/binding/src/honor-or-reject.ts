// SPDX-License-Identifier: MIT

import type { BackendCapabilities } from "@jinn-network/task-execution-backend";
import type { EffectiveRequirements, SubmissionRecord } from "@jinn-network/task-execution-protocol";

/** The today-mode symmetric honor-or-reject gate's rejection shape (§6.1, frozen §11.12). */
export type HonorOrRejectResult =
  | { ok: true }
  | { ok: false; category: "unsupported-requirement"; key: string };

/**
 * Today-mode symmetric honor-or-reject (design §6.1; frozen §11.12; ruling §7.20). TEP §8
 * forbids silent degradation: rather than weakly/partially honoring a requirement this venue
 * cannot genuinely enforce, today-mode REJECTS it outright with `unsupported-requirement`.
 *
 * Rejects three shapes, each a chain-model-intrinsic mismatch (not a per-backend declared
 * bound -- `capabilities` is accepted for signature symmetry with the sibling pin-inventory
 * check in `backend.ts`/`capabilities.ts`, but none of these three checks reads it; see the
 * comment at the end of this function):
 *
 * 1. Any evaluation requirement other than `minVerdicts: 1` -- today's contract implements
 *    exactly first-verdict finalization and cannot honor an unknown or stronger requirement.
 * 2. `attempts.maxConcurrent > attempts.maxTotal` -- today's chain enforces only `maxClaims`
 *    (mapped from `maxTotal`); there is no separate on-chain concurrency parameter, so a
 *    Submission asking for more simultaneous attempts than total attempts is unhonorable
 *    (never merely client-honored down to `maxTotal` -- §6.1 forbids the silent narrowing).
 * 3. `closeAt` present -- today-mode has no on-chain claim window, so a scheduled close cannot
 *    genuinely stop a chain-direct claim after the deadline (ruling §7.20: the former
 *    budget-refund + announcement-withdrawal "approximation" is weak/partial honoring, dropped).
 *
 * A pinning key absent from the backend's declared `runPinning` inventory is a DIFFERENT,
 * separate rejection producer -- the backend capability check (program §7.3), not this pure
 * gate. Keeping the two producers distinct means a caller composes both checks rather than one
 * function conflating "requirement shape this venue cannot honor" with "capability this backend
 * instance does not declare".
 */
export function honorOrRejectToday(
  submission: SubmissionRecord,
  _effective: EffectiveRequirements,
  _capabilities: BackendCapabilities,
): HonorOrRejectResult {
  if (submission.closeAt !== undefined) {
    return { ok: false, category: "unsupported-requirement", key: "closeAt" };
  }

  for (const [key, value] of Object.entries(
    submission.evaluationRequirements ?? {},
  )) {
    if (
      key !== "minVerdicts"
      || value !== 1
    ) {
      return {
        ok: false,
        category: "unsupported-requirement",
        key: `evaluationRequirements.${key}`,
      };
    }
  }

  const { maxTotal, maxConcurrent } = submission.attempts ?? {};
  if (maxTotal !== undefined && maxConcurrent !== undefined && maxConcurrent > maxTotal) {
    return { ok: false, category: "unsupported-requirement", key: "attempts.maxConcurrent" };
  }

  return { ok: true };
}
