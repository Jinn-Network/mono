// client/test/harnesses/impls/hermes-agent/freeze.test.ts
//
// Validates that the SHARED daemon hash-fence (the one the engine actually
// invokes for every Harness) honors the freeze contract on HERMES_HOME when
// the harness is a HermesHarness. The hermes-agent package no longer ships
// a wrapper around the fence — the engine wires every Harness through
// `runHarnessWithFreezeFence` directly, and we test that production path.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import { runHarnessWithFreezeFence } from '../../../../src/daemon/freeze-fence.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

vi.mock('../../../../src/harnesses/impls/learner/harvest.js', () => ({
  harvestOutput: () => ({
    schemaVersion: 'swe-rebench-v2-solution.v1',
    patch: '',
    venueRef: { name: 'placeholder-from-harvest', version: '0' },
  }),
}));

describe('runHarnessWithFreezeFence on HermesHarness', () => {
  it('rolls back HERMES_HOME on frozen-mode mutation and reports violation', async () => {
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
        task: {
          id: 't',
          solverType: 'swe-rebench-v2.v1',
          role: 'restoration',
          window: { startTs: 0, endTs: Date.now() + 60_000 },
          spec: {},
        },
        requestId: 'r',
        implStateDir: home,
        workingDir: work,
        mode: 'frozen' as const,
        abort: new AbortController().signal,
        msUntilEndTs: () => 60_000,
        solverPluginRoots: [],
      } as unknown as HarnessContext;

      const result = await runHarnessWithFreezeFence(harness, ctx);

      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.violation.harnessName).toBe('hermes-agent');
        expect(result.violation.stateHashBefore).not.toBe(result.violation.stateHashAfter);
      }
      // Rollback restored the snapshot: before.txt survives, violation.txt is gone.
      expect(() => readFileSync(join(home, 'violation.txt'))).toThrow();
      expect(readFileSync(join(home, 'before.txt'), 'utf8')).toBe('snapshot');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('train mode lets HERMES_HOME mutations persist (Hermes continuous learning)', async () => {
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
        task: {
          id: 't',
          solverType: 'swe-rebench-v2.v1',
          role: 'restoration',
          window: { startTs: 0, endTs: Date.now() + 60_000 },
          spec: {},
        },
        requestId: 'r',
        implStateDir: home,
        workingDir: work,
        mode: 'train' as const,
        abort: new AbortController().signal,
        msUntilEndTs: () => 60_000,
        solverPluginRoots: [],
      } as unknown as HarnessContext;

      const result = await runHarnessWithFreezeFence(harness, ctx);

      expect(result.ok).toBe(true);
      expect(readFileSync(join(home, 'learned.txt'), 'utf8')).toBe('continuous learning');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
