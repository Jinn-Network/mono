/**
 * Admission-time verification for explicit public-repository evaluator
 * environments. This is deliberately independent of verdict-time rechecks:
 * a shape-valid binding is not enough to mint or publish a v2 row.
 */

import { fetchFromIpfs } from '../adapters/mech/ipfs.js';
import type { PoolTask } from './_swe-rebench-v2-pool.js';
import {
  hashTaskEnvironmentSpecV1,
  parseTaskEnvironmentSpecV1,
  verifyEnvironmentAttestationV1,
  type TaskEnvironmentSpecV1,
  type TrustedParserIdentityV1,
} from '../task-creator/environment/contracts.js';
import {
  parseMintedEnvironmentBindingV1,
  type MintedEnvironmentBindingV1,
} from './_swe-rebench-v2-minted-pool.js';
import {
  assertJinnDifferentialEnvironmentPolicyV1,
  type JinnDifferentialAttesterPolicyV1,
} from '../task-creator/environment/jinn-differential-policy.js';
import { JINN_MONO_DIFFERENTIAL_PROOF_SOURCE } from '../task-creator/proofs/public-repo-fixtures.js';

export class MintedEnvironmentVerificationError extends Error {
  constructor(
    readonly category: 'infrastructure' | 'policy',
    detail: string,
  ) {
    super(`${category}: ${detail}`);
    this.name = 'MintedEnvironmentVerificationError';
  }
}

export interface MintedEnvironmentVerifier {
  verify(args: {
    binding: MintedEnvironmentBindingV1;
    poolTask: PoolTask;
  }): Promise<TaskEnvironmentSpecV1>;
}

export function createMintedEnvironmentVerifier(args: {
  ipfsGatewayUrl: string;
  fetchEnvironmentSpec?: (gatewayUrl: string, cid: string) => Promise<unknown>;
  /** Required only for the exact reviewed Jinn differential source. */
  jinnDifferentialAttesterPolicy?: JinnDifferentialAttesterPolicyV1;
}): MintedEnvironmentVerifier {
  const fetchEnvironmentSpec = args.fetchEnvironmentSpec ?? fetchFromIpfs;
  return {
    async verify({ binding: rawBinding, poolTask }): Promise<TaskEnvironmentSpecV1> {
      let binding: MintedEnvironmentBindingV1;
      try {
        binding = parseMintedEnvironmentBindingV1(rawBinding);
      } catch (err) {
        throw new MintedEnvironmentVerificationError('policy', `invalid environment binding: ${errorDetail(err)}`);
      }
      if (!poolTask.repo || !poolTask.base_commit) {
        throw new MintedEnvironmentVerificationError('policy', 'explicit environment candidate requires repo and base_commit');
      }

      let rawSpec: unknown;
      try {
        rawSpec = await fetchEnvironmentSpec(args.ipfsGatewayUrl, binding.environmentSpecCid);
      } catch (err) {
        throw new MintedEnvironmentVerificationError('infrastructure', `environment spec unavailable: ${errorDetail(err)}`);
      }

      let spec: TaskEnvironmentSpecV1;
      try {
        spec = parseTaskEnvironmentSpecV1(rawSpec);
      } catch (err) {
        throw new MintedEnvironmentVerificationError('policy', `invalid environment spec: ${errorDetail(err)}`);
      }

      if (hashTaskEnvironmentSpecV1(spec) !== binding.environmentHash || spec.attestation.environmentHash !== binding.environmentHash) {
        throw new MintedEnvironmentVerificationError('policy', 'environment hash does not bind the published spec');
      }
      if (!sameAttestation(spec.attestation, binding.attestation)) {
        throw new MintedEnvironmentVerificationError('policy', 'environment attestation does not match binding');
      }
      if (!(await verifyEnvironmentAttestationV1(spec.attestation))) {
        throw new MintedEnvironmentVerificationError('policy', 'environment attestation signature is invalid');
      }

      const canonicalRepoUrl = `https://github.com/${poolTask.repo}.git`;
      const canonicalInputRef = `git+${canonicalRepoUrl}#${poolTask.base_commit}`;
      if (
        spec.source.repo !== poolTask.repo ||
        spec.source.baseCommit !== poolTask.base_commit ||
        spec.source.repoUrl !== canonicalRepoUrl ||
        !spec.inputs.some((input) => input.inputRef === canonicalInputRef)
      ) {
        throw new MintedEnvironmentVerificationError('policy', 'environment source URL/input binding does not match candidate');
      }
      if (
        spec.execution.platform !== binding.platform ||
        spec.execution.image.reference !== binding.image.reference ||
        spec.execution.image.digest !== binding.image.digest ||
        !sameParser(spec.execution.parser, binding.parser)
      ) {
        throw new MintedEnvironmentVerificationError('policy', 'environment parser/image/platform does not match binding');
      }
      if (isExactJinnDifferentialSource(poolTask)) {
        try {
          assertJinnDifferentialEnvironmentPolicyV1(spec, args.jinnDifferentialAttesterPolicy);
        } catch (err) {
          throw new MintedEnvironmentVerificationError('policy', errorDetail(err));
        }
      }
      return spec;
    },
  };
}

function isExactJinnDifferentialSource(poolTask: PoolTask): boolean {
  const source = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE;
  return poolTask.instance_id === source.instanceId &&
    poolTask.repo === source.repo &&
    poolTask.base_commit === source.baseCommit;
}

function sameParser(a: TrustedParserIdentityV1, b: TrustedParserIdentityV1): boolean {
  return a.id === b.id && a.version === b.version && a.digest === b.digest && a.bundleId === b.bundleId;
}

function sameAttestation(
  a: TaskEnvironmentSpecV1['attestation'],
  b: TaskEnvironmentSpecV1['attestation'],
): boolean {
  return a.scheme === b.scheme && a.algo === b.algo &&
    a.environmentHash === b.environmentHash &&
    a.operatorSafe.toLowerCase() === b.operatorSafe.toLowerCase() &&
    a.signer.toLowerCase() === b.signer.toLowerCase() &&
    a.signature.toLowerCase() === b.signature.toLowerCase();
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
