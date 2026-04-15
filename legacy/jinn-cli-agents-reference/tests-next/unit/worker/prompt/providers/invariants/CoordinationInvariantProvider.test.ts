/**
 * Unit Test: CoordinationInvariantProvider - COORD-UNMEASURED
 * Module: worker/prompt/providers/invariants/CoordinationInvariantProvider.ts
 * Priority: P1 (HIGH)
 *
 * Tests the COORD-UNMEASURED invariant generation logic:
 * - Only activates on re-runs (when prior measurements exist)
 * - Lists unmeasured mission invariants
 * - Suppressed when all unmeasured + active children (delegation)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('jinn-node/logging/index.js', () => ({
  workerLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CoordinationInvariantProvider } from 'jinn-node/worker/prompt/providers/invariants/CoordinationInvariantProvider.js';
import type { BuildContext, BlueprintContext } from 'jinn-node/worker/prompt/types.js';

function makeCtx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    requestId: 'req-123',
    metadata: {
      blueprint: JSON.stringify({
        invariants: [
          { id: 'GOAL-CONTENT', type: 'BOOLEAN', condition: 'test' },
          { id: 'GOAL-QUALITY', type: 'FLOOR', condition: 'test' },
          { id: 'OUT-FORMAT', type: 'BOOLEAN', condition: 'test' },
          { id: 'SYS-014', type: 'BOOLEAN', condition: 'system' },
        ],
      }),
      ...overrides.metadata,
    },
    ...overrides,
  } as BuildContext;
}

function makeBuiltContext(overrides: Partial<BlueprintContext> = {}): BlueprintContext {
  return {
    ...overrides,
  };
}

describe('CoordinationInvariantProvider - COORD-UNMEASURED', () => {
  const provider = new CoordinationInvariantProvider();

  describe('first run (no measurements)', () => {
    it('does not generate COORD-UNMEASURED when no measurements exist', async () => {
      const ctx = makeCtx();
      const builtContext = makeBuiltContext({ measurements: [] });

      const invariants = await provider.provide(ctx, builtContext);
      const unmeasured = invariants.find(i => i.id === 'COORD-UNMEASURED');

      expect(unmeasured).toBeUndefined();
    });

    it('does not generate COORD-UNMEASURED when measurements is undefined', async () => {
      const ctx = makeCtx();
      const builtContext = makeBuiltContext({ measurements: undefined });

      const invariants = await provider.provide(ctx, builtContext);
      const unmeasured = invariants.find(i => i.id === 'COORD-UNMEASURED');

      expect(unmeasured).toBeUndefined();
    });
  });

  describe('re-run with partial measurements', () => {
    it('generates COORD-UNMEASURED listing gaps', async () => {
      const ctx = makeCtx();
      const builtContext = makeBuiltContext({
        measurements: [
          { invariantId: 'GOAL-CONTENT', type: 'BOOLEAN', passed: true, value: true },
        ],
      });

      const invariants = await provider.provide(ctx, builtContext);
      const unmeasured = invariants.find(i => i.id === 'COORD-UNMEASURED');

      expect(unmeasured).toBeDefined();
      expect(unmeasured!.condition).toContain('GOAL-QUALITY');
      expect(unmeasured!.condition).toContain('OUT-FORMAT');
      expect(unmeasured!.condition).not.toContain('GOAL-CONTENT');
      expect(unmeasured!.condition).toContain('2 unmeasured');
    });

    it('does not include SYS invariants in unmeasured list', async () => {
      const ctx = makeCtx();
      const builtContext = makeBuiltContext({
        measurements: [
          { invariantId: 'GOAL-CONTENT', type: 'BOOLEAN', passed: true, value: true },
          { invariantId: 'GOAL-QUALITY', type: 'FLOOR', passed: true, value: 85 },
        ],
      });

      const invariants = await provider.provide(ctx, builtContext);
      const unmeasured = invariants.find(i => i.id === 'COORD-UNMEASURED');

      expect(unmeasured).toBeDefined();
      expect(unmeasured!.condition).toContain('OUT-FORMAT');
      expect(unmeasured!.condition).not.toContain('SYS-014');
    });
  });

  describe('re-run with full coverage', () => {
    it('does not generate COORD-UNMEASURED when all mission invariants measured', async () => {
      const ctx = makeCtx();
      const builtContext = makeBuiltContext({
        measurements: [
          { invariantId: 'GOAL-CONTENT', type: 'BOOLEAN', passed: true, value: true },
          { invariantId: 'GOAL-QUALITY', type: 'FLOOR', passed: true, value: 90 },
          { invariantId: 'OUT-FORMAT', type: 'BOOLEAN', passed: true, value: true },
        ],
      });

      const invariants = await provider.provide(ctx, builtContext);
      const unmeasured = invariants.find(i => i.id === 'COORD-UNMEASURED');

      expect(unmeasured).toBeUndefined();
    });
  });

  describe('delegation suppression', () => {
    it('suppresses COORD-UNMEASURED when all unmeasured and active children exist', async () => {
      const ctx = makeCtx();
      const builtContext = makeBuiltContext({
        // One measurement exists (so it's a re-run) but for a non-mission invariant
        // Actually, we need at least one measurement to trigger re-run detection
        // but ALL mission invariants unmeasured + active children = suppress
        measurements: [
          { invariantId: 'SYS-014', type: 'BOOLEAN', passed: true, value: true },
        ],
        hierarchy: {
          totalJobs: 3,
          completedJobs: 0,
          activeJobs: 2,
          children: [],
        },
      });

      const invariants = await provider.provide(ctx, builtContext);
      const unmeasured = invariants.find(i => i.id === 'COORD-UNMEASURED');

      expect(unmeasured).toBeUndefined();
    });

    it('does NOT suppress when some invariants are measured (partial delegation)', async () => {
      const ctx = makeCtx();
      const builtContext = makeBuiltContext({
        measurements: [
          { invariantId: 'GOAL-CONTENT', type: 'BOOLEAN', passed: true, value: true },
        ],
        hierarchy: {
          totalJobs: 3,
          completedJobs: 0,
          activeJobs: 2,
          children: [],
        },
      });

      const invariants = await provider.provide(ctx, builtContext);
      const unmeasured = invariants.find(i => i.id === 'COORD-UNMEASURED');

      // Some measured = agent handled some directly, should measure the rest
      expect(unmeasured).toBeDefined();
      expect(unmeasured!.condition).toContain('GOAL-QUALITY');
      expect(unmeasured!.condition).toContain('OUT-FORMAT');
    });

    it('does NOT suppress when no active children (even if all unmeasured)', async () => {
      const ctx = makeCtx();
      const builtContext = makeBuiltContext({
        measurements: [
          { invariantId: 'SYS-014', type: 'BOOLEAN', passed: true, value: true },
        ],
        hierarchy: {
          totalJobs: 2,
          completedJobs: 2,
          activeJobs: 0,
          children: [],
        },
      });

      const invariants = await provider.provide(ctx, builtContext);
      const unmeasured = invariants.find(i => i.id === 'COORD-UNMEASURED');

      // No active children = not delegating, should measure
      expect(unmeasured).toBeDefined();
    });
  });

  describe('no blueprint invariants', () => {
    it('does not generate COORD-UNMEASURED when blueprint has no mission invariants', async () => {
      const ctx = {
        requestId: 'req-123',
        metadata: {
          blueprint: JSON.stringify({
            invariants: [{ id: 'SYS-014', type: 'BOOLEAN' }],
          }),
        },
      } as BuildContext;

      const builtContext = makeBuiltContext({
        measurements: [
          { invariantId: 'SYS-014', type: 'BOOLEAN', passed: true, value: true },
        ],
      });

      const invariants = await provider.provide(ctx, builtContext);
      const unmeasured = invariants.find(i => i.id === 'COORD-UNMEASURED');

      expect(unmeasured).toBeUndefined();
    });
  });
});
