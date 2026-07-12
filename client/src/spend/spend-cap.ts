/**
 * Pure spend-cap predicate (#1584).
 *
 * The single source of the cap check — shared by the daemon claim gate
 * (`daemon/spend-cap-gate.ts`) and the `/v1/status` spend block
 * (`api/gather-status.ts`) so the two surfaces cannot disagree. Lives in the
 * neutral `spend/` layer so the API imports it without depending on `daemon/`.
 */

/** Whether today's spend has reached or exceeded the cap. */
export function isOverSpendCap(spentTodayUsd: number, capUsd: number): boolean {
  return spentTodayUsd >= capUsd;
}
