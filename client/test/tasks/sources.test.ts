/**
 * sources.ts — TaskCandidate shape and task preservation.
 *
 * Verifies that both StaticConfiguredTaskSource and GeneratedTaskSource
 * pass the Task through to TaskCandidate.task unchanged,
 * including an embedded SignedTaskV1 when present.
 *
 * Also covers the un-bindable-entry guard (issue #415): filterBindableTasks
 * drops tasks[] entries without a solverNetManifestCid with a one-time warning,
 * preventing them from entering the creator loop and causing recurring TICK ERRORs.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  StaticConfiguredTaskSource,
  GeneratedTaskSource,
  filterBindableTasks,
} from '../../src/tasks/sources.js';
import type { SignedTaskV1 } from '../../src/types/task-document.js';
import type { Task } from '../../src/types/task.js';

const STUB_INTENT: SignedTaskV1 = {
  schemaVersion: 'task.v1',
  id: 'sources-test-task',
  solverType: 'health_check',
  contractId: 'health',
  contractVersion: 'v0',
  solverNetManifestCid: 'bafyfixturecid',
  role: 'restoration',
  description: 'sources test',
  window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
  spec: {},
  eligibility: {},
  creator: {
    safeAddress: '0x0000000000000000000000000000000000000001',
    agentEoa: '0x0000000000000000000000000000000000000002',
  },
  createdAt: 1_700_000_000_000,
  signature: {
    algo: 'secp256k1',
    signer: '0x0000000000000000000000000000000000000002',
    hash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    sig: '0xcafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe01',
  },
};

// ── Regression: issue #415 — un-bindable tasks[] entries ─────────────────────
//
// filterBindableTasks is the production guard called in main.ts before passing
// config.tasks to StaticConfiguredTaskSource. It drops entries without
// solverNetManifestCid at startup (one-time warning per dropped entry) so they
// never enter the creator loop and cause recurring TICK ERRORs.

describe('filterBindableTasks — un-bindable entry guard (issue #415)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('drops a tasks[] entry missing solverNetManifestCid and emits one warning', () => {
    const unbindable: Task = { id: 'legacy-health-check', description: 'health check' };
    const result = filterBindableTasks([unbindable]);

    expect(result).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg] = warnSpy.mock.calls[0] as [string, ...unknown[]];
    expect(msg).toContain('legacy-health-check');
    expect(msg).toContain('solverNetManifestCid');
  });

  it('does not warn or drop an entry that has solverNetManifestCid', () => {
    const bindable: Task = {
      id: 'valid-task',
      description: 'has a manifest',
      solverNetManifestCid: 'bafyfixturecid',
    };
    const result = filterBindableTasks([bindable]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(bindable);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops un-bindable entries while keeping bindable ones in a mixed list', () => {
    const legacy: Task = { id: 'old-entry', description: 'no manifest' };
    const valid: Task = {
      id: 'new-entry',
      description: 'has manifest',
      solverNetManifestCid: 'bafyfixturecid2',
    };
    const result = filterBindableTasks([legacy, valid]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('new-entry');
    // One warning for the one un-bindable entry
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('emits one warning per dropped entry, not per tick', () => {
    const legacy: Task = { id: 'no-manifest', description: 'legacy' };
    // filterBindableTasks is called once at startup — verify it warns once per entry
    filterBindableTasks([legacy]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockClear();

    // Calling again with the same list (simulating a second daemon startup)
    // also warns once — confirming the warning is per-call, not accumulating
    filterBindableTasks([legacy]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Existing tests ─────────────────────────────────────────────────────────────

describe('StaticConfiguredTaskSource', () => {
  it('emits one candidate per configured Task with once_per_safe policy', async () => {
    const jobs: Task[] = [
      { id: 'ds-1', description: 'first' },
      { id: 'ds-2', description: 'second' },
    ];
    const source = new StaticConfiguredTaskSource(jobs);
    const candidates = await source.collect(new Date());

    expect(candidates).toHaveLength(2);
    expect(candidates[0].sourceKey).toBe('configured:ds-1');
    expect(candidates[1].sourceKey).toBe('configured:ds-2');
    expect(candidates[0].postingPolicy).toEqual({ kind: 'once_per_safe' });
    expect(candidates[0].task).toBe(jobs[0]);
    expect(candidates[1].task).toBe(jobs[1]);
  });

  it('preserves embedded SignedTaskV1 on the task unchanged', async () => {
    const job: Task = {
      id: 'sources-test-task',
      description: 'sources test',
      signedTask: STUB_INTENT,
    };
    const source = new StaticConfiguredTaskSource([job]);
    const [candidate] = await source.collect(new Date());

    expect(candidate.task.signedTask).toBe(STUB_INTENT);
  });

  it('sets sourceMeta.solverType from solverType when present', async () => {
    const job: Task = {
      id: 'typed-1',
      description: 'typed',
      solverType: 'prediction.v0',
      spec: {},
    };
    const source = new StaticConfiguredTaskSource([job]);
    const [candidate] = await source.collect(new Date());

    expect(candidate.sourceMeta?.solverType).toBe('prediction.v0');
  });

  it('returns empty array for an empty tasks list', async () => {
    const source = new StaticConfiguredTaskSource([]);
    const candidates = await source.collect(new Date());
    expect(candidates).toHaveLength(0);
  });
});

describe('GeneratedTaskSource', () => {
  it('calls the generator and wraps the result in once_per_bucket candidate', async () => {
    const job: Task = {
      id: 'gen-1',
      description: 'generated',
      window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
    };
    const generator = vi.fn(async () => job);
    const source = new GeneratedTaskSource('gen:prediction.v0', generator);
    const candidates = await source.collect(new Date());

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceKey).toBe('gen:prediction.v0');
    expect(candidates[0].postingPolicy.kind).toBe('once_per_bucket');
    expect(candidates[0].task).toBe(job);
  });

  it('returns empty array when generator returns null', async () => {
    const generator = vi.fn(async () => null);
    const source = new GeneratedTaskSource('gen:skip', generator);
    const candidates = await source.collect(new Date());
    expect(candidates).toHaveLength(0);
  });

  it('preserves embedded SignedTaskV1 on the generated Task unchanged', async () => {
    const job: Task = {
      id: 'sources-test-task',
      description: 'sources test',
      window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
      signedTask: STUB_INTENT,
    };
    const generator = vi.fn(async () => job);
    const source = new GeneratedTaskSource('gen:signed', generator);
    const [candidate] = await source.collect(new Date());

    expect(candidate.task.signedTask).toBe(STUB_INTENT);
  });

  it('uses window boundaries as bucketKey when window is present', async () => {
    const job: Task = {
      id: 'windowed-1',
      description: 'windowed',
      window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
    };
    const generator = vi.fn(async () => job);
    const source = new GeneratedTaskSource('gen:windowed', generator);
    const [candidate] = await source.collect(new Date());

    const policy = candidate.postingPolicy as { kind: 'once_per_bucket'; bucketKey: string };
    expect(policy.bucketKey).toBe('1700000000000:1700003600000');
  });

  it('uses configured bucket override when supplied', async () => {
    const jobs: Task[] = [
      {
        id: 'generated-a',
        description: 'first generated',
        window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
      },
      {
        id: 'generated-b',
        description: 'second generated',
        window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
      },
    ];
    const generator = vi.fn(async () => jobs);
    const source = new GeneratedTaskSource('gen:batch', generator, {
      bucketKeyForTask: (task, index) => `override:${task.id}:${index}`,
    });

    const candidates = await source.collect(new Date());

    expect(candidates.map((candidate) => candidate.sourceMeta?.bucketKey)).toEqual([
      'override:generated-a:0',
      'override:generated-b:1',
    ]);
    expect(candidates.map((candidate) => candidate.postingPolicy)).toEqual([
      { kind: 'once_per_bucket', bucketKey: 'override:generated-a:0' },
      { kind: 'once_per_bucket', bucketKey: 'override:generated-b:1' },
    ]);
  });

  it('falls back to id as bucketKey when no window', async () => {
    const job: Task = { id: 'no-window-1', description: 'no window' };
    const generator = vi.fn(async () => job);
    const source = new GeneratedTaskSource('gen:no-window', generator);
    const [candidate] = await source.collect(new Date());

    const policy = candidate.postingPolicy as { kind: 'once_per_bucket'; bucketKey: string };
    expect(policy.bucketKey).toBe('no-window-1');
  });
});
