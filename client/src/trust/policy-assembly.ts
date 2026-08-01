import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  verifyPolicyChain,
  type DsseChainVerifier,
  type PolicyCheckInput,
} from '@jinn-network/trust-core';

export class TrustPolicyUnavailableError extends Error {
  constructor(reason: string) {
    super(`operator trust policy is unusable: ${reason}`);
    this.name = 'TrustPolicyUnavailableError';
  }
}

/** Read every non-hidden file in the operator's local trust-policy versions directory. */
export async function loadTrustPolicyVersions(versionsDir: string): Promise<readonly Uint8Array[]> {
  let names: string[];
  try {
    names = await readdir(versionsDir);
  } catch {
    throw new TrustPolicyUnavailableError(`cannot read policy versions at ${versionsDir}`);
  }
  const files = names.filter((name) => !name.startsWith('.')).sort();
  if (files.length === 0) {
    throw new TrustPolicyUnavailableError(`no policy versions in ${versionsDir}`);
  }
  return Promise.all(files.map(async (name) => readFile(join(versionsDir, name))));
}

export interface AssembledVerdictPolicies {
  readonly admissionAgentPolicy: PolicyCheckInput;
  readonly evaluatorPolicy?: PolicyCheckInput;
  readonly requesterPolicy?: PolicyCheckInput;
}

function entry(
  policy: { purposes: Record<string, { accepted: string[]; requiredStrength: 'weak' | 'strong' }> },
  purpose: string,
  extraAccepted: readonly string[] = [],
): PolicyCheckInput | undefined {
  const found = policy.purposes[purpose];
  if (found === undefined) return undefined;
  return {
    accepted: [...found.accepted, ...extraAccepted],
    requiredStrength: found.requiredStrength,
  };
}

/**
 * Resolves the three verdict-gate policy entries from the operator's verified trust-policy
 * chain. Fails closed: an unverifiable, expired, or admission-agent-less policy is an error,
 * never a permissive default (design §6.5; binding §6.4 named checks).
 */
export function assembleVerdictPolicies(input: {
  readonly policyVersions: readonly Uint8Array[];
  readonly genesisDigest: `sha256:${string}`;
  readonly now: string;
  readonly dsseVerifier: DsseChainVerifier;
  readonly extraAcceptedAdmissionAgents?: readonly string[];
}): AssembledVerdictPolicies {
  const verified = verifyPolicyChain([...input.policyVersions], {
    genesisAnchor: { digest: input.genesisDigest },
    now: input.now,
    dsseVerifier: input.dsseVerifier,
  });
  if (!verified.ok || verified.newest === undefined) {
    throw new TrustPolicyUnavailableError(verified.reason ?? 'chain verification failed');
  }
  const policy = verified.newest as unknown as {
    purposes: Record<string, { accepted: string[]; requiredStrength: 'weak' | 'strong' }>;
  };
  const admissionAgentPolicy = entry(policy, 'admission-agent', input.extraAcceptedAdmissionAgents);
  if (admissionAgentPolicy === undefined) {
    throw new TrustPolicyUnavailableError('policy declares no admission-agent purpose');
  }
  const evaluatorPolicy = entry(policy, 'evaluator-eligibility');
  const requesterPolicy = entry(policy, 'adoption-authority');
  return {
    admissionAgentPolicy,
    ...(evaluatorPolicy === undefined ? {} : { evaluatorPolicy }),
    ...(requesterPolicy === undefined ? {} : { requesterPolicy }),
  };
}
