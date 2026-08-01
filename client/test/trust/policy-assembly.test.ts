import { describe, it, expect } from 'vitest';
import {
  buildPolicyFixture,
  createFakeResolvers,
  testAgentIri,
  testDidKey,
} from '@jinn-network/trust-testing';
import { assembleVerdictPolicies, TrustPolicyUnavailableError } from '../../src/trust/policy-assembly.js';

const NOW = '2026-07-30T00:00:00.000Z';
const dsseVerifier = createFakeResolvers().dsseVerifier;

describe('assembleVerdictPolicies', () => {
  it('projects each registered purpose onto its PolicyCheckInput', async () => {
    const admissionAgent = testAgentIri('stage2-admission');
    const evaluator = testAgentIri('stage2-evaluator');
    const fixture = await buildPolicyFixture({
      purposes: {
        'admission-agent': { accepted: [admissionAgent], requiredStrength: 'strong' },
        'evaluator-eligibility': { accepted: [evaluator], requiredStrength: 'weak' },
      },
      refreshBy: '2027-01-01T00:00:00.000Z',
      signerKeyid: testDidKey('stage2-policy'),
    });

    const assembled = assembleVerdictPolicies({
      policyVersions: [fixture.envelopeBytes],
      genesisDigest: fixture.digest,
      now: NOW,
      dsseVerifier,
    });

    expect(assembled.admissionAgentPolicy).toEqual({ accepted: [admissionAgent], requiredStrength: 'strong' });
    expect(assembled.evaluatorPolicy).toEqual({ accepted: [evaluator], requiredStrength: 'weak' });
    expect(assembled.requesterPolicy).toBeUndefined();
  });

  it('fails closed when the chain does not verify', async () => {
    const fixture = await buildPolicyFixture({
      purposes: { 'admission-agent': { accepted: [testAgentIri('a')], requiredStrength: 'weak' } },
      refreshBy: '2025-01-01T00:00:00.000Z',
      signerKeyid: testDidKey('stage2-expired'),
    });
    expect(() => assembleVerdictPolicies({
      policyVersions: [fixture.envelopeBytes],
      genesisDigest: fixture.digest,
      now: NOW,
      dsseVerifier,
    })).toThrow(TrustPolicyUnavailableError);
  });

  it('refuses to assemble without an admission-agent purpose', async () => {
    const fixture = await buildPolicyFixture({
      purposes: { 'verifier-agent': { accepted: [testAgentIri('v')], requiredStrength: 'weak' } },
      refreshBy: '2027-01-01T00:00:00.000Z',
      signerKeyid: testDidKey('stage2-no-admission'),
    });
    expect(() => assembleVerdictPolicies({
      policyVersions: [fixture.envelopeBytes],
      genesisDigest: fixture.digest,
      now: NOW,
      dsseVerifier,
    })).toThrow(/admission-agent/);
  });
});
