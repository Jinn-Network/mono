/**
 * GET /api/codex/doctor
 *
 * Runs `codex --version` via spawnSync and inspects the auth configuration so
 * the operator dashboard can show an install-required / sign-in-required panel
 * before the operator saves a Codex harness selection.
 *
 * Response shape:
 *   { installed: boolean, authenticated: boolean, exitCode: number | null,
 *     stdout: string, stderr: string }
 *
 * `installed: false` means the binary was not found (ENOENT or equivalent).
 * `exitCode !== 0` (with `installed: true`) means the binary exists but
 * `codex --version` itself failed.
 * `authenticated: false` (with `installed: true`, `exitCode === 0`) means the
 * binary is present and runnable but no credentials are configured — Codex
 * authenticates via the `OPENAI_API_KEY` env var or a `codex login` session
 * persisted under `CODEX_HOME` / `~/.codex/auth.json`.
 *
 * The probe logic is exported as `probeCodexDoctor` so the Codex variant of
 * the `LearnerHarness` can reuse it from `isReady()` — same source of truth
 * for the SPA precheck panel and the daemon's claim-readiness gate (#348,
 * same-shape bug as #330).
 *
 * Codex (unlike Hermes) has no `codex doctor` subcommand, so install
 * detection shells `codex --version` and auth detection is a separate
 * filesystem / env check rather than a probe exit code.
 */
import type { Hono } from 'hono';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexDoctorResponse {
  installed: boolean;
  authenticated: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CodexDoctorConfig {
  codexPath?: string;
  codexDoctorTimeoutMs?: number;
  /** Inject env for testing (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Override the auth-file existence check (for testing). */
  authFileExists?: boolean;
}

/**
 * Whether Codex has usable credentials. Codex authenticates either via the
 * `OPENAI_API_KEY` env var or via a `codex login` session persisted to
 * `auth.json` under `CODEX_HOME` (falling back to `~/.codex`).
 */
function detectCodexAuth(config: CodexDoctorConfig): boolean {
  if (config.authFileExists !== undefined) {
    return config.authFileExists || hasApiKey(config);
  }
  if (hasApiKey(config)) return true;
  const env = config.env ?? process.env;
  const codexHome = env['CODEX_HOME']?.trim();
  const authPath = codexHome
    ? join(codexHome, 'auth.json')
    : join(homedir(), '.codex', 'auth.json');
  return existsSync(authPath);
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
  const authenticated = installed && result.status === 0 && detectCodexAuth(config);

  return {
    installed,
    authenticated,
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
