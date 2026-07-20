import { ScrubPipeline } from './pipeline.js';
import { keyPolicyStage, type KeyPolicy } from './key-policy.js';
import { secretlintStage } from './secretlint-stage.js';
import { plainPatternsStage } from './plain-patterns-stage.js';
import { DEFAULT_KEY_POLICY } from './build.js';

/**
 * The layer-2 / public / derived-content scrub altitude
 * (spec/2026-07-06-distillation-v1.md §10, D6; reconciled 2026-07-07 with the
 * shipped #1409 seed profile).
 *
 * Secret-only: the structural key policy + deterministic plain-patterns
 * (emails, home-dir paths, credential-ID prefixes — #1330/#1415) + the FULL
 * secretlint stage (including its Pass-2 entropy secret-shape fallback). It
 * deliberately DROPS openredaction and ML-PII — the stages whose PII
 * shape-matching and trigger-word behaviour deface ordinary public prose
 * (#1409).
 *
 * Mode note vs the seed profile (`buildSeedScrubPipeline`): seeds are
 * REDACT-mode (the scrubbed output is published, so prose must survive →
 * entropy fallback OFF there). This pipeline serves CHECK-mode consumers —
 * `distillClusters` REJECTS a skill on any scrub change rather than publishing
 * a redacted body — so a false positive costs one re-distill, never defaces
 * published content, and the entropy fallback stays ON as the stricter net for
 * a fresh secret surface (DR-2026-07-06 decision 3).
 */
export function buildLayer2ScrubPipeline(policy: KeyPolicy = DEFAULT_KEY_POLICY): ScrubPipeline {
  return new ScrubPipeline([
    keyPolicyStage(policy),
    plainPatternsStage(policy, { credentialIds: true }),
    secretlintStage(policy),
  ]);
}
