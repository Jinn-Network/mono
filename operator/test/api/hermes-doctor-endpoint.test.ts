/**
 * @vitest-environment node
 *
 * Unit tests for GET /api/hermes/doctor.
 *
 * Per #778 follow-up the route uses `promisify(execFile)` to run
 * `hermes doctor` / `hermes auth list` — the original `spawnSync` blocked the
 * daemon event loop on every readiness-registry refresh tick. We mock
 * `execFile` via vi.mock so the tests run without a real hermes binary.
 *
 * `execFile`'s callback signature: `(err, stdout, stderr)`. A non-zero exit
 * (or a spawn-error like ENOENT) surfaces as a thrown error whose payload
 * carries `code`, `signal`, `stdout`, `stderr`, etc. — so the mock invokes
 * the trailing callback with the appropriate args.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

interface ExecFileExitOk {
  type: 'ok';
  stdout: string;
  stderr: string;
}
interface ExecFileExitError {
  type: 'error';
  /** Numeric exit code (process ran, exited non-zero) OR string errno (spawn failed). */
  code?: number | string;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  message?: string;
}
type ExecFileOutcome = ExecFileExitOk | ExecFileExitError;

// Mock node:child_process before importing the module under test so vi.mock
// hoisting applies correctly. The production code uses `promisify(execFile)`,
// and `child_process.execFile` ships a `util.promisify.custom` impl that
// resolves to `{stdout, stderr}` (rejecting with the same shape on error).
// We MUST re-attach that custom symbol on the mock — without it,
// `promisify(execFile)` falls back to "resolve with first non-error
// callback arg", which would lose stderr and corrupt the unwrap path.
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<unknown[], unknown>(),
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

const {
  addHermesDoctorRoutes,
  probeHermesAuthStatus,
  probeOpenRouterCredit,
  DEFAULT_OPENROUTER_CREDIT_FLOOR_USD,
} = await import('../../src/api/hermes-doctor-endpoint.js');

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

/** Test-only sugar: pin the next execFile call's outcome. */
function mockNext(outcome: ExecFileOutcome): void {
  execFileMock.mockReturnValueOnce(outcome);
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe('GET /api/hermes/doctor', () => {
  it('returns installed:false when hermes binary is not found (ENOENT)', async () => {
    mockNext({ type: 'error', code: 'ENOENT', message: 'spawn hermes ENOENT' });

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
    mockNext({ type: 'ok', stdout: 'hermes doctor: all checks passed\n', stderr: '' });

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
    mockNext({ type: 'error', code: 1, stdout: '', stderr: diagnosticMsg });

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
    mockNext({ type: 'ok', stdout: '', stderr: '' });

    const app = buildApp({ hermesPath: '/opt/hermes/bin/hermes' });
    await app.request('/api/hermes/doctor');

    expect(execFileMock).toHaveBeenCalledWith(
      '/opt/hermes/bin/hermes',
      ['doctor'],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    );
  });

  it('uses the configured hermesDoctorTimeoutMs', async () => {
    mockNext({ type: 'ok', stdout: '', stderr: '' });

    const app = buildApp({ hermesDoctorTimeoutMs: 5_000 });
    await app.request('/api/hermes/doctor');

    expect(execFileMock).toHaveBeenCalledWith(
      'hermes',
      ['doctor'],
      expect.objectContaining({ timeout: 5_000 }),
      expect.any(Function),
    );
  });

  it('treats EACCES (binary exists but not executable) as installed:true so the panel surfaces a config-issue, not an install prompt', async () => {
    // Realistic scenario: operator did `curl ... | bash` but the script
    // didn't chmod +x the binary. The bare `hermes doctor` invocation fails
    // with EACCES; the file IS on disk.
    mockNext({ type: 'error', code: 'EACCES', message: 'spawn hermes EACCES' });

    const app = buildApp();
    const res = await app.request('/api/hermes/doctor');
    const body = (await res.json()) as HermesDoctorBody;

    expect(body.installed).toBe(true);
    expect(body.exitCode).toBeNull();
  });

  it('treats execFile timeout as installed:true with exitCode null (config-issue, not missing binary)', async () => {
    // Node's execFile kills the child by SIGTERM on timeout and rejects with
    // a `killed: true` error. The binary did execute, it just didn't finish —
    // so installed must be true, not false.
    mockNext({
      type: 'error',
      code: 'ETIMEDOUT',
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      message: 'ETIMEDOUT',
    });

    const app = buildApp();
    const res = await app.request('/api/hermes/doctor');
    const body = (await res.json()) as HermesDoctorBody;

    expect(body.installed).toBe(true);
    expect(body.exitCode).toBeNull();
  });

  it('truncates stdout and stderr to 4000 characters', async () => {
    const longOutput = 'x'.repeat(5000);
    mockNext({ type: 'ok', stdout: longOutput, stderr: longOutput });

    const app = buildApp();
    const res = await app.request('/api/hermes/doctor');
    const body = (await res.json()) as HermesDoctorBody;

    expect(body.stdout).toHaveLength(4000);
    expect(body.stderr).toHaveLength(4000);
  });
});

describe('probeHermesAuthStatus', () => {
  // The probe runs `hermes auth list <provider>` and parses the credential
  // pool. CRITICAL: `auth list` (unlike `auth status`) sees API-key
  // credentials, not just interactive-OAuth sessions — so an operator
  // authenticated via `OPENROUTER_API_KEY` is correctly reported as authed.

  it('reports authed for a healthy api_key credential (the OPENROUTER_API_KEY setup)', async () => {
    // Verbatim shape of `hermes auth list openrouter` for an env-var api_key
    // credential — the case `auth status` wrongly calls "logged out".
    mockNext({
      type: 'ok',
      stdout:
        'openrouter (1 credentials):\n' +
        '  #1  OPENROUTER_API_KEY   api_key env:OPENROUTER_API_KEY ←\n\n',
      stderr: '',
    });

    const result = await probeHermesAuthStatus('openrouter');
    expect(result.provider).toBe('openrouter');
    expect(result.authed).toBe(true);
    expect(result.raw).toContain('api_key');
  });

  it('reports authed for a healthy oauth credential', async () => {
    mockNext({
      type: 'ok',
      stdout:
        'openrouter (1 credentials):\n' +
        '  #1  user@example.com   oauth   openrouter_pkce ←\n\n',
      stderr: '',
    });

    const result = await probeHermesAuthStatus('openrouter');
    expect(result.authed).toBe(true);
  });

  it('reports not-authed when the credential pool is empty (no provider section printed)', async () => {
    // `auth_list_command` skips a provider with zero pooled credentials, so
    // stdout is empty even though exit code is 0.
    mockNext({ type: 'ok', stdout: '', stderr: '' });

    const result = await probeHermesAuthStatus('openrouter');
    expect(result.authed).toBe(false);
  });

  it('reports not-authed when the only credential is exhausted with a wait window still open', async () => {
    mockNext({
      type: 'ok',
      stdout:
        'openrouter (1 credentials):\n' +
        '  #1  OPENROUTER_API_KEY   api_key env:OPENROUTER_API_KEY rate-limited (429) (12m 3s left) ←\n\n',
      stderr: '',
    });

    const result = await probeHermesAuthStatus('openrouter');
    expect(result.authed).toBe(false);
  });

  it('reports not-authed when the only credential is a hard auth failure', async () => {
    mockNext({
      type: 'ok',
      stdout:
        'openrouter (1 credentials):\n' +
        '  #1  OPENROUTER_API_KEY   api_key env:OPENROUTER_API_KEY auth failed (401) (re-auth may be required) ←\n\n',
      stderr: '',
    });

    const result = await probeHermesAuthStatus('openrouter');
    expect(result.authed).toBe(false);
  });

  it('reports authed when an exhausted credential has reached its retry window', async () => {
    // `(ready to retry)` means the exhaustion window elapsed — usable again.
    mockNext({
      type: 'ok',
      stdout:
        'openrouter (1 credentials):\n' +
        '  #1  OPENROUTER_API_KEY   api_key env:OPENROUTER_API_KEY rate-limited (429) (ready to retry) ←\n\n',
      stderr: '',
    });

    const result = await probeHermesAuthStatus('openrouter');
    expect(result.authed).toBe(true);
  });

  it('reports authed when at least one of several credentials is usable', async () => {
    mockNext({
      type: 'ok',
      stdout:
        'openrouter (2 credentials):\n' +
        '  #1  key-one   api_key env:OPENROUTER_API_KEY rate-limited (429) (5m 0s left)\n' +
        '  #2  key-two   api_key manual ←\n\n',
      stderr: '',
    });

    const result = await probeHermesAuthStatus('openrouter');
    expect(result.authed).toBe(true);
  });

  it('reports not-authed gracefully when the hermes binary is not found (ENOENT)', async () => {
    mockNext({ type: 'error', code: 'ENOENT', message: 'spawn hermes ENOENT' });

    const result = await probeHermesAuthStatus('openrouter');
    expect(result.authed).toBe(false);
    expect(result.raw).toBe('');
  });

  it('reports not-authed when execFile errors (e.g. timeout) regardless of stdout', async () => {
    mockNext({
      type: 'error',
      code: 'ETIMEDOUT',
      signal: 'SIGTERM',
      stdout: 'openrouter (1 credentials):\n  #1  key   api_key manual ←\n',
      stderr: '',
      message: 'ETIMEDOUT',
    });

    const result = await probeHermesAuthStatus('openrouter');
    expect(result.authed).toBe(false);
  });

  it('invokes `hermes auth list <provider>` with the configured binary and timeout', async () => {
    mockNext({
      type: 'ok',
      stdout: 'openrouter (1 credentials):\n  #1  key   api_key manual ←\n',
      stderr: '',
    });

    await probeHermesAuthStatus('openrouter', {
      hermesPath: '/opt/hermes/bin/hermes',
      hermesDoctorTimeoutMs: 5_000,
    });

    expect(execFileMock).toHaveBeenCalledWith(
      '/opt/hermes/bin/hermes',
      ['auth', 'list', 'openrouter'],
      expect.objectContaining({ timeout: 5_000, encoding: 'utf8' }),
      expect.any(Function),
    );
  });
});

// `probeOpenRouterCredit` is the fourth readiness gate's primitive — it hits
// `GET https://openrouter.ai/api/v1/key` to ask whether the operator's
// credential has spendable credit above a per-task floor (production bug,
// 2026-05-23: 12 claims burned on HTTP 402 because the previous three gates
// could not see balance, only presence). The tests below mock `fetch` and
// pin the verdict for each branch — including the fail-safe path that
// protects the operator pool from a transient OpenRouter outage.
describe('probeOpenRouterCredit', () => {
  function mockResponse(opts: {
    ok?: boolean;
    status?: number;
    body?: unknown;
    bodyText?: string;
    bodyRejects?: Error;
    textRejects?: Error;
  }): Response {
    const ok = opts.ok ?? true;
    const status = opts.status ?? (ok ? 200 : 500);
    return {
      ok,
      status,
      json: async () => {
        if (opts.bodyRejects) throw opts.bodyRejects;
        return opts.body;
      },
      text: async () => {
        if (opts.textRejects) throw opts.textRejects;
        return opts.bodyText ?? JSON.stringify(opts.body ?? {});
      },
    } as unknown as Response;
  }

  it('returns state=ok when remaining credit is at or above the floor', async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse({ body: { data: { limit: 10, usage: 5 } } }),
    );
    const result = await probeOpenRouterCredit({
      apiKey: 'sk-or-test',
      floorUsd: 0.5,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe('ok');
    expect(result.remainingUsd).toBeCloseTo(5);
    expect(result.limitUsd).toBe(10);
    expect(result.usageUsd).toBe(5);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/key',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer sk-or-test' },
      }),
    );
  });

  it('returns state=exhausted when remaining credit is below the floor', async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse({ body: { data: { limit: 5, usage: 4.98 } } }),
    );
    const result = await probeOpenRouterCredit({
      apiKey: 'sk-or-test',
      floorUsd: 0.5,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe('exhausted');
    expect(result.remainingUsd).toBeCloseTo(0.02);
    expect(result.floorUsd).toBe(0.5);
  });

  it('returns state=ok when the key has no spend cap (limit=null → unlimited)', async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse({ body: { data: { limit: null, usage: 100 } } }),
    );
    const result = await probeOpenRouterCredit({
      apiKey: 'sk-or-test',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe('ok');
    expect(result.limitUsd).toBeNull();
  });

  it('is fail-safe (state=unknown) on non-200 responses', async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse({ ok: false, status: 503, bodyText: 'cf 503' }),
    );
    const result = await probeOpenRouterCredit({
      apiKey: 'sk-or-test',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe('unknown');
    expect(result.reason).toMatch(/503/);
  });

  it('is fail-safe (state=unknown) on network errors', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('fetch failed: ETIMEDOUT');
    });
    const result = await probeOpenRouterCredit({
      apiKey: 'sk-or-test',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe('unknown');
    expect(result.reason).toMatch(/ETIMEDOUT/);
  });

  it('is fail-safe (state=unknown) on malformed JSON bodies', async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse({ body: { not: 'the expected shape' } }),
    );
    const result = await probeOpenRouterCredit({
      apiKey: 'sk-or-test',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe('unknown');
  });

  it('is fail-safe (state=unknown) when no API key is supplied', async () => {
    const fetchFn = vi.fn();
    const result = await probeOpenRouterCredit({
      apiKey: '',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe('unknown');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses the default per-task credit floor when none is supplied', async () => {
    // Pin the floor to the exported constant (it is sized for cheap routed
    // models like deepseek/deepseek-v4-flash — typical solve ~$0.01-0.02 —
    // so the body's `remaining` is set well below the constant to force
    // `exhausted` regardless of any future floor tune.
    const remaining = Math.max(0, DEFAULT_OPENROUTER_CREDIT_FLOOR_USD - 0.001);
    const fetchFn = vi.fn(async () =>
      mockResponse({ body: { data: { limit: 1, usage: 1 - remaining } } }),
    );
    const result = await probeOpenRouterCredit({
      apiKey: 'sk-or-test',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.floorUsd).toBe(DEFAULT_OPENROUTER_CREDIT_FLOOR_USD);
    expect(result.state).toBe('exhausted');
  });

  it('prefers data.limit_remaining over limit - usage (resetting-key correctness)', async () => {
    // A monthly-resetting key whose all-time `usage` is large but whose
    // CURRENT period remaining (`limit_remaining`) is healthy. Computing
    // remaining as `limit - usage` would falsely report `exhausted`; the
    // authoritative `limit_remaining` field should win.
    const fetchFn = vi.fn(async () =>
      mockResponse({
        body: { data: { limit: 20, usage: 19.41, limit_remaining: 12.5 } },
      }),
    );
    const result = await probeOpenRouterCredit({
      apiKey: 'sk-or-test',
      floorUsd: 0.5,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe('ok');
    expect(result.remainingUsd).toBe(12.5);
  });

  it('returns state=unknown when data.limit is absent (API schema drift guard)', async () => {
    // `limit === null` is "unlimited key" (handled separately as ok); but
    // `limit === undefined` means the field was missing from the response
    // body entirely — ambiguous, possibly a future API shape change.
    // Returning `unknown` keeps readiness fail-safe AND preserves a
    // diagnostic signal rather than silently passing.
    const fetchFn = vi.fn(async () =>
      mockResponse({ body: { data: { usage: 5 /* no `limit` field */ } } }),
    );
    const result = await probeOpenRouterCredit({
      apiKey: 'sk-or-test',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe('unknown');
    expect(result.reason).toMatch(/missing.*limit/);
  });
});
