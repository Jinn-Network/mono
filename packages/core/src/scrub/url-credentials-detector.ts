/**
 * A3 — credentials embedded in URLs (#1972 / design §6.2).
 *
 * Detects URL userinfo (`scheme://user:pass@host`) and known credential query
 * params (`token`, `key`, `api_key`, and common aliases).
 */

import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Detector, Finding } from './finding.js';
import type { Attributes } from './types.js';

const VERSION = '1.0.0';

/** user:pass@ or user@ before the host (requires ://). */
const USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^/\s?#@]+@)/gi;

/**
 * Credential query-param names. Value runs until the next `&`, `#`, whitespace,
 * or end of string. Case-insensitive names.
 */
const CRED_QUERY_PATTERN =
  /([?&](?:token|access_token|refresh_token|id_token|auth_token|api[_-]?key|apikey|key|password|secret|client_secret)=)([^&#\s]+)/gi;

export function urlCredentialsDetector(policy: KeyPolicy): Detector {
  const meta = { name: 'url-credentials', version: VERSION };
  return {
    ...meta,
    detect(attributes: Attributes): Finding[] {
      const findings: Finding[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') continue;
        findings.push(...scan(value, key, meta));
      }
      return findings;
    },
  };
}

function scan(
  text: string,
  key: string,
  detector: { name: string; version: string },
): Finding[] {
  const findings: Finding[] = [];

  const userinfo = new RegExp(USERINFO_PATTERN.source, USERINFO_PATTERN.flags);
  let m: RegExpExecArray | null;
  while ((m = userinfo.exec(text)) !== null) {
    const full = m[0]!;
    const prefix = m[1]!;
    const start = m.index + prefix.length;
    const end = m.index + full.length;
    findings.push({
      class: 'A3',
      span: { key, start, end },
      confidence: 'VERY_HIGH',
      evidence: ['url-userinfo'],
      detector,
    });
  }

  const query = new RegExp(CRED_QUERY_PATTERN.source, CRED_QUERY_PATTERN.flags);
  while ((m = query.exec(text)) !== null) {
    const prefix = m[1]!;
    const value = m[2]!;
    // Skip empty / placeholder-looking values
    if (!value || value === '$' || value.startsWith('$')) continue;
    const start = m.index + prefix.length;
    const end = start + value.length;
    findings.push({
      class: 'A3',
      span: { key, start, end },
      confidence: 'VERY_HIGH',
      evidence: ['url-query-credential'],
      detector,
    });
  }

  return findings;
}
