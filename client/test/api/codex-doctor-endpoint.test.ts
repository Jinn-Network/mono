/**
 * @vitest-environment node
 *
 * Unit tests for GET /api/codex/doctor and the exported `probeCodexDoctor`.
 *
 * Codex has no `codex doctor` subcommand, so install detection shells
 * `codex --version`. Codex also exposes no auth-status subcommand, so auth
 * liveness is derived by parsing + expiry-checking the `auth.json` it
 * persists — existence alone is not enough (#366): a stale OAuth session
 * reads as logged-in to a naive existence check, false-gating the daemon.
 *
 * We mock spawnSync (install probe) and readFileSync (auth-file read) so the
 * tests run without a real codex binary or a real `~/.codex/auth.json`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock node:child_process and node:fs before importing the module under test
// so vi.mock hoisting applies correctly.
const spawnSyncMock = vi.fn();
const readFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

const { addCodexDoctorRoutes, probeCodexDoctor } = await import(
  '../../src/api/codex-doctor-endpoint.js'
);

type CodexAuthStatus = 'ok' | 'expired' | 'not_configured';

interface CodexDoctorBody {
  installed: boolean;
  authenticated: boolean;
  authStatus: CodexAuthStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CodexDoctorConfig {
  codexPath?: string;
  codexDoctorTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  readAuthFile?: () => string | undefined;
  now?: number;
}

function buildApp(config: CodexDoctorConfig = {}) {
  const app = new Hono();
  addCodexDoctorRoutes(app, config);
  return app;
}

/** Builds a JWT-shaped token whose payload carries the given `exp` (seconds). */
function jwtWithExp(expSeconds: number | undefined): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify(expSeconds === undefined ? { sub: 'u' } : { sub: 'u', exp: expSeconds }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

/** A well-formed OAuth (`chatgpt`-mode) auth.json whose id_token expires at `expSeconds`. */
function oauthAuthJson(expSeconds: number): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwtWithExp(expSeconds),
      access_token: jwtWithExp(expSeconds),
      refresh_token: 'rt_xxx',
      account_id: 'acct_xxx',
    },
    last_refresh: '2026-05-20T11:57:52.936277Z',
  });
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  readFileSyncMock.mockReset();
  // Default: no auth file on disk (ENOENT) unless a test opts in.
  readFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
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
    expect(body.authStatus).toBe('not_configured');
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
    expect(body.authStatus).toBe('not_configured');
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

describe('probeCodexDoctor — auth detection (presence)', () => {
  function okSpawn() {
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: 'codex 1.2.3\n',
      stderr: '',
    });
  }

  it('authStatus:ok when OPENAI_API_KEY env var is present', () => {
    okSpawn();

    const result = probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-test-123' } });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.authStatus).toBe('ok');
    // env-based auth short-circuits the filesystem probe.
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('authStatus:not_configured when OPENAI_API_KEY is absent and no auth file exists', () => {
    okSpawn();

    const result = probeCodexDoctor({ env: {} });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.authStatus).toBe('not_configured');
  });

  it('treats an empty/whitespace OPENAI_API_KEY as absent', () => {
    okSpawn();

    const result = probeCodexDoctor({ env: { OPENAI_API_KEY: '   ' } });
    expect(result.authStatus).toBe('not_configured');
  });

  it('reads ~/.codex/auth.json when CODEX_HOME is unset', () => {
    okSpawn();
    readFileSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('/.codex/auth.json')) {
        return oauthAuthJson(Math.floor(Date.now() / 1000) + 3600);
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = probeCodexDoctor({ env: {} });
    expect(result.authStatus).toBe('ok');
  });

  it('reads $CODEX_HOME/auth.json when CODEX_HOME is set', () => {
    okSpawn();
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === '/custom/codex/auth.json') {
        return oauthAuthJson(Math.floor(Date.now() / 1000) + 3600);
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = probeCodexDoctor({ env: { CODEX_HOME: '/custom/codex' } });
    expect(result.authStatus).toBe('ok');
    expect(readFileSyncMock).toHaveBeenCalledWith('/custom/codex/auth.json', 'utf8');
  });

  it('authStatus:not_configured when CODEX_HOME is set but its auth.json is absent', () => {
    okSpawn();

    const result = probeCodexDoctor({ env: { CODEX_HOME: '/custom/codex' } });
    expect(result.authStatus).toBe('not_configured');
    expect(readFileSyncMock).toHaveBeenCalledWith('/custom/codex/auth.json', 'utf8');
  });

  it('authStatus:ok via the readAuthFile override (api-key-mode file)', () => {
    okSpawn();

    const result = probeCodexDoctor({
      env: {},
      readAuthFile: () => JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-file-123' }),
    });
    expect(result.authStatus).toBe('ok');
    // Override skips the real filesystem probe.
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('authStatus:not_configured via the readAuthFile override (no file, no api key)', () => {
    okSpawn();

    const result = probeCodexDoctor({ env: {}, readAuthFile: () => undefined });
    expect(result.authStatus).toBe('not_configured');
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('OPENAI_API_KEY env still authenticates even when readAuthFile returns nothing', () => {
    okSpawn();

    const result = probeCodexDoctor({
      env: { OPENAI_API_KEY: 'sk-test-123' },
      readAuthFile: () => undefined,
    });
    expect(result.authStatus).toBe('ok');
  });

  it('authStatus:not_configured when binary is not installed even if credentials exist', () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      signal: null,
      error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
      stdout: '',
      stderr: '',
    });

    const result = probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-test-123' } });
    expect(result.installed).toBe(false);
    expect(result.authStatus).toBe('not_configured');
  });
});

describe('probeCodexDoctor — auth liveness (#366)', () => {
  function okSpawn() {
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: 'codex 1.2.3\n',
      stderr: '',
    });
  }

  const NOW_MS = Date.UTC(2026, 4, 20, 12, 0, 0);

  it('authStatus:ok for a non-expired OAuth (chatgpt-mode) auth.json', () => {
    okSpawn();
    const futureExp = Math.floor(NOW_MS / 1000) + 3600;

    const result = probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () => oauthAuthJson(futureExp),
    });
    expect(result.authenticated).toBe(true);
    expect(result.authStatus).toBe('ok');
  });

  it('authStatus:expired for a stale OAuth auth.json whose id_token has expired', () => {
    okSpawn();
    const pastExp = Math.floor(NOW_MS / 1000) - 3600; // expired an hour ago

    const result = probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () => oauthAuthJson(pastExp),
    });
    // The bug: existence-only detection read this as authenticated:true.
    expect(result.authenticated).toBe(false);
    expect(result.authStatus).toBe('expired');
  });

  it('authStatus:expired for a malformed (unparseable) auth.json — never crashes', () => {
    okSpawn();

    const result = probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () => '{ "auth_mode": "chatgpt", "tokens": {',
    });
    expect(result.authenticated).toBe(false);
    expect(result.authStatus).toBe('expired');
  });

  it('authStatus:expired for an auth.json with no tokens and no api key', () => {
    okSpawn();

    const result = probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () => JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }),
    });
    expect(result.authStatus).toBe('expired');
  });

  it('authStatus:expired for an auth.json whose tokens are not JWTs (no exp claim)', () => {
    okSpawn();

    const result = probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () =>
        JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: { id_token: 'not-a-jwt', access_token: 'also-not-a-jwt' },
        }),
    });
    expect(result.authStatus).toBe('expired');
  });

  it('falls back to access_token expiry when id_token carries no exp', () => {
    okSpawn();
    const header = Buffer.from('{}').toString('base64url');
    const noExpPayload = Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url');
    const idTokenNoExp = `${header}.${noExpPayload}.sig`;
    const futureExp = Math.floor(NOW_MS / 1000) + 3600;
    const accessPayload = Buffer.from(
      JSON.stringify({ sub: 'u', exp: futureExp }),
    ).toString('base64url');
    const accessToken = `${header}.${accessPayload}.sig`;

    const result = probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () =>
        JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: { id_token: idTokenNoExp, access_token: accessToken },
        }),
    });
    expect(result.authStatus).toBe('ok');
  });

  it('authStatus:ok for an api-key-mode auth.json (no expiry to check)', () => {
    okSpawn();

    const result = probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () =>
        JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-file-key' }),
    });
    expect(result.authStatus).toBe('ok');
  });

  it('treats an unreadable (EACCES) auth.json as expired, not not_configured', () => {
    okSpawn();
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    const result = probeCodexDoctor({ env: {}, now: NOW_MS });
    expect(result.authStatus).toBe('expired');
  });
});
