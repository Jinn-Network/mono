import type { BindingResolver, DsseChainVerifier, WitnessVerifier } from '@jinn-network/trust-core';
import type { NativeTrustAuthority } from '../../src/daemon/native-trust-catalog.js';

/**
 * A trust authority double that resolves nothing and verifies nothing. Pass
 * `overrides` to replace any member a test exercises.
 */
export function fakeTrust(overrides: Partial<NativeTrustAuthority> = {}): NativeTrustAuthority {
  const bindingResolver: BindingResolver = { async resolveBinding() { return null; } };
  const witnessVerifier: WitnessVerifier = {
    async verify1271Witness() { return { verified: false, reason: 'fixture never verifies' }; },
  };
  const dsseVerifier: DsseChainVerifier = () => ({ validSignerKeyids: [] });
  return {
    bindingResolver,
    dsseVerifier,
    witnessVerifier,
    conflicts: [],
    newestPolicyVersion: 1,
    rawSignatureVerifier: { async verify() { return false; } },
    async assertFresh() { /* no-op fixture */ },
    candidateKeys() { return []; },
    policy(purpose) { return { accepted: [`accepted-for-${purpose}`], requiredStrength: 'strong' }; },
    async verifyRoleBinding() { return { bindingDigest: `sha256:${'0'.repeat(64)}` as const }; },
    async verifyOnchainAuthority() { return { bindingDigest: `sha256:${'0'.repeat(64)}` as const }; },
    resolverFor() { return bindingResolver; },
    ...overrides,
  };
}
