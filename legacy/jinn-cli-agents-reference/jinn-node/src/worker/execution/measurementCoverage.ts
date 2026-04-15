/**
 * Measurement coverage computation.
 *
 * After agent execution, computes how many mission invariants were measured
 * by inspecting successful create_measurement tool calls in telemetry.
 */

import { extractMissionInvariantIds } from '../prompt/utils/invariantIds.js';

export interface MeasurementCoverage {
  totalMissionInvariants: number;
  measuredCount: number;
  unmeasuredIds: string[];
  measuredIds: string[];
  coveragePercent: number;
  passingCount: number;
  failingCount: number;
  /** True if the job status is DELEGATING (coverage still computed for observability) */
  delegated: boolean;
}

/**
 * Compute measurement coverage from telemetry tool calls.
 *
 * Returns null if no blueprint or no mission invariants exist.
 */
export function computeMeasurementCoverage(params: {
  blueprint?: string;
  telemetry: any;
  status: string;
}): MeasurementCoverage | null {
  const { blueprint, telemetry, status } = params;

  const missionIds = extractMissionInvariantIds(blueprint);
  if (missionIds.length === 0) return null;

  // Extract successful create_measurement calls from telemetry
  const toolCalls: any[] = telemetry?.toolCalls || [];
  const measurementCalls = toolCalls.filter(
    (tc) => tc.tool === 'create_measurement' && tc.success === true
  );

  // Extract invariant_id from each successful measurement
  const measuredMap = new Map<string, boolean>();
  for (const call of measurementCalls) {
    // Prefer call args as source of truth; tool result can be stale/mis-associated in edge telemetry cases.
    const invariantId = call.args?.invariant_id || call.result?.invariant_id;
    if (invariantId && typeof invariantId === 'string') {
      const passed = call.result?.passed ?? true;
      measuredMap.set(invariantId, passed);
    }
  }

  // Compute coverage against mission invariants
  const measuredIds: string[] = [];
  const unmeasuredIds: string[] = [];
  let passingCount = 0;
  let failingCount = 0;

  for (const id of missionIds) {
    if (measuredMap.has(id)) {
      measuredIds.push(id);
      if (measuredMap.get(id)) {
        passingCount++;
      } else {
        failingCount++;
      }
    } else {
      unmeasuredIds.push(id);
    }
  }

  const coveragePercent = missionIds.length > 0
    ? Math.round((measuredIds.length / missionIds.length) * 100)
    : 0;

  return {
    totalMissionInvariants: missionIds.length,
    measuredCount: measuredIds.length,
    unmeasuredIds,
    measuredIds,
    coveragePercent,
    passingCount,
    failingCount,
    delegated: status === 'DELEGATING',
  };
}
