/**
 * sources.ts — IntentCandidate shape and intent preservation.
 *
 * Verifies that both StaticConfiguredIntentSource and GeneratedIntentSource
 * pass the RestorationJob through to IntentCandidate.restorationJob unchanged,
 * including an embedded SignedIntentV1 when present.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  StaticConfiguredIntentSource,
  GeneratedIntentSource,
} from '../../src/intents/sources.js';
import type { SignedIntentV1 } from '../../src/types/intent.js';
import type { RestorationJob } from '../../src/types/desired-state.js';

const STUB_INTENT: SignedIntentV1 = {
  schemaVersion: 'intent.v1',
  id: 'sources-test-intent',
  kind: 'health_check',
  description: 'sources test',
  window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
  spec: { kind: 'health_check' },
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

describe('StaticConfiguredIntentSource', () => {
  it('emits one candidate per configured RestorationJob with once_per_safe policy', async () => {
    const jobs: RestorationJob[] = [
      { id: 'ds-1', description: 'first' },
      { id: 'ds-2', description: 'second' },
    ];
    const source = new StaticConfiguredIntentSource(jobs);
    const candidates = await source.collect(new Date());

    expect(candidates).toHaveLength(2);
    expect(candidates[0].sourceKey).toBe('configured:ds-1');
    expect(candidates[1].sourceKey).toBe('configured:ds-2');
    expect(candidates[0].postingPolicy).toEqual({ kind: 'once_per_safe' });
    expect(candidates[0].restorationJob).toBe(jobs[0]);
    expect(candidates[1].restorationJob).toBe(jobs[1]);
  });

  it('preserves embedded SignedIntentV1 on the restorationJob unchanged', async () => {
    const job: RestorationJob = {
      id: 'sources-test-intent',
      description: 'sources test',
      intent: STUB_INTENT,
    };
    const source = new StaticConfiguredIntentSource([job]);
    const [candidate] = await source.collect(new Date());

    expect(candidate.restorationJob.intent).toBe(STUB_INTENT);
  });

  it('sets sourceMeta.kind from spec.kind when present', async () => {
    const job: RestorationJob = {
      id: 'typed-1',
      description: 'typed',
      spec: { kind: 'prediction.v0' },
    };
    const source = new StaticConfiguredIntentSource([job]);
    const [candidate] = await source.collect(new Date());

    expect(candidate.sourceMeta?.kind).toBe('prediction.v0');
  });

  it('returns empty array for an empty desiredStates list', async () => {
    const source = new StaticConfiguredIntentSource([]);
    const candidates = await source.collect(new Date());
    expect(candidates).toHaveLength(0);
  });
});

describe('GeneratedIntentSource', () => {
  it('calls the generator and wraps the result in once_per_bucket candidate', async () => {
    const job: RestorationJob = {
      id: 'gen-1',
      description: 'generated',
      window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
    };
    const generator = vi.fn(async () => job);
    const source = new GeneratedIntentSource('gen:prediction.v0', generator);
    const candidates = await source.collect(new Date());

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceKey).toBe('gen:prediction.v0');
    expect(candidates[0].postingPolicy.kind).toBe('once_per_bucket');
    expect(candidates[0].restorationJob).toBe(job);
  });

  it('returns empty array when generator returns null', async () => {
    const generator = vi.fn(async () => null);
    const source = new GeneratedIntentSource('gen:skip', generator);
    const candidates = await source.collect(new Date());
    expect(candidates).toHaveLength(0);
  });

  it('preserves embedded SignedIntentV1 on the generated RestorationJob unchanged', async () => {
    const job: RestorationJob = {
      id: 'sources-test-intent',
      description: 'sources test',
      window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
      intent: STUB_INTENT,
    };
    const generator = vi.fn(async () => job);
    const source = new GeneratedIntentSource('gen:signed', generator);
    const [candidate] = await source.collect(new Date());

    expect(candidate.restorationJob.intent).toBe(STUB_INTENT);
  });

  it('uses window boundaries as bucketKey when window is present', async () => {
    const job: RestorationJob = {
      id: 'windowed-1',
      description: 'windowed',
      window: { startTs: 1_700_000_000_000, endTs: 1_700_003_600_000 },
    };
    const generator = vi.fn(async () => job);
    const source = new GeneratedIntentSource('gen:windowed', generator);
    const [candidate] = await source.collect(new Date());

    const policy = candidate.postingPolicy as { kind: 'once_per_bucket'; bucketKey: string };
    expect(policy.bucketKey).toBe('1700000000000:1700003600000');
  });

  it('falls back to id as bucketKey when no window', async () => {
    const job: RestorationJob = { id: 'no-window-1', description: 'no window' };
    const generator = vi.fn(async () => job);
    const source = new GeneratedIntentSource('gen:no-window', generator);
    const [candidate] = await source.collect(new Date());

    const policy = candidate.postingPolicy as { kind: 'once_per_bucket'; bucketKey: string };
    expect(policy.bucketKey).toBe('no-window-1');
  });
});
