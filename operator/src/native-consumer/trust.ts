/**
 * Adapts the daemon's production `NativeTrustAuthority` (a public signed trust catalog -- policies,
 * anchors, bindings, revocations; never a private key) into the `ConsumerTrustPorts` shape the
 * graduated `verifyNativeVertical` expects, and exposes the settlement-authority probe the driver
 * uses to independently bind an on-chain settlement address to its claimed agent.
 */
import type { BindingResolver } from '@jinn-network/trust-core';
import type { NativeTrustAuthority } from '../daemon/native-trust-catalog.js';
import type { ConsumerTrustPorts } from './verification.js';

/** The four record-signing roles `verifyNativeVertical` checks a binding for. */
export function buildConsumerTrustPorts(trust: NativeTrustAuthority): ConsumerTrustPorts {
  return {
    bindingResolver: trust.bindingResolver,
    witnessVerifier: trust.witnessVerifier,
    dsseVerifier: trust.dsseVerifier,
    policies: {
      requester: trust.policy('native:requester-submission'),
      admission: trust.policy('native:admission'),
      executor: trust.policy('native:solver-delivery'),
      evaluator: trust.policy('native:evaluator-verdict'),
    },
  };
}

/** Resolver scoped to a source's discovery-signing key, for `createProtocolSourceVerifier`. */
export function discoverySourceBindingResolver(trust: NativeTrustAuthority, purpose: string): BindingResolver {
  return trust.resolverFor({ family: 'observations', purpose });
}

export class NativeConsumerSettlementAuthorityError extends Error {
  override readonly name = 'NativeConsumerSettlementAuthorityError';
}

/**
 * Independently confirms that the address observed settling a transaction on Base Sepolia is
 * actually ceremony-bound, under the trust catalog, to the agent claiming that settlement. Probes
 * every key ever bound to the agent (there is exactly one settlements-scope key in a well-formed
 * catalog) rather than trusting a caller-supplied key id outright.
 */
export async function resolveSettlementAuthority(input: {
  readonly trust: NativeTrustAuthority;
  readonly agent: string;
  readonly declarationKey: string;
  readonly address: `0x${string}`;
  readonly atTime: string;
  readonly purpose: 'native:solver-settlement' | 'native:evaluator-settlement';
}): Promise<{ readonly bindingDigest: `sha256:${string}` }> {
  try {
    return await input.trust.verifyOnchainAuthority({
      key: input.declarationKey,
      agent: input.agent,
      address: input.address,
      atTime: input.atTime,
      purpose: input.purpose,
    });
  } catch (cause) {
    throw new NativeConsumerSettlementAuthorityError(
      `${input.purpose} authority did not bind ${input.address} to ${input.agent}: ${String(cause)}`,
    );
  }
}
