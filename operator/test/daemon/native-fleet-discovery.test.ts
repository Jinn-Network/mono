/**
 * The fleet daemon's native discovery selection and the honest `canonicalFinalized`
 * (one-swap M3, umbrella #2461).
 *
 * M2 shipped `canonicalFinalized: async () => false` on the fleet path with a comment that it
 * "must NOT become `true` without that decode landing". This file is the replacement pin: the
 * predicate is asserted in both directions, and the reason it is a structural fact rather than an
 * optimistic default is asserted at the source — a card only carries `discovery` provenance
 * because `createNativeDiscoveryConsumer` queued it, and it only queues what the decode returned.
 */
import { describe, expect, it } from 'vitest';
import {
  NativeFleetDiscoveryError,
  nativeDiscoveryDecodeProvedCanonical,
  selectFleetRequesterSources,
} from '../../src/daemon/native-fleet-discovery.js';
import type { AnnouncedSubmissionCard } from '../../src/daemon/native-submission-facts.js';
import type { NativeRecordSource } from '../../src/config/native-sections.js';

const REQUESTER: NativeRecordSource = {
  role: 'requester',
  agent: 'did:key:zRequester',
  name: 'requester',
  baseUrl: 'https://requester.example',
};
const EVALUATOR: NativeRecordSource = {
  role: 'evaluator',
  agent: 'did:key:zEvaluator',
  name: 'evaluator',
  baseUrl: 'https://evaluator.example',
};

function card(overrides: Partial<AnnouncedSubmissionCard> = {}): AnnouncedSubmissionCard {
  return {
    record: { kind: 'https://spec.jinn.network/records/submission/v1', digest: `sha256:${'b'.repeat(64)}` },
    facts: { taskDigest: `sha256:${'a'.repeat(64)}` },
    chain: {
      taskId: 7n,
      submission: 'urn:uuid:33333333-3333-4333-8333-333333333333',
      nonce: '1',
      intendedSpendWei: 0n,
    },
    ...overrides,
  };
}

describe('selectFleetRequesterSources', () => {
  it('refuses native boot when no record sources are configured at all', () => {
    expect(() => selectFleetRequesterSources(undefined)).toThrow(NativeFleetDiscoveryError);
    // Named, not silent: a native daemon polling nothing would look healthy and claim nothing.
    expect(() => selectFleetRequesterSources(undefined))
      .toThrow(/requires config\.recordSources/u);
  });

  it('takes the one requester source and ignores roles later milestones own', () => {
    // An operator who configured an evaluator source ahead of M4 must still boot the solver loop.
    expect(selectFleetRequesterSources([EVALUATOR, REQUESTER])).toEqual([REQUESTER]);
  });

  it('refuses zero or more than one requester source', () => {
    expect(() => selectFleetRequesterSources([EVALUATOR]))
      .toThrow(/exactly one requester record source, found 0/u);
    expect(() => selectFleetRequesterSources([
      REQUESTER,
      { ...REQUESTER, agent: 'did:key:zOther', name: 'other' },
    ])).toThrow(/exactly one requester record source, found 2/u);
  });
});

describe('nativeDiscoveryDecodeProvedCanonical', () => {
  it('is true exactly for a card the verified discovery consumer queued', () => {
    expect(nativeDiscoveryDecodeProvedCanonical(card({
      discovery: {
        source: { agent: 'did:key:zRequester', name: 'requester' },
        sequence: '0000000000000001',
        entryDigest: `sha256:${'e'.repeat(64)}`,
        signedHighWater: {
          sequence: '0000000000000001',
          entry: `sha256:${'e'.repeat(64)}`,
          issuedAt: '2026-08-02T01:00:00.000Z',
          refreshBy: '2026-08-03T01:00:00.000Z',
          signature: {},
        },
      },
    }))).toBe(true);
  });

  it('stays false for any card that did not come through the decode', () => {
    // This is M2's refusal, preserved rather than replaced: a legacy-bridged or archive-sourced
    // card carries no discovery provenance, so nothing proved its TaskCreated canonical and
    // finalized, so `evaluateNativeClaim` must still refuse it on `finality-policy`.
    expect(nativeDiscoveryDecodeProvedCanonical(card())).toBe(false);
    expect(nativeDiscoveryDecodeProvedCanonical(card({ derivationKind: 'legacy' }))).toBe(false);
  });
});

describe('the fleet runtime wires the honest predicate, not a literal', () => {
  it('has no `canonicalFinalized: async () => false` left in the fleet runtime', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      join(resolve(dirname(fileURLToPath(import.meta.url)), '../../src'), 'daemon/native-fleet-runtime.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/canonicalFinalized:\s*async\s*\(\)\s*=>\s*(false|true)/u);
    expect(source).toMatch(/canonicalFinalized:\s*async\s*\(card\)\s*=>\s*nativeDiscoveryDecodeProvedCanonical\(card\)/u);
  });
});
