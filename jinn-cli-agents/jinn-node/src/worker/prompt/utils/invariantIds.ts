/**
 * Shared utility for extracting mission-relevant invariant IDs from blueprints.
 *
 * Mission invariants are those the agent is expected to measure (GOAL, JOB, OUT, STRAT prefixes).
 * System/coordination invariants (SYS-*, COORD-*) are infrastructure concerns, not measured by agents.
 */

const MISSION_PREFIXES = ['JOB', 'GOAL', 'OUT', 'STRAT', 'VENTURE', 'MEAS'];

/**
 * Extract mission-relevant invariant IDs from a blueprint JSON string.
 * Returns only IDs with recognized mission prefixes (JOB, GOAL, OUT, STRAT).
 */
export function extractMissionInvariantIds(blueprintStr?: string): string[] {
  if (!blueprintStr) return [];
  try {
    const blueprint = JSON.parse(blueprintStr);
    if (!blueprint?.invariants || !Array.isArray(blueprint.invariants)) return [];
    return blueprint.invariants
      .filter((inv: any) => {
        const prefix = (inv.id || '').split('-')[0];
        return MISSION_PREFIXES.includes(prefix);
      })
      .map((inv: any) => inv.id as string);
  } catch {
    return [];
  }
}
