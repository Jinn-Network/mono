// client/test/harnesses/impls/hermes-agent/is-ready.test.ts
//
// Regression coverage for #330: HermesHarness must expose isReady() so the
// readiness registry can prevent the claim loop from claiming tasks against
// an uninstalled / mis-configured hermes binary. Pre-fix HermesHarness had
// no isReady; the registry treated it as always-ready and rvx's fresh
// install burned 26 failed claims in minutes.
import { describe, expect, it, vi } from 'vitest';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import { probeHermesDoctor } from '../../../../src/api/hermes-doctor-endpoint.js';

vi.mock('../../../../src/api/hermes-doctor-endpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/api/hermes-doctor-endpoint.js')>();
  return {
    ...actual,
    probeHermesDoctor: vi.fn(),
  };
});

const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };

describe('HermesHarness.isReady', () => {
  it('returns ready=true when probeHermesDoctor reports installed and exit 0', async () => {
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
});
