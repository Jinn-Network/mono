import { describe, expect, it, vi } from 'vitest';
import type { BindingResolver } from '@jinn-network/trust-core';
import {
  NativeConsumerSettlementAuthorityError,
  buildConsumerTrustPorts,
  discoverySourceBindingResolver,
  resolveSettlementAuthority,
} from '../../src/native-consumer/trust.js';
import { fakeTrust } from '../_support/native-trust.js';

describe('buildConsumerTrustPorts', () => {
  it('passes bindingResolver, witnessVerifier, and dsseVerifier through unchanged (identity-preserved)', () => {
    const trust = fakeTrust();

    const ports = buildConsumerTrustPorts(trust);

    // Regression for a graduation-time fix: `authenticateRequester`'s ports object once omitted
    // `witnessVerifier` entirely (a fixture-only omission tsc had never checked). If this mapping
    // ever again drops the field, this assertion -- not just the type checker -- fails.
    expect(ports.bindingResolver).toBe(trust.bindingResolver);
    expect(ports.witnessVerifier).toBe(trust.witnessVerifier);
    expect(ports.dsseVerifier).toBe(trust.dsseVerifier);
  });

  it('maps each of the four signing roles to its own native: purpose', () => {
    const trust = fakeTrust();
    const policySpy = vi.spyOn(trust, 'policy');

    const ports = buildConsumerTrustPorts(trust);

    expect(policySpy.mock.calls.map(([purpose]) => purpose).sort()).toEqual([
      'native:admission', 'native:evaluator-verdict', 'native:requester-submission', 'native:solver-delivery',
    ]);
    expect(ports.policies).toEqual({
      requester: { accepted: ['accepted-for-native:requester-submission'], requiredStrength: 'strong' },
      admission: { accepted: ['accepted-for-native:admission'], requiredStrength: 'strong' },
      executor: { accepted: ['accepted-for-native:solver-delivery'], requiredStrength: 'strong' },
      evaluator: { accepted: ['accepted-for-native:evaluator-verdict'], requiredStrength: 'strong' },
    });
  });
});

describe('discoverySourceBindingResolver', () => {
  it('scopes resolverFor to the observations family and the given purpose', () => {
    const resolver: BindingResolver = { async resolveBinding() { return null; } };
    const resolverForSpy = vi.fn().mockReturnValue(resolver);
    const trust = fakeTrust({ resolverFor: resolverForSpy });

    const result = discoverySourceBindingResolver(trust, 'native:solver-discovery');

    expect(resolverForSpy).toHaveBeenCalledWith({ family: 'observations', purpose: 'native:solver-discovery' });
    expect(result).toBe(resolver);
  });
});

describe('resolveSettlementAuthority', () => {
  const ADDRESS = '0x2222222222222222222222222222222222222222' as const;

  it('returns the binding digest when the trust catalog confirms the on-chain authority', async () => {
    const bindingDigest = `sha256:${'7'.repeat(64)}` as const;
    const trust = fakeTrust({ async verifyOnchainAuthority() { return { bindingDigest }; } });

    const result = await resolveSettlementAuthority({
      trust, agent: 'https://agents.example/solver', declarationKey: 'did:key:zSolverDeclaration',
      address: ADDRESS, atTime: '2026-08-02T12:30:00Z', purpose: 'native:solver-settlement',
    });

    expect(result).toEqual({ bindingDigest });
  });

  it('fails closed with a typed error when the catalog does not bind the address to the agent', async () => {
    const trust = fakeTrust({
      async verifyOnchainAuthority() { throw new Error('settlement authority did not resolve'); },
    });

    await expect(resolveSettlementAuthority({
      trust, agent: 'https://agents.example/evaluator', declarationKey: 'did:key:zEvaluatorDeclaration',
      address: ADDRESS, atTime: '2026-08-02T12:50:00Z', purpose: 'native:evaluator-settlement',
    })).rejects.toThrow(NativeConsumerSettlementAuthorityError);
  });
});
