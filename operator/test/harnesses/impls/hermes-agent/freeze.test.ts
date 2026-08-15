// operator/test/harnesses/impls/hermes-agent/freeze.test.ts
//
// Validates that the SHARED daemon hash-fence (the one the engine actually
// invokes for every Harness) honors the freeze contract on HERMES_HOME when
// the harness is a HermesHarness. The hermes-agent package no longer ships
// a wrapper around the fence — the engine wires every Harness through
// `runHarnessWithFreezeFence` directly, and we test that production path.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import { runHarnessWithFreezeFence } from '../../../../src/daemon/freeze-fence.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

vi.mock('../../../../src/harnesses/impls/learner/harvest.js', () => ({
  harvestOutput: async () => ({
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

  it('frozen mode allows Hermes runtime-only auth and config refreshes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-frozen-runtime-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-frozen-runtime-wd-'));
    writeFileSync(join(home, 'before.txt'), 'snapshot');

    try {
      const fakeAdapter = {
        name: 'hermes-agent',
        runTask: async () => {
          mkdirSync(join(home, 'auth'), { recursive: true });
          mkdirSync(join(home, 'bin'), { recursive: true });
          writeFileSync(join(home, 'auth', 'google_oauth.json'), '{"access_token":"refreshed"}');
          writeFileSync(join(home, 'auth.json'), '{"pooled":true}');
          writeFileSync(join(home, 'bin', 'tirith'), '#!/bin/sh\n');
          writeFileSync(join(home, '.env'), 'DAEMON_API_URL=http://127.0.0.1:1\n');
          writeFileSync(join(home, 'config.yaml'), 'terminal:\n  backend: local\n');
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

      expect(result.ok).toBe(true);
      expect(readFileSync(join(home, 'auth', 'google_oauth.json'), 'utf8')).toContain('refreshed');
      expect(readFileSync(join(home, 'before.txt'), 'utf8')).toBe('snapshot');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('frozen mode still fences non-tirith binaries in Hermes bin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-frozen-bin-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-frozen-bin-wd-'));
    writeFileSync(join(home, 'before.txt'), 'snapshot');

    try {
      const fakeAdapter = {
        name: 'hermes-agent',
        runTask: async () => {
          mkdirSync(join(home, 'bin'), { recursive: true });
          writeFileSync(join(home, 'bin', 'unexpected-tool'), '#!/bin/sh\n');
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
      expect(() => readFileSync(join(home, 'bin', 'unexpected-tool'))).toThrow();
      expect(readFileSync(join(home, 'before.txt'), 'utf8')).toBe('snapshot');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
