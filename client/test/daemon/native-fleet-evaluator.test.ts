/**
 * Fleet evaluator boot-inertness and self-evaluation refusal (one-swap M4a, umbrella #2461).
 *
 * These pin two properties that must not silently regress:
 *  - a config that did not opt into an evaluator constructs NO evaluator composition/loop; and
 *  - the fleet operator identity triple (`safeAddress`, agent EOA, agent IRI) the composition is
 *    handed refuses self-evaluation before any evaluation work starts.
 */
import { describe, expect, it } from 'vitest';
import type { MarketplaceEvent } from '@jinn-network/marketplace-projector';
import { fleetEvaluatorConfigured } from '../../src/daemon/native-fleet-evaluator.js';
import {
  mapFinalizedSolutionDeliveryObservation,
  type FinalizedSolutionDeliveryObservation,
} from '../../src/evaluator/opportunities.js';
import type { OperatorIdentity } from '../../src/evaluator/self-evaluation.js';

describe('fleet evaluator boot-inertness', () => {
  it('is NOT configured for a default config (no evaluator, no evaluator identity store)', () => {
    expect(fleetEvaluatorConfigured({} as never)).toBe(false);
  });

  it('is NOT configured for a native solver-only operator (evaluator deployment absent)', () => {
    expect(fleetEvaluatorConfigured({
      identityStores: { solver: '/tmp/solver.enc.json', requester: '/tmp/requester.enc.json' },
    } as never)).toBe(false);
  });

  it('is NOT configured when the evaluator identity store is absent even though a deployment is set', () => {
    expect(fleetEvaluatorConfigured({
      evaluator: {
        deploymentModule: '/opt/evaluator.mjs',
        moduleDigest: `sha256:${'a'.repeat(64)}`,
        signerHandle: 'h',
        evaluationMethodDigest: `sha256:${'b'.repeat(64)}`,
      },
      identityStores: { solver: '/tmp/solver.enc.json' },
    } as never)).toBe(false);
  });

  it('IS configured only when both the evaluator deployment and the evaluator identity store are present', () => {
    expect(fleetEvaluatorConfigured({
      evaluator: {
        deploymentModule: '/opt/evaluator.mjs',
        moduleDigest: `sha256:${'a'.repeat(64)}`,
        signerHandle: 'h',
        evaluationMethodDigest: `sha256:${'b'.repeat(64)}`,
      },
      identityStores: { evaluator: '/tmp/evaluator.enc.json' },
    } as never)).toBe(true);
  });
});

/** A canonical, finalized solution-delivery observation whose on-chain operator is `operator`. */
function observationFor(operator: string): FinalizedSolutionDeliveryObservation {
  return {
    source: 'urn:jinn:solver/solver-records',
    sourceSequence: '1',
    sourceEntryDigest: `sha256:${'c'.repeat(64)}`,
    advertisedDeliveryDigest: `sha256:${'d'.repeat(64)}`,
    canonical: true,
    event: {
      event: 'SolutionDeliveryClaimed',
      derivation: {
        chainId: 84532,
        blockHash: `0x${'e'.repeat(64)}`,
        blockNumber: 100,
        txHash: `0x${'f'.repeat(64)}`,
        logIndex: 0,
        finalityTier: 'finalized',
      },
      facts: { taskId: 7n, attemptIndex: 0, requestId: `0x${'1'.repeat(64)}`, operator },
    } as unknown as Extract<MarketplaceEvent, { event: 'SolutionDeliveryClaimed' }>,
  };
}

describe('fleet evaluator refuses self-evaluation for its own solution', () => {
  const SAFE = '0x1111111111111111111111111111111111111111';
  const AGENT_EOA = '0x2222222222222222222222222222222222222222';
  // Exactly the triple `buildFleetNativeEvaluator` hands the composition as `operatorIdentity`
  // (safeAddress, the agent EOA that operates this operator's mech, the shared Agent IRI).
  const fleetIdentity: OperatorIdentity = {
    safeAddress: SAFE,
    agentEoa: AGENT_EOA,
    agentIri: 'urn:jinn:operator:fleet-one',
  };

  it('skips a solution delivered by this operator’s own Safe', () => {
    const mapping = mapFinalizedSolutionDeliveryObservation(observationFor(SAFE), fleetIdentity);
    expect(mapping.kind).toBe('skipped');
    if (mapping.kind === 'skipped') expect(mapping.reason).toBe('own-solution-safe');
  });

  it('skips a solution delivered by this operator’s own agent EOA', () => {
    const mapping = mapFinalizedSolutionDeliveryObservation(observationFor(AGENT_EOA), fleetIdentity);
    expect(mapping.kind).toBe('skipped');
    if (mapping.kind === 'skipped') expect(mapping.reason).toBe('own-solution-eoa');
  });

  it('admits a solution delivered by a DISTINCT operator', () => {
    const other = '0x3333333333333333333333333333333333333333';
    const mapping = mapFinalizedSolutionDeliveryObservation(observationFor(other), fleetIdentity);
    expect(mapping.kind).toBe('opportunity');
  });
});
