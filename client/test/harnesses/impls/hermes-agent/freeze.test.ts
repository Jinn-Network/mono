// client/test/harnesses/impls/hermes-agent/freeze.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHermesWithFreezeFence } from '../../../../src/harnesses/impls/hermes-agent/freeze.js';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

// vi.mock at module scope is hoisted by Vitest before imports resolve — so the
// stubbed harvestOutput is in place when HermesHarness.run() calls it during
// the train-mode test. Without this hoisting, the train-mode test would either
// crash on a missing solution-payload.json or unstub-leak into other tests.
import { vi } from 'vitest';
vi.mock('../../../../src/harnesses/impls/learner/harvest.js', () => ({
  harvestOutput: () => ({
    schemaVersion: 'swe-rebench-v2-solution.v1',
    patch: '',
    venueRef: { name: 'placeholder-from-harvest', version: '0' },
  }),
}));

describe('runHermesWithFreezeFence', () => {
  it('rolls back HERMES_HOME on frozen-mode mutation and rejects the envelope', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-frozen-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-frozen-wd-'));
    writeFileSync(join(home, 'before.txt'), 'snapshot');

    try {
      const fakeAdapter = {
        name: 'hermes-agent',
        runTask: async () => {
          writeFileSync(join(home, 'violation.txt'), 'forbidden write');
        },
      };
      const harness = new HermesHarness({ adapter: fakeAdapter as any });

      const ctx = {
        task: { id: 't', solverType: 'swe-rebench-v2.v1', role: 'restoration', window: { startTs: 0, endTs: Date.now() + 60_000 }, spec: {} },
        requestId: 'r',
        implStateDir: home,
        workingDir: work,
        mode: 'frozen' as const,
        abort: new AbortController().signal,
        msUntilEndTs: () => 60_000,
        solverPluginRoots: [],
      } as unknown as HarnessContext;

      await expect(runHermesWithFreezeFence(harness, ctx)).rejects.toThrow(/freeze contract violated/);
      expect(() => readFileSync(join(home, 'violation.txt'))).toThrow();
      expect(readFileSync(join(home, 'before.txt'), 'utf8')).toBe('snapshot');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('train mode is pass-through (writes are allowed)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-train-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-train-wd-'));
    try {
      const fakeAdapter = {
        name: 'hermes-agent',
        runTask: async () => {
          writeFileSync(join(home, 'learned.txt'), 'continuous learning');
        },
      };
      const harness = new HermesHarness({ adapter: fakeAdapter as any });
      const ctx = {
        task: { id: 't', solverType: 'swe-rebench-v2.v1', role: 'restoration', window: { startTs: 0, endTs: Date.now() + 60_000 }, spec: {} },
        requestId: 'r',
        implStateDir: home,
        workingDir: work,
        mode: 'train' as const,
        abort: new AbortController().signal,
        msUntilEndTs: () => 60_000,
        solverPluginRoots: [],
      } as unknown as HarnessContext;

      const solution = await runHermesWithFreezeFence(harness, ctx);
      expect(solution.schemaVersion).toBe('swe-rebench-v2-solution.v1');
      expect(readFileSync(join(home, 'learned.txt'), 'utf8')).toBe('continuous learning');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
