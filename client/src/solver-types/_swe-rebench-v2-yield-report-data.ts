/**
 * Yield report data loader — operator supplies stats via env for v0 CLI.
 */

import type { InstanceVerdictStats } from './_swe-rebench-v2-yield.js';

export function loadYieldStatsFromEnv(): InstanceVerdictStats[] {
  const raw = process.env.JINN_YIELD_STATS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as InstanceVerdictStats[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
