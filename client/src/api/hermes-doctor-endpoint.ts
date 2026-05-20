/**
 * GET /api/hermes/doctor
 *
 * Runs `hermes doctor` via spawnSync and returns the result so the operator
 * dashboard can show an install-required panel before the operator saves a
 * Hermes Agent harness selection.
 *
 * Response shape:
 *   { installed: boolean, exitCode: number | null, stdout: string, stderr: string }
 *
 * `installed: false` means the binary was not found (ENOENT or equivalent).
 * `exitCode !== 0` (with `installed: true`) means the binary exists but
 * reports a config problem.
 *
 * The probe logic is exported as `probeHermesDoctor` so the Hermes harness
 * can reuse it from `isReady()` — same source of truth for the SPA
 * precheck panel and the daemon's claim-readiness gate (#330).
 */
import type { Hono } from 'hono';
import { spawnSync } from 'node:child_process';

export interface HermesDoctorResponse {
  installed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface HermesDoctorConfig {
  hermesPath?: string;
  hermesDoctorTimeoutMs?: number;
}

/**
 * Synchronously runs `hermes doctor` and classifies the result. Pure (no
 * Hono dependency) so the harness layer can call it without pulling the API
 * server in.
 */
export function probeHermesDoctor(config: HermesDoctorConfig = {}): HermesDoctorResponse {
  const hermesBin = config.hermesPath ?? 'hermes';
  const timeoutMs = config.hermesDoctorTimeoutMs ?? 30_000;

  const result = spawnSync(hermesBin, ['doctor'], {
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
  return {
    installed,
    exitCode: result.status,
    stdout: (result.stdout ?? '').slice(0, 4000),
    stderr: (result.stderr ?? '').slice(0, 4000),
  };
}

/**
 * Result of probing a single Hermes model provider's auth state.
 */
export interface HermesAuthStatus {
  /** Provider name probed, e.g. `openrouter`. */
  provider: string;
  /** True only when the provider is authenticated (logged in). */
  authed: boolean;
  /** Raw `hermes auth status <provider>` stdout (trimmed, truncated). */
  raw: string;
}

/**
 * Synchronously runs `hermes auth status <provider>` and classifies whether
 * the provider is authenticated.
 *
 * CRITICAL: `hermes auth status` ALWAYS exits 0 — it reports state via
 * stdout, never via exit code. A not-logged-in provider prints e.g.
 * `openrouter: logged out`. So we cannot rely on `result.status`; we parse
 * stdout instead:
 *   - stdout matches /logged out/i → not authed
 *   - stdout is empty → not authed (binary said nothing definitive)
 *   - ENOENT / spawn error → not authed (binary not on PATH)
 *   - otherwise → authed
 *
 * Pure (no Hono dependency) so the harness layer can call it without
 * pulling the API server in. This is the third readiness gate for Hermes:
 * `hermes doctor` exits 0 even when every provider is logged out (it treats
 * missing providers as warnings), so the harness must probe auth directly.
 */
export function probeHermesAuthStatus(
  provider: string,
  config: HermesDoctorConfig = {},
): HermesAuthStatus {
  const hermesBin = config.hermesPath ?? 'hermes';
  const timeoutMs = config.hermesDoctorTimeoutMs ?? 30_000;

  const result = spawnSync(hermesBin, ['auth', 'status', provider], {
    timeout: timeoutMs,
    encoding: 'utf8',
  });

  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const raw = (result.stdout ?? '').trim().slice(0, 4000);

  // Binary not found, or any other spawn error, or no output → not authed.
  if (errorCode != null || raw.length === 0) {
    return { provider, authed: false, raw };
  }
  // `hermes auth status` always exits 0; state is in stdout. A "logged out"
  // line means the provider is not authenticated.
  const loggedOut = /logged out/i.test(raw);
  return { provider, authed: !loggedOut, raw };
}

export function addHermesDoctorRoutes(app: Hono, config: HermesDoctorConfig = {}): void {
  app.get('/api/hermes/doctor', (c) => {
    return c.json(probeHermesDoctor(config));
  });
}
