/**
 * Unit Test: Measurement Coverage Computation
 * Module: worker/execution/measurementCoverage.ts
 * Priority: P1 (HIGH)
 *
 * Tests computeMeasurementCoverage() which determines how many
 * mission invariants were measured during agent execution.
 */
import { describe, it, expect } from 'vitest';
import { computeMeasurementCoverage } from 'jinn-node/worker/execution/measurementCoverage.js';

const makeBlueprintWith = (invariants: Array<{ id: string; type?: string }>) =>
  JSON.stringify({ invariants });

describe('computeMeasurementCoverage', () => {
  describe('returns null for non-applicable cases', () => {
    it('returns null when no blueprint provided', () => {
      expect(computeMeasurementCoverage({
        blueprint: undefined,
        telemetry: {},
        status: 'COMPLETED',
      })).toBeNull();
    });

    it('returns null when blueprint has no invariants', () => {
      expect(computeMeasurementCoverage({
        blueprint: JSON.stringify({ name: 'test' }),
        telemetry: {},
        status: 'COMPLETED',
      })).toBeNull();
    });

    it('returns null when blueprint has only SYS/COORD invariants', () => {
      const blueprint = makeBlueprintWith([
        { id: 'SYS-014', type: 'BOOLEAN' },
        { id: 'COORD-BRANCH-REVIEW', type: 'BOOLEAN' },
      ]);
      expect(computeMeasurementCoverage({
        blueprint,
        telemetry: {},
        status: 'COMPLETED',
      })).toBeNull();
    });
  });

  describe('coverage computation with no measurements', () => {
    it('reports 0% coverage when no tool calls exist', () => {
      const blueprint = makeBlueprintWith([
        { id: 'GOAL-CONTENT', type: 'BOOLEAN' },
        { id: 'GOAL-QUALITY', type: 'FLOOR' },
        { id: 'OUT-FORMAT', type: 'BOOLEAN' },
      ]);

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry: { toolCalls: [] },
        status: 'COMPLETED',
      });

      expect(result).toEqual({
        totalMissionInvariants: 3,
        measuredCount: 0,
        unmeasuredIds: ['GOAL-CONTENT', 'GOAL-QUALITY', 'OUT-FORMAT'],
        measuredIds: [],
        coveragePercent: 0,
        passingCount: 0,
        failingCount: 0,
        delegated: false,
      });
    });
  });

  describe('partial measurements', () => {
    it('computes correct coverage for partial measurement', () => {
      const blueprint = makeBlueprintWith([
        { id: 'GOAL-A', type: 'BOOLEAN' },
        { id: 'GOAL-B', type: 'BOOLEAN' },
        { id: 'OUT-C', type: 'FLOOR' },
      ]);

      const telemetry = {
        toolCalls: [
          {
            tool: 'create_measurement',
            success: true,
            result: { invariant_id: 'GOAL-A', passed: true },
          },
          {
            tool: 'create_measurement',
            success: true,
            result: { invariant_id: 'OUT-C', passed: false },
          },
        ],
      };

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry,
        status: 'COMPLETED',
      });

      expect(result).toEqual({
        totalMissionInvariants: 3,
        measuredCount: 2,
        unmeasuredIds: ['GOAL-B'],
        measuredIds: ['GOAL-A', 'OUT-C'],
        coveragePercent: 67,
        passingCount: 1,
        failingCount: 1,
        delegated: false,
      });
    });
  });

  describe('full coverage', () => {
    it('reports 100% when all mission invariants measured', () => {
      const blueprint = makeBlueprintWith([
        { id: 'GOAL-X', type: 'BOOLEAN' },
        { id: 'GOAL-Y', type: 'BOOLEAN' },
      ]);

      const telemetry = {
        toolCalls: [
          { tool: 'create_measurement', success: true, result: { invariant_id: 'GOAL-X', passed: true } },
          { tool: 'create_measurement', success: true, result: { invariant_id: 'GOAL-Y', passed: true } },
        ],
      };

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry,
        status: 'COMPLETED',
      });

      expect(result!.coveragePercent).toBe(100);
      expect(result!.unmeasuredIds).toEqual([]);
      expect(result!.measuredIds).toEqual(['GOAL-X', 'GOAL-Y']);
      expect(result!.passingCount).toBe(2);
      expect(result!.failingCount).toBe(0);
    });
  });

  describe('filtering logic', () => {
    it('ignores failed create_measurement calls', () => {
      const blueprint = makeBlueprintWith([{ id: 'GOAL-A', type: 'BOOLEAN' }]);

      const telemetry = {
        toolCalls: [
          { tool: 'create_measurement', success: false, result: { invariant_id: 'GOAL-A', passed: true } },
        ],
      };

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry,
        status: 'COMPLETED',
      });

      expect(result!.measuredCount).toBe(0);
      expect(result!.unmeasuredIds).toEqual(['GOAL-A']);
    });

    it('ignores non-measurement tool calls', () => {
      const blueprint = makeBlueprintWith([{ id: 'GOAL-A', type: 'BOOLEAN' }]);

      const telemetry = {
        toolCalls: [
          { tool: 'create_artifact', success: true, result: { invariant_id: 'GOAL-A' } },
          { tool: 'web_fetch', success: true, result: {} },
        ],
      };

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry,
        status: 'COMPLETED',
      });

      expect(result!.measuredCount).toBe(0);
    });

    it('ignores measurements for non-mission invariant IDs', () => {
      const blueprint = makeBlueprintWith([
        { id: 'GOAL-A', type: 'BOOLEAN' },
        { id: 'SYS-014', type: 'BOOLEAN' },
      ]);

      const telemetry = {
        toolCalls: [
          { tool: 'create_measurement', success: true, result: { invariant_id: 'SYS-014', passed: true } },
          { tool: 'create_measurement', success: true, result: { invariant_id: 'RANDOM-ID', passed: true } },
        ],
      };

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry,
        status: 'COMPLETED',
      });

      // Only GOAL-A is a mission invariant, and it wasn't measured
      expect(result!.totalMissionInvariants).toBe(1);
      expect(result!.measuredCount).toBe(0);
      expect(result!.unmeasuredIds).toEqual(['GOAL-A']);
    });

    it('reads invariant_id from args if not in result', () => {
      const blueprint = makeBlueprintWith([{ id: 'GOAL-A', type: 'BOOLEAN' }]);

      const telemetry = {
        toolCalls: [
          { tool: 'create_measurement', success: true, args: { invariant_id: 'GOAL-A' }, result: { passed: true } },
        ],
      };

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry,
        status: 'COMPLETED',
      });

      expect(result!.measuredCount).toBe(1);
      expect(result!.measuredIds).toEqual(['GOAL-A']);
    });
  });

  describe('delegation awareness', () => {
    it('sets delegated=true when status is DELEGATING', () => {
      const blueprint = makeBlueprintWith([{ id: 'GOAL-A', type: 'BOOLEAN' }]);

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry: { toolCalls: [] },
        status: 'DELEGATING',
      });

      expect(result!.delegated).toBe(true);
    });

    it('sets delegated=false for other statuses', () => {
      const blueprint = makeBlueprintWith([{ id: 'GOAL-A', type: 'BOOLEAN' }]);

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry: { toolCalls: [] },
        status: 'COMPLETED',
      });

      expect(result!.delegated).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles missing telemetry.toolCalls gracefully', () => {
      const blueprint = makeBlueprintWith([{ id: 'GOAL-A', type: 'BOOLEAN' }]);

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry: {},
        status: 'COMPLETED',
      });

      expect(result!.measuredCount).toBe(0);
      expect(result!.totalMissionInvariants).toBe(1);
    });

    it('handles null telemetry', () => {
      const blueprint = makeBlueprintWith([{ id: 'GOAL-A', type: 'BOOLEAN' }]);

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry: null,
        status: 'COMPLETED',
      });

      expect(result!.measuredCount).toBe(0);
    });

    it('deduplicates multiple measurements for same invariant (last wins)', () => {
      const blueprint = makeBlueprintWith([{ id: 'GOAL-A', type: 'BOOLEAN' }]);

      const telemetry = {
        toolCalls: [
          { tool: 'create_measurement', success: true, result: { invariant_id: 'GOAL-A', passed: true } },
          { tool: 'create_measurement', success: true, result: { invariant_id: 'GOAL-A', passed: false } },
        ],
      };

      const result = computeMeasurementCoverage({
        blueprint,
        telemetry,
        status: 'COMPLETED',
      });

      // Last measurement overwrites: passed=false
      expect(result!.measuredCount).toBe(1);
      expect(result!.failingCount).toBe(1);
      expect(result!.passingCount).toBe(0);
    });
  });
});
