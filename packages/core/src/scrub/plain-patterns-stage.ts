/**
 * plain-patterns stage — deterministic regex redaction for two shapes the
 * probabilistic stages demonstrably miss (issue #1330, found while building
 * the harness-layer capture path in #1310):
 *
 *  - plain email addresses: openredaction's EMAIL pattern is unreliable
 *    (misses e.g. `jane.doe@example-corp.com`);
 *  - POSIX home-directory paths carrying a username
 *    (`/Users/<name>/…`, `/home/<name>/…`) — nothing else touches paths.
 *
 * Graduated here from the harness-layer's capture-local stages so the daemon
 * capture publish path and the harness layer share ONE implementation.
 * Deliberately broad: over-redacting an email or a username is cheap; leaking
 * one is not.
 *
 * An opt-in third set (`credentialIds`, #1415) adds deterministic cloud
 * credential-ID prefixes for the seed profile, which runs without the entropy
 * fallback that covers these shapes in the trace profile. An opt-in fourth set
 * (`walletAddresses`, #1959) adds the deterministic `0x`+40-hex wallet-address
 * detector the seed profile needs now that it is the episode seed lane's
 * profile — the class openredaction catches in the trace profile but the seed
 * profile leaked verbatim to the public corpus.
 */

import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

const VERSION = '0.1.0';

/** Plain email shape. */
const EMAIL_PATTERN =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])+)+/g;

/** POSIX home-dir path segment carrying a username. */
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[^/\s"'`]+/g;

type PatternSpec = {
  pattern: RegExp;
  /**
   * Fixed placeholder, or a factory keyed by the per-value occurrence index so
   * a rule can emit an indexed stub (e.g. `[ETH_ADDR_0]`) the way the trace
   * profile's openredaction does.
   */
  replacement: string | ((index: number) => string);
  detail: string;
  kind: string;
};

const PATTERNS: PatternSpec[] = [
  { pattern: EMAIL_PATTERN, replacement: '[EMAIL]', detail: 'email', kind: 'pii' },
  { pattern: HOME_PATH_PATTERN, replacement: '/users/anon', detail: 'home-path', kind: 'pii' },
];

/**
 * Bare AWS access-key ID — the fixed four-char prefixes + 16 key chars that
 * secretlint's aws rule only scans for under `enableIDScanRule: true`, which
 * preset-recommend leaves off (#1415).
 */
const AWS_KEY_ID_PATTERN =
  /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g;

/**
 * GCP API key: fixed `AIza` prefix + 35 key chars. No trailing `\b` — the key
 * charset includes `-`, which breaks word-boundary semantics at the end.
 */
const GCP_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{35}/g;

const CREDENTIAL_ID_PATTERNS: PatternSpec[] = [
  {
    pattern: AWS_KEY_ID_PATTERN,
    replacement: '[SECRET:aws-access-key-id]',
    detail: 'aws-access-key-id',
    kind: 'secret',
  },
  {
    pattern: GCP_API_KEY_PATTERN,
    replacement: '[SECRET:gcp-api-key]',
    detail: 'gcp-api-key',
    kind: 'secret',
  },
];

/**
 * Ethereum-style wallet address: `0x` + exactly 40 hex chars (#1959). Ported
 * verbatim from openredaction's `ETHEREUM_ADDRESS` matcher, so the seed
 * profile catches this class exactly as the trace profile does through
 * openredaction (parity), without pulling in the rest of that stage. The `0x`
 * prefix and the `\b` bounds are load-bearing carve-outs: bare 40-hex git
 * object ids (no `0x`) and `0x`+64-hex transaction hashes are provenance
 * receipts that must survive, so neither may be swallowed. This is the scrub
 * redesign's C1 detector (`docs/superpowers/specs/2026-07-22-scrub-redesign-
 * design.md` §6.2) minus the instance-allowlist refinement — verbatim
 * forward-compatible.
 */
const ETH_ADDRESS_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;

const WALLET_ADDRESS_PATTERNS: PatternSpec[] = [
  {
    pattern: ETH_ADDRESS_PATTERN,
    replacement: (index) => `[ETH_ADDR_${index}]`,
    detail: 'eth-address',
    kind: 'pii',
  },
];

export interface PlainPatternsOptions {
  /**
   * Adds the deterministic credential-ID prefixes above (#1415). Default false:
   * the trace profile already catches these via secretlint's entropy fallback
   * and must stay byte-identical. The seed profile (which runs without the
   * fallback) turns this on.
   */
  credentialIds?: boolean;
  /**
   * Adds the deterministic `0x`+40-hex wallet-address detector above (#1959).
   * Default false: the trace profile already catches this class via
   * openredaction and must stay byte-identical. The seed profile (which runs
   * without openredaction) turns this on to close the wallet-address leak.
   */
  walletAddresses?: boolean;
}

export function plainPatternsStage(policy: KeyPolicy, opts: PlainPatternsOptions = {}): ScrubStage {
  const patterns = [
    ...PATTERNS,
    ...(opts.credentialIds ? CREDENTIAL_ID_PATTERNS : []),
    ...(opts.walletAddresses ? WALLET_ADDRESS_PATTERNS : []),
  ];
  return {
    name: 'plain-patterns',
    version: VERSION,
    scrub(attributes: Attributes): ScrubResult {
      const out: Attributes = {};
      const redactions: RedactionRecord[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') {
          out[key] = value;
          continue;
        }
        let scrubbed = value;
        for (const { pattern, replacement, detail, kind } of patterns) {
          let hits = 0;
          scrubbed = scrubbed.replace(pattern, () => {
            const stub = typeof replacement === 'function' ? replacement(hits) : replacement;
            hits += 1;
            return stub;
          });
          for (let i = 0; i < hits; i += 1) {
            redactions.push({ key, stage: 'plain-patterns', kind, detail });
          }
        }
        out[key] = scrubbed;
      }
      return { attributes: out, redactions };
    },
  };
}
