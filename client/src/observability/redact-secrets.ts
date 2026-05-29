/**
 * Security-critical redaction for the one-click operator debug report
 * (issue #420 §4).
 *
 * Single source of truth for stripping secrets from anything that lands in a
 * support bundle or an on-disk log file. Reuses the existing redaction
 * primitives (`trajectory/secret-scrub.ts`, `util/redact-rpc-urls.ts`) and
 * extends them with the secret surfaces enumerated in the issue:
 *
 *   - keystore password / JINN_PASSWORD
 *   - private keys / mnemonics / seed phrases
 *   - daemon API token / UI token / handshake key
 *   - harness API keys (Anthropic / OpenAI / OpenRouter / Nous Portal)
 *   - RPC URLs with embedded credential segments
 *
 * Two redaction layers run together:
 *   1. key-name redaction — values of keys matching a secret-name pattern.
 *   2. string-shape redaction — values that *look* like a secret (a bare
 *      0x-64 hex string, a JWT) regardless of their key name.
 *
 * Wallet addresses (0x-40), RPC hostnames/paths, contract/deployment
 * addresses and file paths are intentionally KEPT — they are public or
 * needed to reproduce a network issue. See `buildRedactionReport`.
 */

import { SECRET_NAME_PATTERNS } from '../trajectory/secret-scrub.js';

/**
 * Bumped whenever the redaction logic changes in a way that affects what is
 * stripped. Recorded in `bundle-meta.json` so a bundle can be read against
 * the redaction rules that produced it.
 */
export const REDACTION_VERSION = '2';

/** The marker substituted for a redacted value. */
function marker(label: string): string {
  return `<redacted:${label}>`;
}

/**
 * Secret-name patterns. Reuses the V1 set from `secret-scrub.ts` and extends
 * it with debug-report-specific surfaces. Case-insensitive; matches at the end
 * of a key. The matcher (`isSecretName`) normalizes camelCase / snake_case /
 * kebab-case to dotted segments first, so `dbPassword`, `db_password` and
 * `db-password` all match the same `*.password` pattern.
 */
const EXTENDED_SECRET_NAME_PATTERNS: readonly RegExp[] = [
  ...SECRET_NAME_PATTERNS,
  /(^|\.)mnemonic$/i,
  /(^|\.)seed\.?phrase$/i,
  /(^|\.)seedphrase$/i,
  /(^|\.)keystore\.?password$/i,
  /(^|\.)passphrase$/i,
  /(^|\.)handshake\.?key$/i,
  /(^|\.)ui\.?token$/i,
  /(^|\.)daemon\.?api\.?token$/i,
  /(^|\.)jinn\.?password$/i,
  // Harness / provider API keys live in the harness env, but redact
  // defensively if env is ever serialized into a value.
  /api\.?key$/i,
  /(^|\.)anthropic/i,
  /(^|\.)openai/i,
  /(^|\.)openrouter/i,
  /nous.*(token|key)$/i,
];

/**
 * Split a key into dotted lowercase segments so camelCase / snake_case /
 * kebab-case all reduce to the same canonical form.
 *
 * `dbPassword` -> `db.password`, `DAEMON_API_TOKEN` -> `daemon.api.token`,
 * `ui-token` -> `ui.token`. The original key is also tested so single-token
 * keys keep matching the base patterns.
 */
function canonicalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
    .replace(/[_-]+/g, '.')
    .toLowerCase();
}

function isSecretName(key: string): boolean {
  const canonical = canonicalizeKey(key);
  return EXTENDED_SECRET_NAME_PATTERNS.some(
    (p) => p.test(key) || p.test(canonical),
  );
}

// ── String-shape redaction ───────────────────────────────────────────────────

/** A private-key-shaped 64-hex-char value (0x-prefixed). */
const HEX64_RE = /\b0x[0-9a-fA-F]{64}\b/g;
/** A JWT-shaped token: three base64url segments separated by dots. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
/** Any http(s) URL embedded in free text. */
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * Redact secret-shaped substrings inside a free-text string value.
 *
 * - 64-hex-char (`0x...`) private-key-shaped values -> stripped. Wallet
 *   addresses (`0x` + 40 hex) are NOT 64 chars, so they survive.
 * - JWT-shaped tokens -> stripped.
 * - http(s) URLs -> run through `redactRpcUrl` so an RPC endpoint logged in
 *   an error message keeps its host but loses any embedded credential.
 */
function redactStringValue(value: string): string {
  return value
    .replace(HEX64_RE, marker('hex64'))
    .replace(JWT_RE, marker('jwt'))
    .replace(URL_RE, (url) => redactRpcUrl(url));
}

// ── RPC URL redaction ────────────────────────────────────────────────────────

/**
 * Keep the host (and a coarse path shape) of an RPC URL but strip any
 * embedded credential: userinfo, `/v3/<key>`-style key segments, and
 * `?key=`/`?apikey=`-style query credentials.
 *
 * RPC URLs are intentionally kept in the bundle (per the issue's acceptance
 * criteria) so a network issue can be reproduced — only the secret part is
 * removed.
 */
export function redactRpcUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a parseable URL. Apply only the non-URL string redactors here —
    // calling redactStringValue would re-run URL_RE on the same unparseable
    // string and recurse straight back into redactRpcUrl, overflowing the
    // stack on a malformed URL (e.g. `http://[bad`) in an error message.
    return url.replace(HEX64_RE, marker('hex64')).replace(JWT_RE, marker('jwt'));
  }

  // Drop userinfo (user:pass@host).
  parsed.username = '';
  parsed.password = '';

  // Drop every query parameter — RPC URLs do not need query state to
  // reproduce a connectivity issue, and keys hide there.
  parsed.search = '';

  // Drop the fragment too — non-standard providers occasionally stash a
  // `#key=...` credential there.
  parsed.hash = '';

  // Strip opaque path segments that look like API keys: a long alphanumeric
  // run, or a segment following a version-style prefix (v2/v3/...).
  const segments = parsed.pathname.split('/');
  const cleaned = segments.map((seg, idx) => {
    if (!seg) return seg;
    const prev = segments[idx - 1]?.toLowerCase();
    if (prev && /^v\d+$/.test(prev)) return marker('rpc-key');
    // A long opaque token (>= 20 chars, mixed case or digits) is treated as a key.
    if (seg.length >= 20 && /[A-Za-z]/.test(seg) && /[0-9A-Z]/.test(seg)) {
      return marker('rpc-key');
    }
    return seg;
  });
  parsed.pathname = cleaned.join('/');

  return parsed.toString();
}

/** True for keys whose values hold an RPC URL (singular or plural array). */
function isRpcUrlKey(key: string): boolean {
  // Matches singular (`rpcUrl`) and plural (`rpcUrls`) forms — the resolved
  // JinnConfig carries both, and the plural arrays hold the full fallback
  // chain, which is exactly where operator API keys live.
  return /rpc[_-]?urls?$/i.test(key) || /(^|[._-])rpcurls?$/i.test(key);
}

/**
 * Keys whose values are public on-chain identifiers — request IDs, transaction
 * hashes, task IDs, block / manifest hashes. These are `0x`-64-hex shaped, so
 * the string-shape `hex64` redactor (which cannot tell a private key from a
 * public hash by shape) would otherwise strip them. They are public and
 * load-bearing for debugging — the bundle keeps them so events correlate to
 * on-chain state. A private key is never legitimately stored under one of
 * these names; `isSecretName` still catches `privateKey` / `mnemonic` / etc.
 */
// Each arm is an explicitly-named public identifier. A bare `hash` arm is
// deliberately NOT included: it would exempt keys like `passwordHash` /
// `keyHash` from the hex64 redactor and leak a derived secret.
const PUBLIC_IDENTIFIER_KEY_RE =
  /(^|\.)(request\.id|tx\.hash|task\.id|block\.hash|manifest\.(digest|hash))$/;

function isPublicIdentifierKey(key: string): boolean {
  return PUBLIC_IDENTIFIER_KEY_RE.test(canonicalizeKey(key));
}

// ── Deep value redaction ─────────────────────────────────────────────────────

/**
 * Deep-clone `value` and redact every secret it contains. Pure — the input is
 * never mutated.
 *
 * - Object keys matching a secret-name pattern -> value replaced with a marker.
 * - Object keys holding an RPC URL -> value run through `redactRpcUrl`.
 * - Object keys holding a public on-chain identifier (request id / tx hash) ->
 *   value kept verbatim, exempt from string-shape `hex64` redaction.
 * - Any other string value -> secret-shaped substrings stripped.
 * - Arrays and nested objects are walked recursively.
 */
export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactStringValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretName(k)) {
        out[k] = marker(k);
        continue;
      }
      if (isRpcUrlKey(k)) {
        if (typeof v === 'string') {
          out[k] = redactRpcUrl(v);
          continue;
        }
        if (Array.isArray(v)) {
          // Plural RPC keys (`rpcUrls`, `archiveRpcUrls`, …) hold the full
          // fallback chain — strip credentials from each entry directly
          // rather than relying on the free-text URL_RE pass, which misses
          // non-http(s) schemes like `wss://`.
          out[k] = v.map((el) => (typeof el === 'string' ? redactRpcUrl(el) : redactValue(el)));
          continue;
        }
      }
      if (typeof v === 'string' && isPublicIdentifierKey(k)) {
        // Public on-chain identifier (request id / tx hash / ...). Kept
        // verbatim — the string-shape hex64 pass cannot tell it from a
        // private key, and stripping it would break event-to-chain
        // correlation in the debug bundle.
        out[k] = v;
        continue;
      }
      out[k] = redactValue(v);
    }
    return out;
  }
  // Functions, symbols etc. — drop to a safe placeholder.
  return marker('unserializable');
}

/**
 * Redact a resolved `JinnConfig` for inclusion in the bundle. Thin wrapper
 * over `redactValue` — the deep walk already handles every secret surface,
 * including `rpcUrl`, nested `ui.token`/`ui.handshakeKey`, and any future
 * config key matching a secret-name pattern.
 */
export function redactConfig(config: unknown): unknown {
  return redactValue(config);
}

// ── Redaction report ─────────────────────────────────────────────────────────

/**
 * Generate `redaction-report.md` — the human-readable record of what the
 * debug-report bundle strips and what it intentionally keeps. This file is
 * the "redaction coverage documented" acceptance criterion for issue #420.
 */
export function buildRedactionReport(): string {
  return [
    '# Debug report — redaction coverage',
    '',
    `Redaction version: ${REDACTION_VERSION}`,
    '',
    'This bundle was assembled by the jinn operator daemon for support and',
    'debugging. Before you share it, here is exactly what was removed and what',
    'was deliberately kept.',
    '',
    '## Redacted (removed from this bundle)',
    '',
    '- Keystore password and `JINN_PASSWORD` — the secret that decrypts the',
    '  agent wallet. Never written into config, provenance, or any log line.',
    '- Private keys and mnemonic / seed phrases — anything matching a',
    '  `privateKey` / `mnemonic` / `seedPhrase` key, plus any bare 64-hex-char',
    '  (`0x...`) value found inside free text.',
    '- Daemon API token, UI token, and handshake key — used to authenticate',
    '  to the local daemon API.',
    '- Harness / provider API keys — Anthropic, OpenAI, OpenRouter, Nous',
    '  Portal and any other `*apiKey` / `*token` / `*secret` value.',
    '- RPC URL credentials — embedded `user:pass@`, `/v3/<key>` path',
    '  segments, and `?key=` / `?apikey=` query parameters are stripped.',
    '- JWT-shaped tokens found inside free text.',
    '',
    '## Intentionally kept (needed to reproduce issues)',
    '',
    '- Wallet addresses (`0x` + 40 hex) — public on-chain identifiers.',
    '- Contract and deployment addresses — public.',
    '- Request IDs, transaction hashes, and other public on-chain identifiers',
    '  held in structured `requestId` / `txHash`-style fields — kept so bundle',
    '  events can be correlated to on-chain state.',
    '- RPC hostnames and coarse path shape — needed to reproduce a network',
    '  or connectivity problem. Only the credential portion is removed.',
    '- File paths (database, earning directory, config) — needed to locate',
    '  state on the operator host.',
    '- Lifecycle activity events, daemon status, and config provenance with',
    '  all secret values already replaced by `<redacted:...>` markers.',
    '',
    '## NOT redacted — review before sharing',
    '',
    '- `dashboard-screenshot.png` is a pixel capture of the dashboard DOM at',
    '  the moment you clicked download. It is an image — none of the text',
    '  redaction above applies to it. Anything visible on screen at capture',
    '  time (a value typed into a field, an error toast showing a raw URL,',
    '  a log line rendered in the UI) will appear in the screenshot. Look at',
    '  it before sharing, and delete it from the bundle if it shows anything',
    '  sensitive.',
    '',
    'If you spot anything sensitive that was not redacted, do not share the',
    'bundle — open an issue against the jinn client instead.',
    '',
  ].join('\n');
}
