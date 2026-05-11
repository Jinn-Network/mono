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

export function addHermesDoctorRoutes(app: Hono, config: HermesDoctorConfig = {}): void {
  app.get('/api/hermes/doctor', (c) => {
    const hermesBin = config.hermesPath ?? 'hermes';
    const timeoutMs = config.hermesDoctorTimeoutMs ?? 30_000;

    const result = spawnSync(hermesBin, ['doctor'], {
      timeout: timeoutMs,
      encoding: 'utf8',
    });

    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    // installed=true means we found the binary. ENOENT is the only definitive
    // not-installed signal. A timeout (ETIMEDOUT, result.signal set) means the
    // binary did run but didn't finish in time — installed, but exitCode null;
    // the panel surfaces this as a config-issue.
    const notFound = errorCode === 'ENOENT';
    const installed = !notFound && (result.status !== null || result.signal !== null);
    const body: HermesDoctorResponse = {
      installed,
      exitCode: result.status,
      stdout: (result.stdout ?? '').slice(0, 4000),
      stderr: (result.stderr ?? '').slice(0, 4000),
    };

    return c.json(body);
  });
}
