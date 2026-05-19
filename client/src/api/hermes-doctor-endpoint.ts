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

export function addHermesDoctorRoutes(app: Hono, config: HermesDoctorConfig = {}): void {
  app.get('/api/hermes/doctor', (c) => {
    return c.json(probeHermesDoctor(config));
  });
}
