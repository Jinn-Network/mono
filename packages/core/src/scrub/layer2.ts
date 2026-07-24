import { ScrubPipeline } from './pipeline.js';
import type { KeyPolicy } from './key-policy.js';
import {
  DEFAULT_KEY_POLICY,
  buildProvenanceExtras,
  resolveKnownIdentity,
  sharedDetectorInventory,
  type BuildSeedScrubPipelineOptions,
} from './build.js';
import type {
  AssembleKnownIdentityOptions,
  AssembledKnownIdentity,
} from './known-identity-detector.js';
import { DEFAULT_POLICY } from './policy.js';

export interface BuildLayer2ScrubPipelineOptions {
  policy?: KeyPolicy;
  knownIdentity?: AssembleKnownIdentityOptions | AssembledKnownIdentity;
}

/**
 * Layer-2 / check-mode preset (#1969 / design §6.5).
 *
 * Same owned detector inventory as the seed preset; checkMode maps any non-pass
 * disposition to reject — one mapping line, not a second pipeline. Entropy
 * fallback stays ON (stricter net; a false positive costs one re-distill, never
 * defaces published content).
 *
 * @deprecated Compatibility preset over the one inventory + policy table.
 */
export function buildLayer2ScrubPipeline(
  policyOrOpts: KeyPolicy | BuildLayer2ScrubPipelineOptions = DEFAULT_KEY_POLICY,
): ScrubPipeline {
  const opts: BuildSeedScrubPipelineOptions =
    policyOrOpts && 'safe' in policyOrOpts
      ? { policy: policyOrOpts }
      : (policyOrOpts as BuildLayer2ScrubPipelineOptions);
  const policy = opts.policy ?? DEFAULT_KEY_POLICY;
  const knownIdentity = resolveKnownIdentity(opts.knownIdentity);
  return new ScrubPipeline(
    sharedDetectorInventory(policy, {
      entropyFallback: true,
      knownIdentity,
    }),
    {
      policy: DEFAULT_POLICY,
      checkMode: true,
      provenance: buildProvenanceExtras(knownIdentity),
    },
  );
}
