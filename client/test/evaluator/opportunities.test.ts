import { describe, it, expect, vi } from 'vitest';
import { computeRawCodecCid, keccakEvidenceHash } from '@jinn-network/marketplace-binding';
import { createOpportunitySource } from '../../src/evaluator/opportunities.js';

const identity = {
  safeAddress: '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa',
  agentEoa: '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb',
  agentIri: 'https://agents.example/jinn/operator-1',
};

const deliveryBytes = new TextEncoder().encode('solution delivery fixture');
const { cid: expectedDeliveryCid, sha256Digest } = computeRawCodecCid(deliveryBytes);

function solutionClaimed(operator: string) {
  return {
    event: 'SolutionDeliveryClaimed',
    facts: {
      taskId: 7n,
      attemptIndex: 1,
      requestId: `0x${'cd'.repeat(32)}`,
      operator,
    },
    derivation: { chainId: 84532, blockHash: `0x${'ee'.repeat(32)}` },
    projection: {
      deliveryCorrespondence: {
        sha256Digest,
        keccakEvidenceHash: keccakEvidenceHash(deliveryBytes),
        onChainSha256CidDigest: sha256Digest,
        onChainKeccak: `0x${'cc'.repeat(32)}`,
      },
    },
  } as never;
}

describe('createOpportunitySource', () => {
  it('emits an opportunity for another operator\'s claimed solution delivery', () => {
    let emit: (event: never) => void = () => {};
    const source = createOpportunitySource({
      subscribeObservations: (handler) => { emit = handler as never; return () => {}; },
      identity,
    });
    const seen: unknown[] = [];
    source.subscribe((opportunity) => seen.push(opportunity));
    emit(solutionClaimed('0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      taskId: 7n,
      attemptIndex: 1,
      deliveryCid: expectedDeliveryCid,
    });
  });

  it('never emits an opportunity for the operator\'s own solution and reports the skip', () => {
    let emit: (event: never) => void = () => {};
    const onSkip = vi.fn();
    const source = createOpportunitySource({
      subscribeObservations: (handler) => { emit = handler as never; return () => {}; },
      identity,
      onSkip,
    });
    const seen: unknown[] = [];
    source.subscribe((opportunity) => seen.push(opportunity));
    emit(solutionClaimed(identity.safeAddress));
    expect(seen).toHaveLength(0);
    expect(onSkip).toHaveBeenCalledWith('own-solution-safe', 7n, 1);
  });

  it('ignores verdict-delivery events — an evaluation is never an evaluation opportunity', () => {
    let emit: (event: never) => void = () => {};
    const source = createOpportunitySource({
      subscribeObservations: (handler) => { emit = handler as never; return () => {}; },
      identity,
    });
    const seen: unknown[] = [];
    source.subscribe((opportunity) => seen.push(opportunity));
    emit({ ...(solutionClaimed('0xCC') as object), event: 'VerdictDeliveryClaimed' } as never);
    expect(seen).toHaveLength(0);
  });
});
