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
 */

import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

const VERSION = '0.1.0';

/** Plain email shape. */
const EMAIL_PATTERN =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])+)+/g;

/** POSIX home-dir path segment carrying a username. */
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[^/\s"'`]+/g;

const PATTERNS: Array<{ pattern: RegExp; replacement: string; detail: string }> = [
  { pattern: EMAIL_PATTERN, replacement: '[EMAIL]', detail: 'email' },
  { pattern: HOME_PATH_PATTERN, replacement: '/users/anon', detail: 'home-path' },
];

export function plainPatternsStage(policy: KeyPolicy): ScrubStage {
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
        for (const { pattern, replacement, detail } of PATTERNS) {
          let hits = 0;
          scrubbed = scrubbed.replace(pattern, () => {
            hits += 1;
            return replacement;
          });
          for (let i = 0; i < hits; i += 1) {
            redactions.push({ key, stage: 'plain-patterns', kind: 'pii', detail });
          }
        }
        out[key] = scrubbed;
      }
      return { attributes: out, redactions };
    },
  };
}
