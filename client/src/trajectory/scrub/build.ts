import type { CaptureManifest } from '../schema.js';
import { ScrubPipeline } from './pipeline.js';
import { keyPolicyStage, type KeyPolicy } from './key-policy.js';
import { mineableTraceGateStage } from './mineable-trace-gate.js';
import { openredactionStage } from './openredaction-stage.js';
import { plainPatternsStage } from './plain-patterns-stage.js';
import { secretlintStage } from './secretlint-stage.js';
import { mlPiiStage, type PiiDetector } from './ml-pii-stage.js';

/**
 * Default key policy. `jinn.*` identity/chain attributes are structural and pass
 * raw. The `drop` tier deletes the spec's stage-1 high-confidence keys outright
 * (auth headers, cookies, env dumps — see `spec/2026-06-15-ts-trajectory-scrub-stack.md`):
 * these never carry sellable content and are never safe to publish. Globs use the
 * trailing-`*` prefix form `classifyKey` supports; the HTTP header keys are listed
 * per request/response direction (a leading `*.header.…` glob is not matched, so
 * we enumerate the concrete keys). Everything else is `content` and flows through
 * the value-scrubbing stages.
 */
export const DEFAULT_KEY_POLICY: KeyPolicy = {
  safe: ['jinn.*'],
  drop: [
    'http.request.header.authorization',
    'http.response.header.authorization',
    'http.request.header.cookie',
    'http.response.header.cookie',
    'http.request.header.set-cookie',
    'http.response.header.set-cookie',
    'env.*',
  ],
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
  return new ScrubPipeline(assembleScrubStages(policy, opts.piiDetector));
}

/** Capture/consent-aware pipeline — tier-1 mineable fields gated first. */
export function buildCaptureScrubPipeline(
  manifest: Pick<CaptureManifest, 'mineableTraceConsent'>,
  opts: BuildScrubPipelineOptions = {},
): ScrubPipeline {
  const policy = opts.policy ?? DEFAULT_KEY_POLICY;
  const stages = [
    mineableTraceGateStage(manifest.mineableTraceConsent ?? 'off'),
    ...assembleScrubStages(policy, opts.piiDetector),
  ];
  return new ScrubPipeline(stages);
}

function assembleScrubStages(policy: KeyPolicy, piiDetector?: PiiDetector) {
  // plain-patterns runs after openredaction: deterministic email/home-path
  // regexes closing gaps the probabilistic stage demonstrably has (#1330).
  const stages = [
    keyPolicyStage(policy),
    openredactionStage(policy),
    plainPatternsStage(policy),
    secretlintStage(policy),
  ];
  if (piiDetector) {
    stages.push(mlPiiStage(policy, piiDetector));
  }
  return stages;
}

/**
 * Seed-profile scrub pipeline (#1409). Seeds are public, licence-checked
 * SKILL.md content — not operator trace data — so the probabilistic stages
 * (openredaction, secretlint's pass-2 entropy fallback, ML PII) that exist to
 * catch unknown-shape PII/secrets in private traces are dropped: on prose they
 * false-positive (trigger words, dated env-var slugs, long camelCase
 * identifiers) and deface the corpus. The deterministic detectors stay:
 * structural key policy, plain-patterns (emails, home paths, and — seed-only,
 * #1415 — bare AWS access-key IDs and GCP `AIza…` API keys, deterministic
 * prefix shapes secretlint pass-1 does not cover), and secretlint's pass-1
 * preset rules (AWS secret-key assignments, GitHub / Slack / npm token
 * shapes, GCP service-account JSON). Accepted residual: JWTs and unprefixed
 * high-entropy blobs pass unredacted — acceptable for public, licence-checked
 * seed content; the trace profile still catches them via the entropy fallback.
 * The reduced stage list is reported via the pipeline's `components` surface
 * (what the signed provenance manifest is specified to record — see
 * pipeline.ts), so the profile is inspectable per pipeline.
 */
export function buildSeedScrubPipeline(policy: KeyPolicy = DEFAULT_KEY_POLICY): ScrubPipeline {
  return new ScrubPipeline([
    keyPolicyStage(policy),
    plainPatternsStage(policy, { credentialIds: true }),
    secretlintStage(policy, { entropyFallback: false }),
  ]);
}
