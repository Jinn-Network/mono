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
import { resolveDefaultStateDir } from '../state-dir.js';

export const DAEMON_API_TOKEN_FILENAME = 'daemon-api-token';

/** `<earningDir>/daemon-api-token`. */
export function daemonApiTokenPath(earningDir: string): string {
  return join(earningDir, DAEMON_API_TOKEN_FILENAME);
}

/**
 * The default `earningDir` an out-of-daemon consumer (the stop-hook CLI)
 * resolves WITHOUT loading the full config — mirrors `config.ts`'s
 * `earningDir` default and its env precedence (`JINN_EARNING_DIR` first, then
 * `<JINN_STATE_DIR>/earning`, via `resolveDefaultStateDir`), since the CLI
 * only needs this one field and pulling in the whole config loader for it
 * would be a heavier dependency than a hook binary should carry.
 *
 * A `stateDir` set in the *config file* rather than the environment is out of
 * reach here by construction; the hook's loud exit 3 names `JINN_EARNING_DIR`
 * as the remedy for that case.
 */
export function resolveEarningDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env['JINN_EARNING_DIR'] ?? join(resolveDefaultStateDir({ env }), 'earning');
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

/**
 * What `resolveDaemonApiToken` did to the on-disk token file:
 * `written` (refreshed or created), `unchanged` (already current),
 * `skipped` (env token below the reader trust floor — file left intact),
 * `failed` (write rejected; the daemon still boots on the env token).
 */
export type DaemonApiTokenPersistence = 'written' | 'unchanged' | 'skipped' | 'failed';

export type DaemonApiTokenResolution = {
  token: string;
  source: 'env' | 'file' | 'generated';
  persisted: DaemonApiTokenPersistence;
};

/**
 * Daemon-side token resolution: `DAEMON_API_TOKEN` when set, otherwise the
 * persisted file (generating it once on first boot).
 *
 * Issue #2418: an env-supplied token used to short-circuit persistence
 * entirely, so an externally-installed stop-hook kept resolving whatever the
 * file held from an earlier boot and got HTTP 401 — loud, but far less
 * obvious than the missing-token path's exit 3. Refreshing the file collapses
 * the two cases: after any boot, the file holds the token the daemon is
 * actually accepting.
 *
 * A write failure is never fatal. The env token still authenticates every
 * daemon-spawned harness (they receive it directly in their subprocess env);
 * only the out-of-daemon hook degrades, and it degrades loudly on its own.
 */
export function resolveDaemonApiToken(options: {
  path: string;
  envToken?: string | undefined;
  warn?: ((message: string) => void) | undefined;
}): DaemonApiTokenResolution {
  const envToken = options.envToken?.trim();
  if (envToken) {
    return { token: envToken, source: 'env', persisted: persistDaemonApiToken(options.path, envToken, options.warn) };
  }
  const resolved = ensureDaemonApiToken(options.path);
  return {
    token: resolved.token,
    source: resolved.source,
    persisted: resolved.source === 'generated' ? 'written' : 'unchanged',
  };
}

/**
 * Write `token` to `path` (mode 0600) so a hook consumer reads the live value.
 *
 * Refuses tokens below the 32-char floor `readDaemonApiToken` enforces:
 * persisting one would leave a file every reader rejects, destroying a
 * usable credential to no end. The existing file is left alone and the
 * mismatch is named instead.
 */
function persistDaemonApiToken(
  path: string,
  token: string,
  warn: ((message: string) => void) | undefined,
): DaemonApiTokenPersistence {
  const emit = warn ?? ((message: string) => {
    console.warn(message);
  });
  if (token.length < 32) {
    emit(
      `DAEMON_API_TOKEN is shorter than the 32-character minimum readers accept, so ${path} was not ` +
      'refreshed. An externally-installed stop-hook will keep resolving the previous token (HTTP 401) ' +
      'until DAEMON_API_TOKEN is set to a value of at least 32 characters.',
    );
    return 'skipped';
  }
  if (readDaemonApiToken(path) === token) return 'unchanged';
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, token + '\n', { mode: 0o600 });
    return 'written';
  } catch (err) {
    emit(
      `Failed to persist DAEMON_API_TOKEN to ${path}: ${err instanceof Error ? err.message : String(err)}. ` +
      'The daemon is using the environment token, but an externally-installed stop-hook resolving this ' +
      'file will present a stale token and be rejected with HTTP 401.',
    );
    return 'failed';
  }
}
