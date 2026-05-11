/**
 * @vitest-environment node
 *
 * Unit tests for GET /api/hermes/doctor.
 *
 * The route calls spawnSync to run `hermes doctor`. We mock spawnSync via
 * vi.mock so the tests run without a real hermes binary.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock node:child_process before importing the module under test so vi.mock
// hoisting applies correctly.
const spawnSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const { addHermesDoctorRoutes } = await import('../../src/api/hermes-doctor-endpoint.js');

interface HermesDoctorBody {
  installed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function buildApp(config: { hermesPath?: string; hermesDoctorTimeoutMs?: number } = {}) {
  const app = new Hono();
  addHermesDoctorRoutes(app, config);
  return app;
}

beforeEach(() => {
  spawnSyncMock.mockReset();
});

describe('GET /api/hermes/doctor', () => {
  it('returns installed:false when hermes binary is not found (ENOENT)', async () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      error: Object.assign(new Error('spawn hermes ENOENT'), { code: 'ENOENT' }),
      stdout: '',
      stderr: '',
    });

    const app = buildApp();
    const res = await app.request('/api/hermes/doctor');
    expect(res.status).toBe(200);

    const body = (await res.json()) as HermesDoctorBody;
    expect(body.installed).toBe(false);
    expect(body.exitCode).toBeNull();
    expect(body.stdout).toBe('');
    expect(body.stderr).toBe('');
  });

  it('returns installed:true, exitCode:0 when hermes doctor succeeds', async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      error: undefined,
      stdout: 'hermes doctor: all checks passed\n',
      stderr: '',
    });

    const app = buildApp();
    const res = await app.request('/api/hermes/doctor');
    expect(res.status).toBe(200);

    const body = (await res.json()) as HermesDoctorBody;
    expect(body.installed).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('all checks passed');
    expect(body.stderr).toBe('');
  });

  it('returns installed:true, exitCode:1 with stderr when hermes doctor reports a config issue', async () => {
    const diagnosticMsg = 'error: no provider configured; run `hermes model` to set one';
    spawnSyncMock.mockReturnValue({
      status: 1,
      error: undefined,
      stdout: '',
      stderr: diagnosticMsg,
    });

    const app = buildApp();
    const res = await app.request('/api/hermes/doctor');
    expect(res.status).toBe(200);

    const body = (await res.json()) as HermesDoctorBody;
    expect(body.installed).toBe(true);
    expect(body.exitCode).toBe(1);
    expect(body.stdout).toBe('');
    expect(body.stderr).toBe(diagnosticMsg);
  });

  it('uses the configured hermesPath binary', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined, stdout: '', stderr: '' });

    const app = buildApp({ hermesPath: '/opt/hermes/bin/hermes' });
    await app.request('/api/hermes/doctor');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      '/opt/hermes/bin/hermes',
      ['doctor'],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it('uses the configured hermesDoctorTimeoutMs', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined, stdout: '', stderr: '' });

    const app = buildApp({ hermesDoctorTimeoutMs: 5_000 });
    await app.request('/api/hermes/doctor');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'hermes',
      ['doctor'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('truncates stdout and stderr to 4000 characters', async () => {
    const longOutput = 'x'.repeat(5000);
    spawnSyncMock.mockReturnValue({
      status: 0,
      error: undefined,
      stdout: longOutput,
      stderr: longOutput,
    });

    const app = buildApp();
    const res = await app.request('/api/hermes/doctor');
    const body = (await res.json()) as HermesDoctorBody;

    expect(body.stdout).toHaveLength(4000);
    expect(body.stderr).toHaveLength(4000);
  });
});
