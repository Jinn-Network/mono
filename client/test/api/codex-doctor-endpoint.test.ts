/**
 * @vitest-environment node
 *
 * Unit tests for GET /api/codex/doctor and the exported `probeCodexDoctor`.
 *
 * Codex has no `codex doctor` subcommand, so install detection shells
 * `codex --version` and auth detection is a separate filesystem / env check.
 * We mock spawnSync (install probe) and existsSync (auth-file probe) so the
 * tests run without a real codex binary or a real `~/.codex/auth.json`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock node:child_process and node:fs before importing the module under test
// so vi.mock hoisting applies correctly.
const spawnSyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
}));

const { addCodexDoctorRoutes, probeCodexDoctor } = await import(
  '../../src/api/codex-doctor-endpoint.js'
);

interface CodexDoctorBody {
  installed: boolean;
  authenticated: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CodexDoctorConfig {
  codexPath?: string;
  codexDoctorTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  authFileExists?: boolean;
}

function buildApp(config: CodexDoctorConfig = {}) {
  const app = new Hono();
  addCodexDoctorRoutes(app, config);
  return app;
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  existsSyncMock.mockReset();
  // Default: no auth file on disk unless a test opts in.
  existsSyncMock.mockReturnValue(false);
});

describe('GET /api/codex/doctor — install detection', () => {
  it('returns installed:false when codex binary is not found (ENOENT)', async () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      signal: null,
      error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
      stdout: '',
      stderr: '',
    });

    const app = buildApp();
    const res = await app.request('/api/codex/doctor');
    expect(res.status).toBe(200);

    const body = (await res.json()) as CodexDoctorBody;
    expect(body.installed).toBe(false);
    expect(body.authenticated).toBe(false);
    expect(body.exitCode).toBeNull();
    expect(body.stdout).toBe('');
    expect(body.stderr).toBe('');
  });

  it('returns installed:true, exitCode:0 when codex --version succeeds', async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: 'codex 1.2.3\n',
      stderr: '',
    });

    const app = buildApp({ env: {} });
    const res = await app.request('/api/codex/doctor');
    expect(res.status).toBe(200);

    const body = (await res.json()) as CodexDoctorBody;
    expect(body.installed).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('codex 1.2.3');
    expect(body.stderr).toBe('');
  });

  it('returns installed:true, exitCode:1 with stderr when codex --version reports a config issue', async () => {
    const diagnosticMsg = 'error: failed to load configuration';
    spawnSyncMock.mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stdout: '',
      stderr: diagnosticMsg,
    });

    const app = buildApp({ env: {} });
    const res = await app.request('/api/codex/doctor');
    expect(res.status).toBe(200);

    const body = (await res.json()) as CodexDoctorBody;
    expect(body.installed).toBe(true);
    expect(body.exitCode).toBe(1);
    // Non-zero exit means auth is not meaningful even if credentials exist.
    expect(body.authenticated).toBe(false);
    expect(body.stdout).toBe('');
    expect(body.stderr).toBe(diagnosticMsg);
  });

  it('treats EACCES (binary exists but not executable) as installed:true (config-issue, not install prompt)', async () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      signal: null,
      error: Object.assign(new Error('spawn codex EACCES'), { code: 'EACCES' }),
      stdout: '',
      stderr: '',
    });

    const app = buildApp({ env: {} });
    const res = await app.request('/api/codex/doctor');
    const body = (await res.json()) as CodexDoctorBody;

    expect(body.installed).toBe(true);
    expect(body.authenticated).toBe(false);
    expect(body.exitCode).toBeNull();
  });

  it('treats spawnSync timeout (ETIMEDOUT) as installed:true with exitCode null', async () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      stdout: '',
      stderr: '',
    });

    const app = buildApp({ env: {} });
    const res = await app.request('/api/codex/doctor');
    const body = (await res.json()) as CodexDoctorBody;

    expect(body.installed).toBe(true);
    expect(body.authenticated).toBe(false);
    expect(body.exitCode).toBeNull();
  });

  it('uses the configured codexPath binary', async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: '',
      stderr: '',
    });

    const app = buildApp({ codexPath: '/opt/codex/bin/codex', env: {} });
    await app.request('/api/codex/doctor');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      '/opt/codex/bin/codex',
      ['--version'],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it('uses the configured codexDoctorTimeoutMs', async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: '',
      stderr: '',
    });

    const app = buildApp({ codexDoctorTimeoutMs: 5_000, env: {} });
    await app.request('/api/codex/doctor');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'codex',
      ['--version'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('truncates stdout and stderr to 4000 characters', async () => {
    const longOutput = 'x'.repeat(5000);
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: longOutput,
      stderr: longOutput,
    });

    const app = buildApp({ env: {} });
    const res = await app.request('/api/codex/doctor');
    const body = (await res.json()) as CodexDoctorBody;

    expect(body.stdout).toHaveLength(4000);
    expect(body.stderr).toHaveLength(4000);
  });
});

describe('probeCodexDoctor — auth detection', () => {
  function okSpawn() {
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: 'codex 1.2.3\n',
      stderr: '',
    });
  }

  it('authenticated:true when OPENAI_API_KEY env var is present', () => {
    okSpawn();
    existsSyncMock.mockReturnValue(false);

    const result = probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-test-123' } });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(true);
    // env-based auth short-circuits the filesystem probe.
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('authenticated:false when OPENAI_API_KEY is absent and no auth file exists', () => {
    okSpawn();
    existsSyncMock.mockReturnValue(false);

    const result = probeCodexDoctor({ env: {} });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(false);
  });

  it('treats an empty/whitespace OPENAI_API_KEY as absent', () => {
    okSpawn();
    existsSyncMock.mockReturnValue(false);

    const result = probeCodexDoctor({ env: { OPENAI_API_KEY: '   ' } });
    expect(result.authenticated).toBe(false);
  });

  it('authenticated:true when ~/.codex/auth.json exists', () => {
    okSpawn();
    existsSyncMock.mockImplementation((p: string) => p.endsWith('/.codex/auth.json'));

    const result = probeCodexDoctor({ env: {} });
    expect(result.authenticated).toBe(true);
  });

  it('checks $CODEX_HOME/auth.json when CODEX_HOME is set', () => {
    okSpawn();
    existsSyncMock.mockImplementation(
      (p: string) => p === '/custom/codex/auth.json',
    );

    const result = probeCodexDoctor({ env: { CODEX_HOME: '/custom/codex' } });
    expect(result.authenticated).toBe(true);
    expect(existsSyncMock).toHaveBeenCalledWith('/custom/codex/auth.json');
  });

  it('authenticated:false when CODEX_HOME is set but its auth.json is absent', () => {
    okSpawn();
    existsSyncMock.mockReturnValue(false);

    const result = probeCodexDoctor({ env: { CODEX_HOME: '/custom/codex' } });
    expect(result.authenticated).toBe(false);
    expect(existsSyncMock).toHaveBeenCalledWith('/custom/codex/auth.json');
  });

  it('honours the authFileExists test-override branch (true)', () => {
    okSpawn();

    const result = probeCodexDoctor({ env: {}, authFileExists: true });
    expect(result.authenticated).toBe(true);
    // Override skips the real filesystem probe.
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('honours the authFileExists test-override branch (false, no api key)', () => {
    okSpawn();

    const result = probeCodexDoctor({ env: {}, authFileExists: false });
    expect(result.authenticated).toBe(false);
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('authFileExists:false still authenticates when OPENAI_API_KEY is present', () => {
    okSpawn();

    const result = probeCodexDoctor({
      env: { OPENAI_API_KEY: 'sk-test-123' },
      authFileExists: false,
    });
    expect(result.authenticated).toBe(true);
  });

  it('authenticated:false when binary is not installed even if credentials exist', () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      signal: null,
      error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
      stdout: '',
      stderr: '',
    });

    const result = probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-test-123' } });
    expect(result.installed).toBe(false);
    expect(result.authenticated).toBe(false);
  });
});
