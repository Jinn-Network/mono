/**
 * Daemon API bearer token — persistence + resolution.
 *
 * §14.2 finding fix: the token was `randomBytes(32)` per boot with no
 * persistence, so an externally-installed stop-hook (the only production
 * consumer of the bearer on `POST /api/stop-hook` — nothing daemon-spawned
 * needs it, since daemon-spawned harnesses get `DAEMON_API_TOKEN` forwarded
 * directly into their subprocess env) had no stable value to resolve when
 * `DAEMON_API_TOKEN` wasn't already set in its own environment. Capture
 * ingest went loudly dead on every default install.
 *
 * Mirrors `ui-token.ts`'s ensure/persist pattern, but deliberately
 * `earningDir`-derived rather than `homedir()`-derived per spec §9.4's
 * token-location direction (N daemons on one host must not share one
 * token) — `ui-token.ts` predates that direction and is not retrofitted
 * here (out of this change's scope).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DAEMON_API_TOKEN_FILENAME = 'daemon-api-token';

/** `<earningDir>/daemon-api-token`. */
export function daemonApiTokenPath(earningDir: string): string {
  return join(earningDir, DAEMON_API_TOKEN_FILENAME);
}

/**
 * The default `earningDir` an out-of-daemon consumer (the stop-hook CLI)
 * resolves WITHOUT loading the full config — mirrors `config.ts`'s
 * `earningDir` default + its `JINN_EARNING_DIR` env override, since the CLI
 * only needs this one field and pulling in the whole config loader for it
 * would be a heavier dependency than a hook binary should carry.
 */
export function resolveEarningDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env['JINN_EARNING_DIR'] ?? join(homedir(), '.jinn-client', 'earning');
}

/**
 * Daemon-side: read the persisted token at `path`, or generate + persist a
 * fresh one (mode 0600, like `ui-token.ts` / the keystore password file).
 * Only the daemon calls this — a hook/CLI consumer must never mint a token,
 * only read one (see `readDaemonApiToken`).
 */
export function ensureDaemonApiToken(path: string): { token: string; source: 'file' | 'generated' } {
  if (existsSync(path)) {
    const v = readFileSync(path, 'utf-8').trim();
    if (v.length >= 32) return { token: v, source: 'file' };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  return { token, source: 'generated' };
}

/** Read-only resolution for non-daemon consumers (the stop-hook CLI). Never generates. */
export function readDaemonApiToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const v = readFileSync(path, 'utf-8').trim();
  return v.length >= 32 ? v : null;
}
