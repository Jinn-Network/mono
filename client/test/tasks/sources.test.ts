/**
 * sources.ts — TaskCandidate shape and task preservation.
 *
 * Verifies that both StaticConfiguredTaskSource and GeneratedTaskSource
 * pass the Task through to TaskCandidate.task unchanged,
 * including an embedded SignedTaskV1 when present.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  StaticConfiguredTaskSource,
  GeneratedTaskSource,
} from '../../src/tasks/sources.js';
import type { SignedTaskV1 } from '../../src/types/task-document.js';
import type { Task } from '../../src/types/task.js';

const STUB_INTENT: SignedTaskV1 = {
  schemaVersion: 'task.v1',
  id: 'sources-test-task',
  solverType: 'health_check',
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

  it('uses Polymarket conditionId as generated bucketKey', async () => {
    const job: Task = {
      id: 'prediction-v1',
      description: 'prediction',
      solverType: 'prediction.v1',
      spec: {
        question: { text: 'Will test pass?' },
        source: {
          venue: 'polymarket',
          url: 'https://polymarket.com/event/test-market',
          identifiers: { conditionId: '0xabc' },
        },
      },
      window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
    };
    const generator = vi.fn(async () => job);
    const source = new GeneratedTaskSource('gen:prediction.v1', generator);
    const [candidate] = await source.collect(new Date());

    const policy = candidate.postingPolicy as { kind: 'once_per_bucket'; bucketKey: string };
    expect(policy.bucketKey).toBe('polymarket:0xabc');
  });

  it('falls back to normalized source URL when conditionId is unavailable', async () => {
    const job: Task = {
      id: 'prediction-v1',
      description: 'prediction',
      solverType: 'prediction.v1',
      spec: {
        question: { text: 'Will test pass?' },
        source: {
          venue: 'polymarket',
          url: 'https://polymarket.com/event/Test Market!',
          identifiers: {},
        },
      },
      window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
    };
    const generator = vi.fn(async () => job);
    const source = new GeneratedTaskSource('gen:prediction.v1', generator);
    const [candidate] = await source.collect(new Date());

    const policy = candidate.postingPolicy as { kind: 'once_per_bucket'; bucketKey: string };
    expect(policy.bucketKey).toBe('polymarket:polymarket-com-event-test-market');
  });

  it('wraps multiple generated Tasks from one poll', async () => {
    const jobs: Task[] = [
      { id: 'gen-1', description: 'first', window: { startTs: 1, endTs: 2 } },
      { id: 'gen-2', description: 'second', window: { startTs: 3, endTs: 4 } },
    ];
    const generator = vi.fn(async () => jobs);
    const source = new GeneratedTaskSource('gen:batch', generator);
    const candidates = await source.collect(new Date());

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.task.id)).toEqual(['gen-1', 'gen-2']);
    expect(candidates.map((candidate) => candidate.sourceKey)).toEqual(['gen:batch', 'gen:batch']);
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
