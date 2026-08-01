// SPDX-License-Identifier: Apache-2.0

/**
 * The two planes the product reads. `local` is the operator's own archive, which capture
 * feeds; `public` is the mirrored corpus. C5 tags its candidates with the literal
 * `"public"` and does not declare this union — that would invert the dependency.
 */
export type EvidencePlane = "local" | "public";

/** Ranking order: at equal score, the operator's own history outranks third-party material. */
export const PLANES: readonly EvidencePlane[] = Object.freeze(["local", "public"] as const);

export function comparePlanes(left: EvidencePlane, right: EvidencePlane): number {
  const leftRank = PLANES.indexOf(left);
  const rightRank = PLANES.indexOf(right);
  if (leftRank < rightRank) return -1;
  if (leftRank > rightRank) return 1;
  return 0;
}
