/**
 * plain-patterns detector — deterministic regex findings for shapes the
 * probabilistic detectors miss (#1330 / #1415 / #1959 / #1969):
 *
 *  - email (B1)
 *  - POSIX home-directory paths (D1)
 *  - AWS/GCP credential-ID prefixes (A1)
 *  - Ethereum-style wallet addresses `0x`+40 hex (C1)
 *
 * Emits findings only — disposition owns stubs. Wallet + credential-ID shapes
 * are always registered in the shared inventory (#1969); policy decides.
 */

import { applyDispositions } from './apply-dispositions.js';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Detector, Finding } from './finding.js';
import type { Attributes, ScrubStage } from './types.js';

const VERSION = '0.2.0';

/** Plain email shape. */
const EMAIL_PATTERN =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])+)+/g;

/** POSIX home-dir path segment carrying a username. */
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[^/\s"'`]+/g;

/**
 * Bare AWS access-key ID — the fixed four-char prefixes + 16 key chars that
 * secretlint's aws rule only scans for under `enableIDScanRule: true`.
 */
const AWS_KEY_ID_PATTERN =
  /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g;

/**
 * GCP API key: fixed `AIza` prefix + 35 key chars. No trailing `\b` — the key
 * charset includes `-`, which breaks word-boundary semantics at the end.
 */
const GCP_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{35}/g;

/**
 * Ethereum-style wallet address: `0x` + exactly 40 hex chars (#1959 / C1).
 * Bare 40-hex git SHAs and `0x`+64 tx hashes must survive.
 */
const ETH_ADDRESS_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;

type PatternRule = {
  pattern: RegExp;
  class: Finding['class'];
  evidence: string;
};

const RULES: PatternRule[] = [
  { pattern: EMAIL_PATTERN, class: 'B1', evidence: 'email' },
  { pattern: HOME_PATH_PATTERN, class: 'D1', evidence: 'home-path' },
  { pattern: AWS_KEY_ID_PATTERN, class: 'A1', evidence: 'aws-access-key-id' },
  { pattern: GCP_API_KEY_PATTERN, class: 'A1', evidence: 'gcp-api-key' },
  { pattern: ETH_ADDRESS_PATTERN, class: 'C1', evidence: 'eth-address' },
];

export interface PlainPatternsOptions {
  /**
   * @deprecated (#1969) Credential IDs are always in the shared inventory.
   * Kept so call sites that pass `{ credentialIds: true }` still type-check.
   */
  credentialIds?: boolean;
  /**
   * @deprecated (#1969) Wallet addresses are always in the shared inventory.
   * Kept so call sites that pass `{ walletAddresses: true }` still type-check.
   */
  walletAddresses?: boolean;
}

function collectMatches(
  text: string,
  key: string,
  rule: PatternRule,
  detector: { name: string; version: string },
): Finding[] {
  const findings: Finding[] = [];
  const re = new RegExp(
    rule.pattern.source,
    rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`,
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    findings.push({
      class: rule.class,
      span: { key, start: match.index, end: match.index + match[0]!.length },
      confidence: 'VERY_HIGH',
      evidence: [rule.evidence],
      detector,
    });
  }
  return findings;
}

export function plainPatternsDetector(
  policy: KeyPolicy,
  _opts: PlainPatternsOptions = {},
): Detector {
  const meta = { name: 'plain-patterns', version: VERSION };
  return {
    ...meta,
    detect(attributes: Attributes): Finding[] {
      const findings: Finding[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') continue;
        for (const rule of RULES) {
          findings.push(...collectMatches(value, key, rule, meta));
        }
      }
      return findings;
    },
  };
}

/**
 * Legacy ScrubStage wrapper: detect + apply default dispositions. New callers
 * should use {@link plainPatternsDetector} via ScrubPipeline.
 */
export function plainPatternsStage(policy: KeyPolicy, opts: PlainPatternsOptions = {}): ScrubStage {
  const detector = plainPatternsDetector(policy, opts);
  return {
    name: detector.name,
    version: detector.version,
    scrub(attributes: Attributes) {
      const findings = detector.detect(attributes) as Finding[];
      return applyDispositions(attributes, findings);
    },
  };
}
