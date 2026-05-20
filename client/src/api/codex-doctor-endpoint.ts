/**
 * GET /api/codex/doctor
 *
 * Runs `codex --version` via spawnSync and inspects the auth configuration so
 * the operator dashboard can show an install-required / sign-in-required panel
 * before the operator saves a Codex harness selection.
 *
 * Response shape:
 *   { installed: boolean, authenticated: boolean,
 *     authStatus: 'ok' | 'expired' | 'not_configured',
 *     exitCode: number | null, stdout: string, stderr: string }
 *
 * `installed: false` means the binary was not found (ENOENT or equivalent).
 * `exitCode !== 0` (with `installed: true`) means the binary exists but
 * `codex --version` itself failed.
 *
 * `authStatus` (with `installed: true`, `exitCode === 0`) classifies the
 * Codex credentials:
 *   - `'ok'`             — usable credentials: an `OPENAI_API_KEY` (env or in
 *                          `auth.json`), or a non-expired `codex login` OAuth
 *                          session.
 *   - `'expired'`        — an `auth.json` is present but its OAuth tokens have
 *                          expired, or the file is malformed/unreadable. A
 *                          logged-out operator with a leftover file lands here
 *                          instead of false-`ok` (#366).
 *   - `'not_configured'` — no `OPENAI_API_KEY` and no `auth.json` at all.
 * `authenticated` is kept as a convenience alias for `authStatus === 'ok'`.
 *
 * Codex (unlike Hermes) has no `codex doctor` subcommand, so install
 * detection shells `codex --version`. Codex also exposes no auth-status
 * subcommand, so liveness is derived by parsing + expiry-checking the
 * `auth.json` it persists — existence alone is not enough: a stale OAuth
 * session reads as logged-in to a naive existence check (#366).
 *
 * The probe logic is exported as `probeCodexDoctor` so the Codex variant of
 * the `LearnerHarness` can reuse it from `isReady()` — same source of truth
 * for the SPA precheck panel and the daemon's claim-readiness gate (#348,
 * same-shape bug as #330; liveness tightening from #366).
 */
import type { Hono } from 'hono';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Classification of Codex credentials. */
export type CodexAuthStatus = 'ok' | 'expired' | 'not_configured';

export interface CodexDoctorResponse {
  installed: boolean;
  /** Convenience alias — true iff `authStatus === 'ok'`. */
  authenticated: boolean;
  /** Live/expired/absent classification of Codex credentials. */
  authStatus: CodexAuthStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CodexDoctorConfig {
  codexPath?: string;
  codexDoctorTimeoutMs?: number;
  /** Inject env for testing (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the auth-file read (for testing). Returns the raw `auth.json`
   * contents, or `undefined` when no file exists. When supplied, the real
   * filesystem is not touched.
   */
  readAuthFile?: () => string | undefined;
  /** Override the clock for deterministic expiry tests (epoch ms). */
  now?: number;
}

/** Shape of the relevant fields of a Codex `auth.json`. */
interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string | null;
    access_token?: string | null;
    refresh_token?: string | null;
  } | null;
}

/**
 * Decodes a JWT's payload and returns its `exp` claim (epoch seconds), or
 * `undefined` when the token is absent, malformed, or carries no `exp`.
 * Defensive: never throws.
 *
 * Note: the JWT signature is intentionally NOT verified — this is not a
 * security gap. The daemon only needs the `exp` claim for a liveness hint;
 * Codex itself verifies signatures when the token is actually used.
 */
function jwtExpiry(token: string | null | undefined): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classifies the credentials inside a parsed `auth.json`.
 *
 *   - A non-empty `OPENAI_API_KEY` in the file is API-key mode — there is no
 *     expiry, so presence is acceptable (`'ok'`).
 *   - Otherwise it is OAuth (`codex login`) mode: expiry-check the JWT `exp`
 *     of `id_token` (falling back to `access_token`). An expired token, or
 *     tokens we cannot expiry-check at all (no JWT / no `exp`), is treated as
 *     `'expired'` — the safe direction for a claim gate: a logged-out operator
 *     with a leftover file must not read as live (#366).
 */
function classifyAuthFile(auth: CodexAuthFile, nowMs: number): CodexAuthStatus {
  const fileApiKey = auth.OPENAI_API_KEY;
  if (typeof fileApiKey === 'string' && fileApiKey.trim().length > 0) {
    return 'ok';
  }
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== 'object') {
    // A file with neither an API key nor a tokens object carries no usable
    // credential — treat as stale rather than live.
    return 'expired';
  }
  const exp = jwtExpiry(tokens.id_token) ?? jwtExpiry(tokens.access_token);
  if (exp === undefined) {
    // Tokens present but not expiry-checkable — cannot prove liveness.
    return 'expired';
  }
  return exp * 1000 > nowMs ? 'ok' : 'expired';
}

/**
 * Reads `auth.json` (from `CODEX_HOME` or `~/.codex`) and returns its raw
 * contents, or `undefined` when the file does not exist. A read error other
 * than "not found" (e.g. EACCES) is reported as an empty string so the caller
 * classifies it as `expired` rather than `not_configured`.
 */
function readCodexAuthFile(config: CodexDoctorConfig): string | undefined {
  if (config.readAuthFile) return config.readAuthFile();
  const env = config.env ?? process.env;
  const codexHome = env['CODEX_HOME']?.trim();
  const authPath = codexHome
    ? join(codexHome, 'auth.json')
    : join(homedir(), '.codex', 'auth.json');
  try {
    return readFileSync(authPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return undefined;
    // File exists but is unreadable — surface as a present-but-broken file so
    // it classifies as `expired`, never `not_configured`.
    return '';
  }
}

/**
 * Classifies Codex credential state. Codex authenticates either via the
 * `OPENAI_API_KEY` env var (no expiry) or via a `codex login` session
 * persisted to `auth.json` under `CODEX_HOME` (falling back to `~/.codex`).
 *
 * Liveness, not mere existence: a malformed file or an expired OAuth session
 * classifies as `'expired'`, distinct from `'not_configured'` (no file and no
 * env key). Never throws — a corrupt file degrades to `'expired'`.
 */
function detectCodexAuthStatus(config: CodexDoctorConfig): CodexAuthStatus {
  if (hasApiKey(config)) return 'ok';

  const raw = readCodexAuthFile(config);
  if (raw === undefined) return 'not_configured';

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed / truncated auth.json — a logged-out operator with a corrupt
    // leftover file. Stale-class, never a false `ok` (#366).
    return 'expired';
  }
  if (!parsed || typeof parsed !== 'object') return 'expired';

  const nowMs = config.now ?? Date.now();
  return classifyAuthFile(parsed as CodexAuthFile, nowMs);
}

function hasApiKey(config: CodexDoctorConfig): boolean {
  const env = config.env ?? process.env;
  return Boolean(env['OPENAI_API_KEY']?.trim());
}

/**
 * Synchronously runs `codex --version` and classifies install + auth state.
 * Pure (no Hono dependency) so the harness layer can call it without pulling
 * the API server in.
 */
export function probeCodexDoctor(config: CodexDoctorConfig = {}): CodexDoctorResponse {
  const codexBin = config.codexPath ?? 'codex';
  const timeoutMs = config.codexDoctorTimeoutMs ?? 30_000;

  const result = spawnSync(codexBin, ['--version'], {
    timeout: timeoutMs,
    encoding: 'utf8',
  });

  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  // installed=true means we found the binary on disk. ENOENT is the only
  // definitive not-installed signal. Other errors (EACCES = wrong
  // permissions; ETIMEDOUT = ran but didn't finish in time) indicate the
  // binary exists but couldn't be exercised cleanly — surface those as
  // config-issue, not missing.
  const notFound = errorCode === 'ENOENT';
  const installed = !notFound && (
    result.status !== null
    || result.signal !== null
    || (errorCode != null && errorCode !== 'ENOENT')
  );

  // Auth is only meaningful once the binary is present and runnable.
  const runnable = installed && result.status === 0;
  const authStatus: CodexAuthStatus = runnable
    ? detectCodexAuthStatus(config)
    : 'not_configured';

  return {
    installed,
    authenticated: authStatus === 'ok',
    authStatus,
    exitCode: result.status,
    stdout: (result.stdout ?? '').slice(0, 4000),
    stderr: (result.stderr ?? '').slice(0, 4000),
  };
}

export function addCodexDoctorRoutes(app: Hono, config: CodexDoctorConfig = {}): void {
  app.get('/api/codex/doctor', (c) => {
    return c.json(probeCodexDoctor(config));
  });
}
