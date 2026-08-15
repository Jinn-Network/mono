// operator/test/harnesses/impls/hermes-agent/is-ready.test.ts
//
// Regression coverage: HermesHarness must expose isReady() so the readiness
// registry can prevent the claim loop from claiming tasks against an
// uninstalled / mis-configured hermes binary. Without isReady the registry
// treats the harness as always-ready and a fresh install burns failed claims.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import {
  probeHermesDoctor,
  probeHermesAuthStatus,
  probeOpenRouterCredit,
  DEFAULT_OPENROUTER_CREDIT_FLOOR_USD,
  type OpenRouterCreditStatus,
} from '../../../../src/api/hermes-doctor-endpoint.js';

// `node:child_process` is stubbed so the real `probeHermesAuthStatus` (used
// by the regression block below) can run against synthetic `hermes auth
// list` output without a hermes binary. `authListStdout` is the stdout the
// next `execFile(['auth','list',...])` call returns.
//
// Per #778 follow-up, the probes now use `promisify(execFile)`, so we mock
// the callback-style `execFile` rather than `spawnSync`. We MUST re-attach
// `util.promisify.custom` so the promisified call resolves with the
// `{stdout, stderr}` shape that the real `child_process.execFile` carries —
// without it, the production unwrap path receives a bare stdout string.
const { authListState } = vi.hoisted(() => ({
  authListState: { stdout: '' },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify: promisifyImpl } = await import('node:util');

  function mockedExecFile(
    _bin: string,
    args: readonly string[],
    ..._rest: unknown[]
  ): unknown {
    const callback = _rest.find((arg) => typeof arg === 'function') as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    if (callback) {
      if (args[0] === 'auth' && args[1] === 'list') {
        callback(null, authListState.stdout, '');
      } else {
        callback(null, '', '');
      }
    }
    return { stdin: null, kill: () => {} };
  }

  (mockedExecFile as unknown as { [k: symbol]: unknown })[promisifyImpl.custom] = (
    file: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mockedExecFile(file, args, options ?? {}, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

  return {
    ...actual,
    execFile: mockedExecFile,
  };
});

// The real endpoint module — the regression block swaps the mocked
// `probeHermesAuthStatus` for this genuine implementation to get end-to-end
// parsing coverage. The doctor-gate tests keep the mock.
const actualHermesDoctorEndpoint = await vi.importActual<
  typeof import('../../../../src/api/hermes-doctor-endpoint.js')
>('../../../../src/api/hermes-doctor-endpoint.js');

vi.mock('../../../../src/api/hermes-doctor-endpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/api/hermes-doctor-endpoint.js')>();
  return {
    ...actual,
    probeHermesDoctor: vi.fn(),
    probeHermesAuthStatus: vi.fn(),
    probeOpenRouterCredit: vi.fn(),
  };
});

const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };

beforeEach(() => {
  vi.mocked(probeHermesDoctor).mockReset();
  vi.mocked(probeHermesAuthStatus).mockReset();
  vi.mocked(probeOpenRouterCredit).mockReset();
  // Default: OpenRouter authed so the auth gate passes unless a test
  // overrides it. The doctor-level gates run first regardless.
  vi.mocked(probeHermesAuthStatus).mockResolvedValue({
    provider: 'openrouter',
    authed: true,
    raw: 'openrouter: logged in',
  });
  // Default: credit probe reports ok so the credit gate passes unless a
  // test overrides it.
  vi.mocked(probeOpenRouterCredit).mockResolvedValue({
    state: 'ok',
    floorUsd: DEFAULT_OPENROUTER_CREDIT_FLOOR_USD,
    remainingUsd: 5.0,
    limitUsd: 10,
    usageUsd: 5.0,
  });
});

describe('HermesHarness.isReady', () => {
  it('returns ready=true when doctor reports installed+exit0 AND OpenRouter is authed', async () => {
    vi.mocked(probeHermesDoctor).mockResolvedValue({
      installed: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(true);
  });

  it('returns ready=false with install nextStep when hermes binary missing', async () => {
    vi.mocked(probeHermesDoctor).mockResolvedValue({
      installed: false,
      exitCode: null,
      stdout: '',
      stderr: '',
    });
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/not installed/i);
    expect(result.nextStep?.description).toMatch(/install/i);
  });

  it('uses a local OpenAI-compatible provider instead of OpenRouter gates when hermesBaseUrl is configured', async () => {
    vi.mocked(probeHermesDoctor).mockReturnValue({
      installed: true,
      exitCode: 1,
      stdout: '',
      stderr: 'no OpenRouter provider configured',
    });
    const providerFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const h = new HermesHarness({
      adapter: fakeAdapter as any,
      hermesBaseUrl: 'http://127.0.0.1:11434/v1',
      hermesProviderFetch: providerFetch as typeof fetch,
    });

    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });

    expect(result.ready).toBe(true);
    expect(providerFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer jinn-local' },
      }),
    );
    expect(probeHermesAuthStatus).not.toHaveBeenCalled();
    expect(probeOpenRouterCredit).not.toHaveBeenCalled();
  });

  it('reports not-ready when the configured local provider does not answer /models', async () => {
    vi.mocked(probeHermesDoctor).mockReturnValue({
      installed: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    const providerFetch = vi.fn(async () => new Response('missing', { status: 404 }));
    const h = new HermesHarness({
      adapter: fakeAdapter as any,
      hermesBaseUrl: 'http://127.0.0.1:11434/v1',
      hermesProviderFetch: providerFetch as typeof fetch,
    });

    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });

    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/\/models returned HTTP 404/i);
    expect(probeHermesAuthStatus).not.toHaveBeenCalled();
    expect(probeOpenRouterCredit).not.toHaveBeenCalled();
  });

  it('rejects non-local hermesBaseUrl before probing provider auth', async () => {
    vi.mocked(probeHermesDoctor).mockReturnValue({
      installed: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    const providerFetch = vi.fn();
    const h = new HermesHarness({
      adapter: fakeAdapter as any,
      hermesBaseUrl: 'https://api.openai.com/v1',
      hermesProviderFetch: providerFetch as typeof fetch,
    });

    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });

    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/base URL must be local/i);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(probeHermesAuthStatus).not.toHaveBeenCalled();
    expect(probeOpenRouterCredit).not.toHaveBeenCalled();
  });

  it('returns ready=false with config nextStep when hermes doctor exit != 0', async () => {
    vi.mocked(probeHermesDoctor).mockResolvedValue({
      installed: true,
      exitCode: 1,
      stdout: '',
      stderr: 'no provider configured',
    });
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/doctor/i);
    expect(result.nextStep?.description).toMatch(/sign in|configure|hermes/i);
  });

  // `hermes doctor` exits 0 even when every model provider is logged out. The
  // auth gate must catch that — ready MUST be false even though the doctor
  // probe says exit 0.
  it('returns ready=false when OpenRouter is NOT authed even though hermes doctor exit is 0', async () => {
    vi.mocked(probeHermesDoctor).mockResolvedValue({
      installed: true,
      exitCode: 0,
      stdout: 'all checks passed',
      stderr: '',
    });
    vi.mocked(probeHermesAuthStatus).mockResolvedValue({
      provider: 'openrouter',
      authed: false,
      raw: 'openrouter: logged out',
    });
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/openrouter/i);
    expect(result.reason).toMatch(/no usable model provider/i);
    expect(result.nextStep?.description).toMatch(/openrouter|hermes login/i);
  });

  it('probes OpenRouter auth specifically', async () => {
    vi.mocked(probeHermesDoctor).mockResolvedValue({
      installed: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(probeHermesAuthStatus).toHaveBeenCalledWith('openrouter', expect.anything());
  });

  it('does not reach the auth gate when the binary is missing', async () => {
    vi.mocked(probeHermesDoctor).mockResolvedValue({
      installed: false,
      exitCode: null,
      stdout: '',
      stderr: '',
    });
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(probeHermesAuthStatus).not.toHaveBeenCalled();
  });
});

// Regression: the auth gate previously probed `hermes auth status`, which
// only reflects interactive-OAuth-login state and reports "logged out" even
// when a working API-key credential is present. Any operator authenticated
// to OpenRouter via `OPENROUTER_API_KEY` (the normal setup) had its
// hermes-agent harness wrongly gated out of every claim. The probe now reads
// the credential pool via `hermes auth list`. These tests exercise the REAL
// `probeHermesAuthStatus` (mock removed for the auth gate) against verbatim
// `auth list` stdout — so the harness ready verdict is end-to-end coverage.
describe('HermesHarness.isReady — credential-pool auth gate (regression)', () => {
  beforeEach(() => {
    // Run the genuine probe for these tests; only `node:child_process` is
    // stubbed (see authListSpawnSync below). The doctor gate stays mocked.
    vi.mocked(probeHermesAuthStatus).mockImplementation((provider, cfg) =>
      actualHermesDoctorEndpoint.probeHermesAuthStatus(provider, cfg),
    );
    vi.mocked(probeHermesDoctor).mockResolvedValue({
      installed: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    // Keep the credit gate green for these auth-pool regression cases — the
    // gate under test here is the third (auth-list), not the fourth (credit).
    vi.mocked(probeOpenRouterCredit).mockResolvedValue({
      state: 'ok',
      floorUsd: DEFAULT_OPENROUTER_CREDIT_FLOOR_USD,
      remainingUsd: 5.0,
      limitUsd: 10,
      usageUsd: 5.0,
    });
  });

  it('is ready when OpenRouter has a healthy api_key credential in the pool', async () => {
    // Verbatim `hermes auth list openrouter` stdout for an env-var api_key
    // credential — exactly the output `auth status` calls "logged out".
    authListState.stdout =
      'openrouter (1 credentials):\n' +
      '  #1  OPENROUTER_API_KEY   api_key env:OPENROUTER_API_KEY ←\n\n';
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(true);
  });

  it('is not ready when OpenRouter has no credential in the pool', async () => {
    // `hermes auth list openrouter` prints nothing when the credential pool
    // has no entry for the provider.
    authListState.stdout = '';
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/openrouter/i);
    expect(result.nextStep?.description).toMatch(/openrouter|hermes login/i);
  });

  // #532 explicit: a credential is *present* in the pool but the provider
  // hard-rejected it (`auth failed (401) (re-auth may be required)`). This is
  // the "invalid key" half of the acceptance criterion — distinct from the
  // empty-pool case above. It must reach not-ready through the full isReady()
  // stack, not just the unit-level probe, so the gate cannot be regressed by
  // wiring changes upstream of the parse.
  it('is not ready when the only OpenRouter credential is a hard auth failure (invalid key)', async () => {
    authListState.stdout =
      'openrouter (1 credentials):\n' +
      '  #1  OPENROUTER_API_KEY   api_key env:OPENROUTER_API_KEY auth failed (401) (re-auth may be required) ←\n\n';
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/openrouter/i);
    expect(result.nextStep?.description).toMatch(/openrouter|hermes login/i);
  });
});

// Production bug, 2026-05-23: every Hermes solve attempt for the day
// returned HTTP 402 from OpenRouter ("This request requires more credits,
// or fewer max_tokens. You requested up to 64000 tokens, but can only
// afford 52975.") while readiness reported ready=true — the harness
// silently burned 12 claims. The fourth readiness gate probes OpenRouter's
// `/api/v1/key` for spendable credit; tests below pin its behavior.
describe('HermesHarness.isReady — OpenRouter credit gate (production bug 2026-05-23)', () => {
  beforeEach(() => {
    vi.mocked(probeHermesDoctor).mockResolvedValue({
      installed: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    // auth-list gate already passes by default via the top-level beforeEach.
  });

  it('reports ready=true when the OpenRouter balance is at or above the floor', async () => {
    vi.mocked(probeOpenRouterCredit).mockResolvedValue({
      state: 'ok',
      floorUsd: 0.5,
      remainingUsd: 4.25,
      limitUsd: 10,
      usageUsd: 5.75,
    } satisfies OpenRouterCreditStatus);
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(true);
  });

  it('reports ready=false with an actionable top-up nextStep when the balance is below the floor', async () => {
    vi.mocked(probeOpenRouterCredit).mockResolvedValue({
      state: 'exhausted',
      floorUsd: 0.5,
      remainingUsd: 0.02,
      limitUsd: 10,
      usageUsd: 9.98,
    } satisfies OpenRouterCreditStatus);
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/credit insufficient/i);
    expect(result.reason).toMatch(/openrouter/i);
    expect(result.nextStep?.description).toMatch(/top up|openrouter/i);
    expect(result.nextStep?.url).toBe('https://openrouter.ai/credits');
  });

  it('is fail-safe: reports ready=true when the credit probe state is unknown (network error / non-200)', async () => {
    // The inverse false-negative is worse than the original bug — a transient
    // OpenRouter outage must NOT shut every operator down. Only a clearly-
    // confirmed exhausted state flips ready=false.
    vi.mocked(probeOpenRouterCredit).mockResolvedValue({
      state: 'unknown',
      floorUsd: 0.5,
      reason: 'fetch failed: ETIMEDOUT',
    } satisfies OpenRouterCreditStatus);
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    const result = await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(true);
  });

  it('threads the configured per-task floor through to the probe', async () => {
    vi.mocked(probeOpenRouterCredit).mockResolvedValue({
      state: 'ok',
      floorUsd: 2.0,
      remainingUsd: 3.0,
      limitUsd: 10,
      usageUsd: 7.0,
    } satisfies OpenRouterCreditStatus);
    const h = new HermesHarness({
      adapter: fakeAdapter as any,
      openrouterCreditFloorUsd: 2.0,
    });
    await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(probeOpenRouterCredit).toHaveBeenCalledWith(expect.objectContaining({ floorUsd: 2.0 }));
  });

  it('does not reach the credit gate when the binary is missing', async () => {
    vi.mocked(probeHermesDoctor).mockResolvedValue({
      installed: false,
      exitCode: null,
      stdout: '',
      stderr: '',
    });
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(probeOpenRouterCredit).not.toHaveBeenCalled();
  });

  it('does not reach the credit gate when OpenRouter has no credential in the pool', async () => {
    vi.mocked(probeHermesAuthStatus).mockResolvedValue({
      provider: 'openrouter',
      authed: false,
      raw: 'openrouter: logged out',
    });
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    await h.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(probeOpenRouterCredit).not.toHaveBeenCalled();
  });
});
