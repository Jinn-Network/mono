/**
 * UI session token — local-only auth secret shared between the daemon and
 * the operator SPA running in the browser.
 *
 * The daemon writes the token to ~/.jinn-client/ui-token (mode 0600). The SPA
 * receives it via the /auth/handshake endpoint, which exchanges a short-lived
 * handshakeKey (printed to stdout on daemon startup) for a cookie containing
 * the token. Subsequent requests carry the cookie.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function defaultTokenPath(): string {
  return join(homedir(), '.jinn-client', 'ui-token');
}

/** Read the token at `path`; if missing or too short, generate and persist a new one. */
export function ensureUiToken(path = defaultTokenPath()): string {
  if (existsSync(path)) {
    const v = readFileSync(path, 'utf-8').trim();
    if (v.length >= 32) return v;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  return token;
}

/** Forcibly rotate to a fresh token. */
export function rotateUiToken(path = defaultTokenPath()): string {
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token + '\n', { mode: 0o600 });
  return token;
}
