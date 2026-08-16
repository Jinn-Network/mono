/**
 * Layer 1 V1 minimum secret-scrub compliance.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §4.3.
 *
 * For every span attribute (and event attribute) whose NAME matches a sensitive
 * pattern (*.authorization, *.apiKey, *.bearer, *.password, *.secret, *.token,
 * *.privateKey), the VALUE must NOT match well-known raw credential patterns:
 *   - Bearer/JWT tokens (eyJ... or "Bearer ..." headers)
 *   - Anthropic API keys (sk-ant-...)
 *   - OpenAI API keys (sk-...)
 *   - Raw 64-hex private keys (0x[0-9a-f]{64}) — gated to *.privateKey attrs only
 *
 * Properly scrubbed values (<redacted:name> markers) and empty strings pass.
 * This is a V1-minimum safety net, not a full IP-protection gating layer.
 *
 * Skipped when no trajectory is present.
 */

import type { CheckResult, ConformanceContext } from '../types.js';
import { isSecretKey } from '../../trajectory/secret-scrub.js';

// ─── Credential pattern matchers ──────────────────────────────────────────────

const REDACTED_MARKER = /^<redacted:[A-Za-z0-9_.-]+>$/;

/**
 * Patterns that indicate a raw credential leaked through.
 * The privateKey-only pattern is tagged so we can gate it per attribute.
 */
const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; privateKeyOnly: boolean }> = [
  { pattern: /^Bearer\s+[A-Za-z0-9._\-]{10,}/i, privateKeyOnly: false },
  { pattern: /^sk-ant-[A-Za-z0-9_\-]{20,}/, privateKeyOnly: false },
  { pattern: /^sk-[A-Za-z0-9]{20,}/, privateKeyOnly: false },
  { pattern: /^eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/, privateKeyOnly: false }, // JWT
  { pattern: /^0x[0-9a-fA-F]{64}$/, privateKeyOnly: true }, // raw hex private key
];

function looksLikeRawCredential(attrName: string, value: string): boolean {
  if (value === '' || value == null) return false;
  if (REDACTED_MARKER.test(value)) return false;

  const lowerKey = attrName.toLowerCase();
  const isPrivateKey =
    lowerKey.endsWith('.privatekey') ||
    lowerKey.endsWith('.private_key') ||
    lowerKey.endsWith('.private-key') ||
    lowerKey === 'privatekey' ||
    lowerKey === 'private_key' ||
    lowerKey === 'private-key';

  for (const { pattern, privateKeyOnly } of CREDENTIAL_PATTERNS) {
    if (privateKeyOnly && !isPrivateKey) continue;
    if (pattern.test(value)) return true;
  }

  return false;
}

// ─── Check ────────────────────────────────────────────────────────────────────

type EventLike = { attributes?: Record<string, unknown> };
type SpanLike = { spanId: string; attributes: Record<string, unknown>; events?: EventLike[] };
type TrajLike = { spans: SpanLike[] };

/**
 * Check id: `secret-scrub.compliance`
 * Layer: 1
 *
 * Walks every span's attributes AND every span event's attributes. For keys
 * whose name matches a sensitive pattern (via `isSecretKey`), verifies that
 * the value is either:
 *   - a redaction marker (<redacted:...>), or
 *   - an empty string, or
 *   - does NOT match any well-known raw credential pattern.
 *
 * Reports up to 5 failures per run to bound message length.
 */
export function checkSecretScrub(ctx: ConformanceContext): CheckResult {
  const id = 'secret-scrub.compliance';
  const layer = 1 as const;

  const traj = ctx.trajectory as TrajLike | null | undefined;
  if (!traj) {
    return { id, layer, passed: true, skipped: true };
  }

  const failures: string[] = [];

  for (const span of traj.spans) {
    // Walk span attributes
    for (const [key, value] of Object.entries(span.attributes)) {
      if (!isSecretKey(key)) continue;
      if (typeof value !== 'string') continue;
      if (looksLikeRawCredential(key, value)) {
        failures.push(
          `span ${span.spanId} attr "${key}" appears to contain a raw credential`,
        );
        if (failures.length >= 5) break;
      }
    }
    if (failures.length >= 5) break;

    // Walk event attributes — span events can carry secret-keyed attributes
    // (e.g. an MCP event with an authorization field).
    for (const event of span.events ?? []) {
      for (const [key, value] of Object.entries(event.attributes ?? {})) {
        if (!isSecretKey(key)) continue;
        if (typeof value !== 'string') continue;
        if (looksLikeRawCredential(key, value)) {
          failures.push(
            `span ${span.spanId} event attr "${key}" appears to contain a raw credential`,
          );
          if (failures.length >= 5) break;
        }
      }
      if (failures.length >= 5) break;
    }
    if (failures.length >= 5) break;
  }

  if (failures.length === 0) return { id, layer, passed: true };

  return {
    id,
    layer,
    passed: false,
    detail: failures.join('; '),
  };
}
