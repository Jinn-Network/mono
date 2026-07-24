import { ScrubPipeline } from './pipeline.js';
import { keyPolicyDetector, type KeyPolicy } from './key-policy.js';
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
import { urlCredentialsDetector } from './url-credentials-detector.js';
import { rejectClassesDetector } from './reject-classes-detector.js';
import { checksummedInstrumentsDetector } from './checksummed-instruments-detector.js';
import { ipAddressDetector } from './ip-address-detector.js';
import { gitleaksDetector } from './gitleaks-detector.js';
import type { Detector } from './finding.js';
import { DEFAULT_POLICY } from './policy.js';
import { computeAllowlistDigest } from './provenance.js';

/**
 * Default key policy. `jinn.*` identity/chain attributes are structural and pass
 * raw. The `drop` tier deletes the spec's stage-1 high-confidence keys outright
 * (auth headers, cookies, env dumps — see `spec/2026-06-15-ts-trajectory-scrub-stack.md`):
 * these never carry sellable content and are never safe to publish. Globs use the
 * trailing-`*` prefix form `classifyKey` supports; the HTTP header keys are listed
 * per request/response direction (a leading `*.header.…` glob is not matched, so
 * we enumerate the concrete keys). Machine-identity keys (D3 carrier) drop
 * attempt-manifest `host` / hostname telemetry. Everything else is `content` and
 * flows through the value-scrubbing detectors.
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
  machineIdentity: [
    'host',
    'hostname',
    'os.hostname',
    'attempt.host',
    'attempt.hostname',
    'system.hostname',
    'device.hostname',
    'device.host',
  ],
};

export interface BuildScrubPipelineOptions {
  policy?: KeyPolicy;
  /** When provided, the ML PII (GLiNER) detector is appended. */
  piiDetector?: PiiDetector;
  /** Known-identity pack + non-address allowlist (#1971). */
  knownIdentity?: AssembleKnownIdentityOptions | AssembledKnownIdentity;
  /** Review-queue store for flag resolutions (#1973). */
  reviewStore?: import('./review-queue.js').ReviewQueueStore;
  /**
   * When false, unresolved flags do not abort (tests). Default true for
   * redact-mode publish lanes.
   */
  failClosedOnUnresolvedFlags?: boolean;
}

export function resolveKnownIdentity(
  opts?: AssembleKnownIdentityOptions | AssembledKnownIdentity,
): AssembledKnownIdentity {
  // AssembledKnownIdentity is a subset of AssembleKnownIdentityOptions;
  // re-assembly is idempotent (allowlist entries are deduped).
  return assembleKnownIdentity(opts);
}

/** Duck-type ML detector metadata for the policy hash (#1974). */
function provenanceFromPiiDetector(detector: PiiDetector | undefined): {
  modelId: string | null;
  labels: readonly string[];
} {
  if (!detector) return { modelId: null, labels: [] };
  const withMeta = detector as PiiDetector & {
    modelId?: string;
    labelSet?: readonly string[];
    model?: string;
    entityGroups?: Iterable<string>;
  };
  if (typeof withMeta.modelId === 'string' && withMeta.labelSet) {
    return { modelId: withMeta.modelId, labels: withMeta.labelSet };
  }
  return { modelId: null, labels: [] };
}

/** Build provenance extras from known-identity + optional ML detector (#1974). */
export function buildProvenanceExtras(
  knownIdentity: AssembledKnownIdentity,
  piiDetector?: PiiDetector,
): {
  modelId: string | null;
  labels: readonly string[];
  allowlistDigest: string;
} {
  const ml = provenanceFromPiiDetector(piiDetector);
  return {
    modelId: ml.modelId,
    labels: ml.labels,
    allowlistDigest: computeAllowlistDigest(knownIdentity.allowlist.entries),
  };
}

/**
 * Shared detector inventory (#1969 / #1970 / #1971 / #1972 / #1973). Every
 * publish/check consumer runs the same owned detectors (key-policy,
 * plain-patterns including C1 wallet + A1 credential IDs, git-identity B2
 * carriers, known-identity pack + non-address allowlist, Tier-1
 * reject/URL/IP/instruments/gitleaks, secretlint). What varies is disposition /
 * check-mode and whether an ML PII detector is injected. Seed keeps the entropy
 * fallback off until A2 mid-band flags are absorbed without refuse-on-detection
 * (#1409 shipped behavior). openredaction was retired in #1973.
 */
export function sharedDetectorInventory(
  policy: KeyPolicy,
  opts: {
    entropyFallback?: boolean;
    piiDetector?: PiiDetector;
    knownIdentity?: AssembleKnownIdentityOptions | AssembledKnownIdentity;
  } = {},
): Detector[] {
  const detectors: Detector[] = [keyPolicyDetector(policy)];
  detectors.push(plainPatternsDetector(policy));
  detectors.push(gitIdentityDetector(policy));
  detectors.push(
    knownIdentityDetector(policy, { assembled: resolveKnownIdentity(opts.knownIdentity) }),
  );
  detectors.push(urlCredentialsDetector(policy));
  detectors.push(rejectClassesDetector(policy));
  detectors.push(checksummedInstrumentsDetector(policy));
  detectors.push(ipAddressDetector(policy));
  detectors.push(gitleaksDetector(policy));
  detectors.push(secretlintDetector(policy, { entropyFallback: opts.entropyFallback ?? true }));
  if (opts.piiDetector) {
    detectors.push(mlPiiDetector(policy, opts.piiDetector));
  }
  return detectors;
}

/**
 * Trace / redact-mode preset over the shared inventory.
 *
 * @deprecated Prefer thinking in terms of one inventory + policy; this builder
 * remains as a compatibility preset through the migration (#1969).
 */
export function buildScrubPipeline(opts: BuildScrubPipelineOptions = {}): ScrubPipeline {
  const policy = opts.policy ?? DEFAULT_KEY_POLICY;
  const knownIdentity = resolveKnownIdentity(opts.knownIdentity);
  return new ScrubPipeline(
    sharedDetectorInventory(policy, {
      entropyFallback: true,
      piiDetector: opts.piiDetector,
      knownIdentity,
    }),
    {
      policy: DEFAULT_POLICY,
      checkMode: false,
      reviewStore: opts.reviewStore,
      failClosedOnUnresolvedFlags: opts.failClosedOnUnresolvedFlags,
      provenance: buildProvenanceExtras(knownIdentity, opts.piiDetector),
    },
  );
}

export interface BuildSeedScrubPipelineOptions {
  policy?: KeyPolicy;
  knownIdentity?: AssembleKnownIdentityOptions | AssembledKnownIdentity;
  piiDetector?: PiiDetector;
  reviewStore?: import('./review-queue.js').ReviewQueueStore;
  failClosedOnUnresolvedFlags?: boolean;
}

/**
 * Seed / redact-mode preset (#1409 / #1969). Same owned inventory as layer-2.
 * Entropy fallback stays off to preserve the shipped zero-corruption seed
 * behavior until A2 mid-band can flag without tripping refuse-on-detection.
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
  const knownIdentity = resolveKnownIdentity(opts.knownIdentity);
  return new ScrubPipeline(
    sharedDetectorInventory(policy, {
      entropyFallback: false,
      piiDetector: opts.piiDetector,
      knownIdentity,
    }),
    {
      policy: DEFAULT_POLICY,
      checkMode: false,
      reviewStore: opts.reviewStore,
      failClosedOnUnresolvedFlags: opts.failClosedOnUnresolvedFlags,
      provenance: buildProvenanceExtras(knownIdentity, opts.piiDetector),
    },
  );
}
