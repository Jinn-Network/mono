import { ScrubPipeline } from './pipeline.js';
import { keyPolicyStage, type KeyPolicy } from './key-policy.js';
import { openredactionStage } from './openredaction-stage.js';
import { secretlintStage } from './secretlint-stage.js';
import { mlPiiStage, type PiiDetector } from './ml-pii-stage.js';

/**
 * Default key policy: `jinn.*` identity/chain attributes are structural and pass
 * raw; everything else is `content` and flows through the value-scrubbing stages.
 */
export const DEFAULT_KEY_POLICY: KeyPolicy = {
  safe: ['jinn.*'],
  drop: [],
};

export interface BuildScrubPipelineOptions {
  policy?: KeyPolicy;
  /** When provided, the ML PII (GLiNER) stage is appended. */
  piiDetector?: PiiDetector;
}

/**
 * Assembles the seller-side scrub pipeline (cost-ascending): structural key
 * policy → openredaction (structured PII) → secretlint + entropy (secrets) →
 * optional GLiNER (ML PII). The GLiNER stage is added only when a detector is
 * supplied, so the daemon degrades gracefully (regex + secrets still scrub) when
 * the ML model is unavailable.
 */
export function buildScrubPipeline(opts: BuildScrubPipelineOptions = {}): ScrubPipeline {
  const policy = opts.policy ?? DEFAULT_KEY_POLICY;
  const stages = [keyPolicyStage(policy), openredactionStage(policy), secretlintStage(policy)];
  if (opts.piiDetector) {
    stages.push(mlPiiStage(policy, opts.piiDetector));
  }
  return new ScrubPipeline(stages);
}
