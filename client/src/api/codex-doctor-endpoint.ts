/**
 * GET /api/codex/doctor
 *
 * Runs `codex --version` via async execFile and inspects the auth configuration
 * so the operator dashboard can show an install-required / sign-in-required
 * panel before the operator saves a Codex harness selection.
 *
 * Async (#778 follow-up): the readiness registry refreshes the learner
 * harness's `isReady()` periodically; that path calls `probeCodexDoctor`. The
 * original `spawnSync` blocked the daemon main event loop on every refresh,
 * same wedge class as the Hermes endpoint (see hermes-doctor-endpoint.ts file
 * header). Converted to `promisify(execFile)` with a 10s timeout.
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
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Classification of Codex credentials. */
export type CodexAuthStatus = 'ok' | 'expired' | 'not_configured';

/**
 * Tested @openai/codex CLI version window (#675). Below MIN or above MAX, the
 * harness may break — codex 0.133.0 introduced a stdin contract change that
 * silently broke the previous positional-prompt invocation. Bumping these
 * bounds is a deliberate compatibility statement, made with a green run of
 * `yarn test test/harnesses/impls/learner/codex-code-adapter.test.ts` against
 * the new CLI version.
 *
 * The upper bound is compared on major+minor only: patch releases within the
 * same minor as `MAX_TESTED_CODEX_VERSION` are treated as `'ok'`, since codex
 * patch bumps almost never break the CLI contract and warning on every patch
 * would produce alarm fatigue. Bump `MAX_TESTED_CODEX_VERSION` when codex
 * bumps its minor or major; patch bumps stay `'ok'` automatically.
 */
const MIN_TESTED_CODEX_VERSION = '0.50.0';
const MAX_TESTED_CODEX_VERSION = '0.133.0';

/** Classification of the installed codex CLI version against the tested range. */
export type CodexVersionStatus = 'ok' | 'unknown' | 'untested';

export interface CodexDoctorResponse {
  installed: boolean;
  /** Convenience alias — true iff `authStatus === 'ok'`. */
  authenticated: boolean;
  /** Live/expired/absent classification of Codex credentials. */
  authStatus: CodexAuthStatus;
  /** Parsed semver string from `codex --version`, or null when unparseable. */
  cliVersion: string | null;
  /** ok = within tested range; untested = outside it; unknown = unparseable (#675). */
  versionStatus: CodexVersionStatus;
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
 *   - Otherwise it is OAuth (`codex login`) mode. The live-ness signal is the
 *     `refresh_token`: codex transparently mints fresh `id_token` /
 *     `access_token` from it on its next run, so a present refresh_token means
 *     the session is live (`'ok'`). The `id_token` is a ~1h OIDC token and the
 *     `access_token` only lasts days — both routinely lapse between codex runs
 *     on a perfectly healthy login, so gating on their `exp` false-fails the
 *     readiness check and deadlocks the claim loop: the probe shells
 *     `codex --version`, which never refreshes, so the daemon never claims,
 *     never runs codex, and the tokens never rotate (#464).
 *   - With no refresh_token, fall back to a best-effort bearer-token expiry
 *     check (`access_token` first, `id_token` last). An expired or
 *     un-checkable bearer token is `'expired'` — the safe direction for a
 *     claim gate: a logged-out operator with a leftover file must not read as
 *     live (#366). `codex logout` deletes `auth.json` outright, so a
 *     structurally-valid file that still carries a refresh_token is a live
 *     session.
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
  // A present refresh_token is the live-ness signal: codex renews the
  // short-lived id_token / access_token from it on demand (#464).
  const refreshToken = tokens.refresh_token;
  if (typeof refreshToken === 'string' && refreshToken.trim().length > 0) {
    return 'ok';
  }
  // No refresh_token — best-effort bearer-token expiry check (access_token
  // first, id_token only as a last resort).
  const exp = jwtExpiry(tokens.access_token) ?? jwtExpiry(tokens.id_token);
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
 * Extracts the first `MAJOR.MINOR.PATCH` semver-looking triple from `codex
 * --version` output. Returns null when no such triple is present.
 */
function parseCodexVersion(stdout: string): string | null {
  const match = stdout.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : null;
}

/**
 * Compares two `MAJOR.MINOR.PATCH` strings segment-by-segment as integers.
 * Returns -1 if `a < b`, 0 if equal, 1 if `a > b`. Non-numeric / missing
 * segments fall back to 0 so a partial input never throws.
 */
function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const av = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const bv = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const ai = av[i] ?? 0;
    const bi = bv[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

/**
 * Returns true when `a`'s `MAJOR.MINOR` is strictly greater than `b`'s. Patch
 * differences within the same minor are ignored, so 0.133.5 is NOT above
 * 0.133.0, but 0.134.0 and 1.0.0 are. Used for the upper-bound check (#675)
 * so codex patch releases don't trip the untested-version warning.
 */
function isAboveMinor(a: string, b: string): boolean {
  const av = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const bv = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const [aMajor, aMinor] = [av[0] ?? 0, av[1] ?? 0];
  const [bMajor, bMinor] = [bv[0] ?? 0, bv[1] ?? 0];
  if (aMajor !== bMajor) return aMajor > bMajor;
  return aMinor > bMinor;
}

/**
 * Classifies a parsed semver against the tested range.
 *   - null → 'unknown'
 *   - below MIN (full semver compare) → 'untested'
 *   - above MAX on major+minor → 'untested' (patch bumps within the tested
 *     minor stay 'ok'; bump MAX_TESTED_CODEX_VERSION on minor/major bumps)
 *   - otherwise → 'ok'
 */
function classifyVersion(cliVersion: string | null): CodexVersionStatus {
  if (cliVersion === null) return 'unknown';
  if (
    compareSemver(cliVersion, MIN_TESTED_CODEX_VERSION) < 0
    || isAboveMinor(cliVersion, MAX_TESTED_CODEX_VERSION)
  ) {
    return 'untested';
  }
  return 'ok';
}

// Module-scoped so the warning fires once per process even though
// `probeCodexDoctor` is called every readiness tick.
let untestedVersionWarningEmitted = false;

/**
 * Asynchronously runs `codex --version` and classifies install + auth state.
 * Pure (no Hono dependency) so the harness layer can call it without pulling
 * the API server in.
 *
 * Async (#778 follow-up): see file header — `execFile` failures (non-zero
 * exit OR kill-by-timeout) throw with `{stdout, stderr, code, signal}`
 * attached; we unwrap that into the same classification surface the old
 * sync code produced.
 */
export async function probeCodexDoctor(config: CodexDoctorConfig = {}): Promise<CodexDoctorResponse> {
  const codexBin = config.codexPath ?? 'codex';
  // Defaults to 10s here (vs 30s on the sync path) because this fires on the
  // readiness-registry refresh tick — a hung shell-out must not snowball into
  // an outstanding 30s timer per tick.
  const timeoutMs = config.codexDoctorTimeoutMs ?? 10_000;

  let status: number | null = 0;
  let signal: NodeJS.Signals | null = null;
  let stdout = '';
  let stderr = '';
  let errorCode: string | undefined;

  try {
    const ok = await execFileAsync(codexBin, ['--version'], {
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    stdout = ok.stdout;
    stderr = ok.stderr;
  } catch (err) {
    const errno = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
      signal?: NodeJS.Signals;
    };
    const codeIsString = typeof errno.code === 'string';
    status = !codeIsString && typeof errno.code === 'number' ? errno.code : null;
    errorCode = codeIsString ? (errno.code as string) : undefined;
    signal = errno.signal ?? null;
    stdout = typeof errno.stdout === 'string' ? errno.stdout : errno.stdout?.toString() ?? '';
    stderr = typeof errno.stderr === 'string' ? errno.stderr : errno.stderr?.toString() ?? '';
  }

  // installed=true means we found the binary on disk. ENOENT is the only
  // definitive not-installed signal. Other errors (EACCES = wrong
  // permissions; ETIMEDOUT = ran but didn't finish in time) indicate the
  // binary exists but couldn't be exercised cleanly — surface those as
  // config-issue, not missing.
  const notFound = errorCode === 'ENOENT';
  const installed = !notFound && (
    status !== null
    || signal !== null
    || (errorCode != null && errorCode !== 'ENOENT')
  );

  // Auth is only meaningful once the binary is present and runnable.
  const runnable = installed && status === 0;
  const authStatus: CodexAuthStatus = runnable
    ? detectCodexAuthStatus(config)
    : 'not_configured';

  // Version surfacing (#675). Parse only when we have a runnable binary;
  // otherwise the stdout is meaningless.
  const cliVersion = runnable ? parseCodexVersion(stdout) : null;
  const versionStatus: CodexVersionStatus = runnable
    ? classifyVersion(cliVersion)
    : 'unknown';

  if (versionStatus === 'untested' && !untestedVersionWarningEmitted) {
    untestedVersionWarningEmitted = true;
    // eslint-disable-next-line no-console
    console.warn(
      `codex CLI version ${cliVersion} is outside the tested range `
      + `${MIN_TESTED_CODEX_VERSION}–${MAX_TESTED_CODEX_VERSION}; the harness `
      + `may break — see issue #675`,
    );
  }

  return {
    installed,
    authenticated: authStatus === 'ok',
    authStatus,
    cliVersion,
    versionStatus,
    exitCode: status,
    stdout: stdout.slice(0, 4000),
    stderr: stderr.slice(0, 4000),
  };
}

export function addCodexDoctorRoutes(app: Hono, config: CodexDoctorConfig = {}): void {
  app.get('/api/codex/doctor', async (c) => {
    return c.json(await probeCodexDoctor(config));
  });
}
