/**
 * @vitest-environment node
 *
 * Unit tests for GET /api/codex/doctor and the exported `probeCodexDoctor`.
 *
 * Codex has no `codex doctor` subcommand, so install detection shells
 * `codex --version`. Codex also exposes no auth-status subcommand, so auth
 * liveness is derived by parsing the `auth.json` it persists. The live-ness
 * signal is the `refresh_token` (#464): codex mints fresh id/access tokens
 * from it on demand, so the short-lived id_token (~1h) and access_token
 * routinely lapse between runs on a perfectly healthy login. A genuinely
 * dead session has no refresh_token and no usable credential (#366) — that
 * must still read as not-live.
 *
 * Per #778 follow-up the install probe uses `promisify(execFile)` (the
 * original `spawnSync` blocked the daemon event loop on every
 * readiness-registry refresh). We mock `execFile` (callback-style) and
 * `readFileSync` so the tests run without a real codex binary or a real
 * `~/.codex/auth.json`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { Store } from '../../src/store/store.js';
import { startApiServer, type ApiServer } from '../../src/api/server.js';

interface ExecFileExitOk {
  type: 'ok';
  stdout: string;
  stderr: string;
}
interface ExecFileExitError {
  type: 'error';
  code?: number | string;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  message?: string;
}
type ExecFileOutcome = ExecFileExitOk | ExecFileExitError;

// Mock node:child_process and node:fs before importing the module under test
// so vi.mock hoisting applies correctly. See the matching block in
// hermes-doctor-endpoint.test.ts for the rationale on re-attaching
// `util.promisify.custom` — without it the mocked execFile loses the
// `{stdout, stderr}` resolution shape and the production unwrap path breaks.
const { execFileMock, readFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<unknown[], unknown>(),
  readFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const { promisify: promisifyImpl } = await import('node:util');

  function mockedExecFile(...args: unknown[]): unknown {
    const callback = args[args.length - 1] as
      | ((err: (Error & Record<string, unknown>) | null, stdout: string, stderr: string) => void)
      | undefined;
    const outcome = execFileMock(...args) as ExecFileOutcome;
    queueMicrotask(() => {
      if (!callback) return;
      if (outcome.type === 'ok') {
        callback(null, outcome.stdout, outcome.stderr);
      } else {
        const err = Object.assign(new Error(outcome.message ?? 'execFile failed'), {
          code: outcome.code,
          signal: outcome.signal ?? null,
          stdout: outcome.stdout ?? '',
          stderr: outcome.stderr ?? '',
          killed: outcome.signal != null,
        });
        callback(err as Error & Record<string, unknown>, outcome.stdout ?? '', outcome.stderr ?? '');
      }
    });
    return { stdin: null, kill: () => {} };
  }

  (mockedExecFile as unknown as { [k: symbol]: unknown })[promisifyImpl.custom] = (
    file: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mockedExecFile(
        file,
        args,
        options ?? {},
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) {
            const errAny = err as Error & { stdout?: string; stderr?: string };
            if (errAny.stdout === undefined) errAny.stdout = stdout;
            if (errAny.stderr === undefined) errAny.stderr = stderr;
            reject(err);
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
    });

  return { execFile: mockedExecFile };
});

// Mock only `readFileSync` (the codex auth-file probe); delegate everything
// else to the real module so importing `startApiServer` into this file (for
// the #679 UI-token-gate block) keeps the real `existsSync` its build-info
// load path depends on.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  };
});

const { addCodexDoctorRoutes, probeCodexDoctor } = await import(
  '../../src/api/codex-doctor-endpoint.js'
);

type CodexAuthStatus = 'ok' | 'expired' | 'not_configured';
type CodexVersionStatus = 'ok' | 'unknown' | 'untested';

interface CodexDoctorBody {
  installed: boolean;
  authenticated: boolean;
  authStatus: CodexAuthStatus;
  cliVersion: string | null;
  versionStatus: CodexVersionStatus;
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

/** Test-only sugar: pin the next execFile call's outcome. */
function mockNext(outcome: ExecFileOutcome): void {
  execFileMock.mockReturnValueOnce(outcome);
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

/**
 * A well-formed OAuth (`chatgpt`-mode) auth.json — id_token + access_token both
 * expire at `expSeconds`; a `refresh_token` is always present (as on a real
 * logged-in `auth.json`).
 */
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
  execFileMock.mockReset();
  readFileSyncMock.mockReset();
  // Default: no auth file on disk (ENOENT) unless a test opts in.
  readFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  // Silence the #675 untested-version warning so it does not pollute test
  // output. Tests that assert on warn behaviour install their own spy.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('GET /api/codex/doctor — install detection', () => {
  it('returns installed:false when codex binary is not found (ENOENT)', async () => {
    mockNext({ type: 'error', code: 'ENOENT', message: 'spawn codex ENOENT' });

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
    mockNext({ type: 'ok', stdout: 'codex 1.2.3\n', stderr: '' });

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
    mockNext({ type: 'error', code: 1, stdout: '', stderr: diagnosticMsg });

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
    mockNext({ type: 'error', code: 'EACCES', message: 'spawn codex EACCES' });

    const app = buildApp({ env: {} });
    const res = await app.request('/api/codex/doctor');
    const body = (await res.json()) as CodexDoctorBody;

    expect(body.installed).toBe(true);
    expect(body.authenticated).toBe(false);
    expect(body.exitCode).toBeNull();
  });

  it('treats execFile timeout (ETIMEDOUT) as installed:true with exitCode null', async () => {
    mockNext({
      type: 'error',
      code: 'ETIMEDOUT',
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      message: 'ETIMEDOUT',
    });

    const app = buildApp({ env: {} });
    const res = await app.request('/api/codex/doctor');
    const body = (await res.json()) as CodexDoctorBody;

    expect(body.installed).toBe(true);
    expect(body.authenticated).toBe(false);
    expect(body.exitCode).toBeNull();
  });

  it('uses the configured codexPath binary', async () => {
    mockNext({ type: 'ok', stdout: '', stderr: '' });

    const app = buildApp({ codexPath: '/opt/codex/bin/codex', env: {} });
    await app.request('/api/codex/doctor');

    expect(execFileMock).toHaveBeenCalledWith(
      '/opt/codex/bin/codex',
      ['--version'],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    );
  });

  it('uses the configured codexDoctorTimeoutMs', async () => {
    mockNext({ type: 'ok', stdout: '', stderr: '' });

    const app = buildApp({ codexDoctorTimeoutMs: 5_000, env: {} });
    await app.request('/api/codex/doctor');

    expect(execFileMock).toHaveBeenCalledWith(
      'codex',
      ['--version'],
      expect.objectContaining({ timeout: 5_000 }),
      expect.any(Function),
    );
  });

  it('truncates stdout and stderr to 4000 characters', async () => {
    const longOutput = 'x'.repeat(5000);
    mockNext({ type: 'ok', stdout: longOutput, stderr: longOutput });

    const app = buildApp({ env: {} });
    const res = await app.request('/api/codex/doctor');
    const body = (await res.json()) as CodexDoctorBody;

    expect(body.stdout).toHaveLength(4000);
    expect(body.stderr).toHaveLength(4000);
  });
});

describe('probeCodexDoctor — auth detection (presence)', () => {
  function okSpawn() {
    mockNext({ type: 'ok', stdout: 'codex 1.2.3\n', stderr: '' });
  }

  it('authStatus:ok when OPENAI_API_KEY env var is present', async () => {
    okSpawn();

    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-test-123' } });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.authStatus).toBe('ok');
    // env-based auth short-circuits the filesystem probe.
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('authStatus:not_configured when OPENAI_API_KEY is absent and no auth file exists', async () => {
    okSpawn();

    const result = await probeCodexDoctor({ env: {} });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.authStatus).toBe('not_configured');
  });

  it('treats an empty/whitespace OPENAI_API_KEY as absent', async () => {
    okSpawn();

    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: '   ' } });
    expect(result.authStatus).toBe('not_configured');
  });

  it('reads ~/.codex/auth.json when CODEX_HOME is unset', async () => {
    okSpawn();
    readFileSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('/.codex/auth.json')) {
        return oauthAuthJson(Math.floor(Date.now() / 1000) + 3600);
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await probeCodexDoctor({ env: {} });
    expect(result.authStatus).toBe('ok');
  });

  it('reads $CODEX_HOME/auth.json when CODEX_HOME is set', async () => {
    okSpawn();
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === '/custom/codex/auth.json') {
        return oauthAuthJson(Math.floor(Date.now() / 1000) + 3600);
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await probeCodexDoctor({ env: { CODEX_HOME: '/custom/codex' } });
    expect(result.authStatus).toBe('ok');
    expect(readFileSyncMock).toHaveBeenCalledWith('/custom/codex/auth.json', 'utf8');
  });

  it('authStatus:not_configured when CODEX_HOME is set but its auth.json is absent', async () => {
    okSpawn();

    const result = await probeCodexDoctor({ env: { CODEX_HOME: '/custom/codex' } });
    expect(result.authStatus).toBe('not_configured');
    expect(readFileSyncMock).toHaveBeenCalledWith('/custom/codex/auth.json', 'utf8');
  });

  it('authStatus:ok via the readAuthFile override (api-key-mode file)', async () => {
    okSpawn();

    const result = await probeCodexDoctor({
      env: {},
      readAuthFile: () => JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-file-123' }),
    });
    expect(result.authStatus).toBe('ok');
    // Override skips the real filesystem probe.
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('authStatus:not_configured via the readAuthFile override (no file, no api key)', async () => {
    okSpawn();

    const result = await probeCodexDoctor({ env: {}, readAuthFile: () => undefined });
    expect(result.authStatus).toBe('not_configured');
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('OPENAI_API_KEY env still authenticates even when readAuthFile returns nothing', async () => {
    okSpawn();

    const result = await probeCodexDoctor({
      env: { OPENAI_API_KEY: 'sk-test-123' },
      readAuthFile: () => undefined,
    });
    expect(result.authStatus).toBe('ok');
  });

  it('authStatus:not_configured when binary is not installed even if credentials exist', async () => {
    mockNext({ type: 'error', code: 'ENOENT', message: 'spawn codex ENOENT' });

    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-test-123' } });
    expect(result.installed).toBe(false);
    expect(result.authStatus).toBe('not_configured');
  });
});

describe('probeCodexDoctor — auth liveness (#366, #464)', () => {
  function okSpawn() {
    mockNext({ type: 'ok', stdout: 'codex 1.2.3\n', stderr: '' });
  }

  const NOW_MS = Date.UTC(2026, 4, 20, 12, 0, 0);

  it('authStatus:ok for a non-expired OAuth (chatgpt-mode) auth.json', async () => {
    okSpawn();
    const futureExp = Math.floor(NOW_MS / 1000) + 3600;

    const result = await probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () => oauthAuthJson(futureExp),
    });
    expect(result.authenticated).toBe(true);
    expect(result.authStatus).toBe('ok');
  });

  // #464 regression: a healthy `codex login` whose short-lived id_token AND
  // access_token have lapsed is NOT a dead session — codex mints fresh tokens
  // from the refresh_token on its next run. `oauthAuthJson` always carries a
  // refresh_token, so this is a live login. Gating it 'expired' deadlocked the
  // readiness gate: the probe shells `codex --version`, which never refreshes,
  // so the daemon never claims, never runs codex, and the tokens never rotate.
  it('authStatus:ok for a healthy login whose id_token + access_token have lapsed but a refresh_token is present (#464)', async () => {
    okSpawn();
    const pastExp = Math.floor(NOW_MS / 1000) - 3600; // both short-lived tokens expired an hour ago

    const result = await probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () => oauthAuthJson(pastExp),
    });
    expect(result.authenticated).toBe(true);
    expect(result.authStatus).toBe('ok');
  });

  // #464: the precise live failure — the ~1h OIDC id_token has rotated out,
  // the access_token is still valid, the refresh_token is present.
  it('authStatus:ok when only the short-lived id_token has expired (#464)', async () => {
    okSpawn();
    const past = Math.floor(NOW_MS / 1000) - 3600;
    const future = Math.floor(NOW_MS / 1000) + 7 * 86_400;

    const result = await probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () =>
        JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            id_token: jwtWithExp(past),
            access_token: jwtWithExp(future),
            refresh_token: 'rt_live',
          },
        }),
    });
    expect(result.authStatus).toBe('ok');
  });

  // #366 (corrected model): a genuinely dead session — short-lived tokens
  // expired AND no refresh_token to renew them — must still read 'expired'.
  // #464 corrected the prior model, which mislabelled a healthy login (tokens
  // lapsed but refresh_token present) as 'stale'.
  it('authStatus:expired for a dead session — tokens expired and no refresh_token', async () => {
    okSpawn();
    const pastExp = Math.floor(NOW_MS / 1000) - 3600;

    const result = await probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () =>
        JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            id_token: jwtWithExp(pastExp),
            access_token: jwtWithExp(pastExp),
            // no refresh_token — nothing can renew this session
          },
        }),
    });
    expect(result.authenticated).toBe(false);
    expect(result.authStatus).toBe('expired');
  });

  it('authStatus:expired for a malformed (unparseable) auth.json — never crashes', async () => {
    okSpawn();

    const result = await probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () => '{ "auth_mode": "chatgpt", "tokens": {',
    });
    expect(result.authenticated).toBe(false);
    expect(result.authStatus).toBe('expired');
  });

  it('authStatus:expired for an auth.json with no tokens and no api key', async () => {
    okSpawn();

    const result = await probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () => JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }),
    });
    expect(result.authStatus).toBe('expired');
  });

  it('authStatus:expired for an auth.json whose tokens are not JWTs (no exp claim)', async () => {
    okSpawn();

    const result = await probeCodexDoctor({
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

  // With no refresh_token the classifier falls back to a bearer-token expiry
  // check — access_token first, id_token only as a last resort.
  it('authStatus:ok via the access_token bearer check when there is no refresh_token', async () => {
    okSpawn();
    const futureExp = Math.floor(NOW_MS / 1000) + 3600;

    const result = await probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () =>
        JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: { id_token: jwtWithExp(undefined), access_token: jwtWithExp(futureExp) },
        }),
    });
    expect(result.authStatus).toBe('ok');
  });

  it('authStatus:ok for an api-key-mode auth.json (no expiry to check)', async () => {
    okSpawn();

    const result = await probeCodexDoctor({
      env: {},
      now: NOW_MS,
      readAuthFile: () =>
        JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-file-key' }),
    });
    expect(result.authStatus).toBe('ok');
  });

  it('treats an unreadable (EACCES) auth.json as expired, not not_configured', async () => {
    okSpawn();
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    const result = await probeCodexDoctor({ env: {}, now: NOW_MS });
    expect(result.authStatus).toBe('expired');
  });
});

// #675 — codex CLI version surfacing. The harness was developed against the
// 0.50.0–0.133.0 window; an out-of-range CLI may break in ways the daemon
// cannot recover from. The doctor parses `codex --version` stdout, classifies
// it against the tested range, and emits a single console.warn on out-of-range.
describe('probeCodexDoctor — CLI version surfacing (#675)', () => {
  function execVersion(stdout: string) {
    execFileMock.mockReturnValue({ type: 'ok', stdout, stderr: '' });
  }

  it('parses cliVersion from `codex --version` stdout', async () => {
    execVersion('codex-cli 0.120.5\n');
    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-x' } });
    expect(result.cliVersion).toBe('0.120.5');
  });

  it('reports cliVersion=null and versionStatus=unknown when stdout has no semver triple', async () => {
    execVersion('codex CLI (build deadbeef)\n');
    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-x' } });
    expect(result.cliVersion).toBeNull();
    expect(result.versionStatus).toBe('unknown');
  });

  it('reports versionStatus=ok for a version inside the tested range', async () => {
    execVersion('codex-cli 0.120.0\n');
    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-x' } });
    expect(result.versionStatus).toBe('ok');
  });

  it('reports versionStatus=untested for a version below MIN_TESTED', async () => {
    execVersion('codex-cli 0.10.0\n');
    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-x' } });
    expect(result.versionStatus).toBe('untested');
    expect(result.cliVersion).toBe('0.10.0');
  });

  it('reports versionStatus=untested for a version above MAX_TESTED', async () => {
    execVersion('codex-cli 0.200.0\n');
    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-x' } });
    expect(result.versionStatus).toBe('untested');
    expect(result.cliVersion).toBe('0.200.0');
  });

  // Patch releases within the same minor as MAX_TESTED_CODEX_VERSION stay
  // 'ok' — codex patch bumps almost never break the CLI contract, and warning
  // on every patch would produce alarm fatigue. Bump MAX on minor/major
  // upgrades only.
  it('reports versionStatus=ok for a patch release within the tested minor (0.133.5)', async () => {
    execVersion('codex-cli 0.133.5\n');
    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-x' } });
    expect(result.versionStatus).toBe('ok');
    expect(result.cliVersion).toBe('0.133.5');
  });

  it('reports versionStatus=untested for a minor bump above MAX_TESTED (0.134.0)', async () => {
    execVersion('codex-cli 0.134.0\n');
    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-x' } });
    expect(result.versionStatus).toBe('untested');
    expect(result.cliVersion).toBe('0.134.0');
  });

  it('readiness is not affected by versionStatus (an untested version still authenticates)', async () => {
    execVersion('codex-cli 0.200.0\n');
    const result = await probeCodexDoctor({ env: { OPENAI_API_KEY: 'sk-x' } });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.authStatus).toBe('ok');
    expect(result.versionStatus).toBe('untested');
  });

  it('emits a single console.warn the first time an untested version is observed (once-per-process)', async () => {
    // Re-import the module in isolation so the module-scoped warning flag
    // is fresh for this test.
    vi.resetModules();
    const { probeCodexDoctor: probe } = await import(
      '../../src/api/codex-doctor-endpoint.js'
    );
    vi.restoreAllMocks();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    execVersion('codex-cli 0.200.0\n');
    await probe({ env: { OPENAI_API_KEY: 'sk-x' } });
    await probe({ env: { OPENAI_API_KEY: 'sk-x' } });
    await probe({ env: { OPENAI_API_KEY: 'sk-x' } });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('0.200.0');
    expect(warnSpy.mock.calls[0]![0]).toContain('#675');

    warnSpy.mockRestore();
  });
});

// #679 — the route GET /api/codex/doctor must sit behind the UI token gate
// (the JSDoc at server.ts:160 already claims it does). startApiServer mounts
// `requireUiToken(config.ui.token)` for every sibling `/api/*` prefix; this
// block proves /api/codex/* is now gated like the others. Unauthenticated GETs
// leaked codex doctor stdout/stderr (which can echo ~/.codex paths) before the
// fix.
describe('GET /api/codex/doctor — UI token gate (#679)', () => {
  const UI_TOKEN = 'ui-token-679';
  let store: Store;
  let server: ApiServer;

  beforeEach(async () => {
    // The codex install probe shells `codex --version`; pin it to a benign
    // "installed/ok" outcome so the authed 200 path resolves fast and stays
    // hermetic (no real binary, no real filesystem).
    execFileMock.mockReturnValue({ type: 'ok', stdout: 'codex 1.2.3\n', stderr: '' });
    store = new Store(':memory:');
    server = await startApiServer({
      port: 0,
      store,
      apiToken: 'api-token',
      ui: { token: UI_TOKEN, handshakeKey: 'handshake-key' },
      codexDoctor: {},
    });
  });

  afterEach(async () => {
    await server?.close();
    store?.close();
  });

  it('rejects an unauthenticated GET with 401 (no cookie, no x-jinn-ui-token header)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/codex/doctor`);
    expect(res.status).toBe(401);
    // §14.3: the gate is now the unconditional `requireOperatorToken`, but
    // when `config.ui` is configured (as it is here) it delegates to
    // `requireUiToken` exclusively — the bearer apiToken does NOT admit on
    // operator-class routes when ui is present (the two credential planes
    // never merge). Error body is unchanged from pre-gate-unification.
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a bearer-only request (no cookie, no x-jinn-ui-token) with 401 — regression for the credential-plane merge finding', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/codex/doctor`, {
      headers: { Authorization: 'Bearer api-token' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('allows a GET carrying a valid x-jinn-ui-token header with 200 and the doctor body', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/codex/doctor`, {
      headers: { 'x-jinn-ui-token': UI_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CodexDoctorBody;
    expect(body.installed).toBe(true);
  });
});
