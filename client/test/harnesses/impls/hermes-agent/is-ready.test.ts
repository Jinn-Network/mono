// client/test/harnesses/impls/hermes-agent/is-ready.test.ts
//
// Regression coverage for #330: HermesHarness must expose isReady() so the
// readiness registry can prevent the claim loop from claiming tasks against
// an uninstalled / mis-configured hermes binary. Pre-fix HermesHarness had
// no isReady; the registry treated it as always-ready and rvx's fresh
// install burned 26 failed claims in minutes.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import {
  probeHermesDoctor,
  probeHermesAuthStatus,
} from '../../../../src/api/hermes-doctor-endpoint.js';

vi.mock('../../../../src/api/hermes-doctor-endpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/api/hermes-doctor-endpoint.js')>();
  return {
    ...actual,
    probeHermesDoctor: vi.fn(),
    probeHermesAuthStatus: vi.fn(),
  };
});

const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };

beforeEach(() => {
  vi.mocked(probeHermesDoctor).mockReset();
  vi.mocked(probeHermesAuthStatus).mockReset();
  // Default: OpenRouter authed so the auth gate passes unless a test
  // overrides it. The doctor-level gates run first regardless.
  vi.mocked(probeHermesAuthStatus).mockReturnValue({
    provider: 'openrouter',
    authed: true,
    raw: 'openrouter: logged in',
  });
});

describe('HermesHarness.isReady', () => {
  it('returns ready=true when doctor reports installed+exit0 AND OpenRouter is authed', async () => {
    vi.mocked(probeHermesDoctor).mockReturnValue({
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
    vi.mocked(probeHermesDoctor).mockReturnValue({
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

  it('returns ready=false with config nextStep when hermes doctor exit != 0', async () => {
    vi.mocked(probeHermesDoctor).mockReturnValue({
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

  // Core regression for the v0.1.6 dogfood finding #3: `hermes doctor` exits 0
  // even when every model provider is logged out. The auth gate must catch
  // that — ready MUST be false even though the doctor probe says exit 0.
  it('returns ready=false when OpenRouter is NOT authed even though hermes doctor exit is 0', async () => {
    vi.mocked(probeHermesDoctor).mockReturnValue({
      installed: true,
      exitCode: 0,
      stdout: 'all checks passed',
      stderr: '',
    });
    vi.mocked(probeHermesAuthStatus).mockReturnValue({
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
    vi.mocked(probeHermesDoctor).mockReturnValue({
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
    vi.mocked(probeHermesDoctor).mockReturnValue({
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
