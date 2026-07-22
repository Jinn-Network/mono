import { ScrubPipeline } from './pipeline.js';
import { keyPolicyDetector, type KeyPolicy } from './key-policy.js';
import { openredactionDetector } from './openredaction-stage.js';
import { plainPatternsDetector } from './plain-patterns-stage.js';
import { gitIdentityDetector } from './git-identity-detector.js';
import { secretlintDetector } from './secretlint-stage.js';
import { mlPiiDetector, type PiiDetector } from './ml-pii-stage.js';
import {
  assembleKnownIdentity,
  knownIdentityDetector,
  type AssembleKnownIdentityOptions,
  type AssembledKnownIdentity,
} from './known-identity-detector.js';
import type { Detector } from './finding.js';
import { DEFAULT_POLICY } from './policy.js';

/**
 * Default key policy. `jinn.*` identity/chain attributes are structural and pass
 * raw. The `drop` tier deletes the spec's stage-1 high-confidence keys outright
 * (auth headers, cookies, env dumps — see `spec/2026-06-15-ts-trajectory-scrub-stack.md`):
 * these never carry sellable content and are never safe to publish. Globs use the
 * trailing-`*` prefix form `classifyKey` supports; the HTTP header keys are listed
 * per request/response direction (a leading `*.header.…` glob is not matched, so
 * we enumerate the concrete keys). Everything else is `content` and flows through
 * the value-scrubbing detectors.
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
  /** When provided, the ML PII (GLiNER) detector is appended. */
  piiDetector?: PiiDetector;
  /** Known-identity pack + non-address allowlist (#1971). */
  knownIdentity?: AssembleKnownIdentityOptions | AssembledKnownIdentity;
}

function resolveKnownIdentity(
  opts?: AssembleKnownIdentityOptions | AssembledKnownIdentity,
): AssembledKnownIdentity {
  // AssembledKnownIdentity is a subset of AssembleKnownIdentityOptions;
  // re-assembly is idempotent (allowlist entries are deduped).
  return assembleKnownIdentity(opts);
}

/**
 * Shared detector inventory (#1969 / #1970 / #1971). Every publish/check
 * consumer runs the same owned detectors (key-policy, plain-patterns including
 * C1 wallet + A1 credential IDs, git-identity B2 carriers, known-identity pack
 * + non-address allowlist, secretlint). What varies is disposition / check-mode
 * and — temporarily until #1973 — whether the openredaction strangler is
 * included (trace preset only). Seed also keeps the entropy fallback off until
 * the flag review surface can absorb A2 mid-band without refuse-on-detection
 * (#1409 shipped behavior).
 */
export function sharedDetectorInventory(
  policy: KeyPolicy,
  opts: {
    openredaction?: boolean;
    entropyFallback?: boolean;
    piiDetector?: PiiDetector;
    knownIdentity?: AssembleKnownIdentityOptions | AssembledKnownIdentity;
  } = {},
): Detector[] {
  const detectors: Detector[] = [keyPolicyDetector(policy)];
  if (opts.openredaction) {
    detectors.push(openredactionDetector(policy));
  }
  detectors.push(plainPatternsDetector(policy));
  detectors.push(gitIdentityDetector(policy));
  detectors.push(
    knownIdentityDetector(policy, { assembled: resolveKnownIdentity(opts.knownIdentity) }),
  );
  detectors.push(secretlintDetector(policy, { entropyFallback: opts.entropyFallback ?? true }));
  if (opts.piiDetector) {
    detectors.push(mlPiiDetector(policy, opts.piiDetector));
  }
  return detectors;
}

/**
 * Trace / redact-mode preset over the shared inventory. Includes the
 * openredaction strangler until #1973 retires it.
 *
 * @deprecated Prefer thinking in terms of one inventory + policy; this builder
 * remains as a compatibility preset through the migration (#1969).
 */
export function buildScrubPipeline(opts: BuildScrubPipelineOptions = {}): ScrubPipeline {
  const policy = opts.policy ?? DEFAULT_KEY_POLICY;
  return new ScrubPipeline(
    sharedDetectorInventory(policy, {
      openredaction: true,
      entropyFallback: true,
      piiDetector: opts.piiDetector,
      knownIdentity: opts.knownIdentity,
    }),
    { policy: DEFAULT_POLICY, checkMode: false },
  );
}

export interface BuildSeedScrubPipelineOptions {
  policy?: KeyPolicy;
  knownIdentity?: AssembleKnownIdentityOptions | AssembledKnownIdentity;
}

/**
 * Seed / redact-mode preset (#1409 / #1969). Same owned inventory as layer-2
 * (no openredaction). Entropy fallback stays off to preserve the shipped
 * zero-corruption seed behavior until A2 mid-band can flag without tripping
 * refuse-on-detection.
 *
 * @deprecated Compatibility preset over the one inventory + policy table.
 */
export function buildSeedScrubPipeline(
  policyOrOpts: KeyPolicy | BuildSeedScrubPipelineOptions = DEFAULT_KEY_POLICY,
): ScrubPipeline {
  const opts: BuildSeedScrubPipelineOptions =
    policyOrOpts && 'safe' in policyOrOpts
      ? { policy: policyOrOpts }
      : (policyOrOpts as BuildSeedScrubPipelineOptions);
  const policy = opts.policy ?? DEFAULT_KEY_POLICY;
  return new ScrubPipeline(
    sharedDetectorInventory(policy, {
      openredaction: false,
      entropyFallback: false,
      knownIdentity: opts.knownIdentity,
    }),
    { policy: DEFAULT_POLICY, checkMode: false },
  );
}
