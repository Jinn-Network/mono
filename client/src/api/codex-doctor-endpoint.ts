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
 *   { installed: boolean, authenticated: boolean, credentialMode: string,
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
import { promisify } from 'node:util';
import {
  MAX_TESTED_CODEX_VERSION,
  MIN_TESTED_CODEX_VERSION,
  inspectCodexCredentials,
  parseCodexVersion,
  type CodexCredentialMode,
  type InspectCodexCredentialsOptions,
} from '../harnesses/codex-auth.js';

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
/** Classification of the installed codex CLI version against the tested range. */
export type CodexVersionStatus = 'ok' | 'unknown' | 'untested';

export interface CodexDoctorResponse {
  installed: boolean;
  /** Convenience alias — true iff `authStatus === 'ok'`. */
  authenticated: boolean;
  /** Live/expired/absent classification of Codex credentials. */
  authStatus: CodexAuthStatus;
  /** Credential source classification without exposing credential material. */
  credentialMode: CodexCredentialMode;
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
 * differences within the same minor are ignored, so 0.136.5 is NOT above
 * 0.136.0, but 0.137.0 and 1.0.0 are. Used for the upper-bound check (#675)
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
  const credentialOptions: InspectCodexCredentialsOptions = {
    ...(config.env !== undefined ? { environment: config.env } : {}),
    ...(config.readAuthFile !== undefined
      ? { readAuthFile: (_path: string) => config.readAuthFile!() }
      : {}),
    ...(config.now !== undefined ? { now: config.now } : {}),
  };
  const credentialInspection = runnable
    ? inspectCodexCredentials(credentialOptions)
    : {
        status: 'not_configured',
        mode: 'not-configured',
      } as const;
  const authStatus: CodexAuthStatus = credentialInspection.status;

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
    credentialMode: credentialInspection.mode,
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
