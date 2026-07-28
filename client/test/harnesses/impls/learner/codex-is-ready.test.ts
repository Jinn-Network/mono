// client/test/harnesses/impls/learner/codex-is-ready.test.ts
//
// Regression coverage for #348 (same-shape bug as #330): a `LearnerHarness`
// constructed with `name === CODEX_HARNESS` MUST probe the codex CLI in
// `isReady()`, not the claude CLI. Pre-fix the Codex variant delegated to
// `buildClaudeIsReady`, so a Codex-harness SolverNet looked always-ready
// even with no `codex` install — operators selecting Codex on a fresh
// machine hit the same N/N failed-claim cascade #330 described.
import { describe, expect, it, vi } from 'vitest';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/index.js';
import { CODEX_HARNESS } from '../../../../src/harnesses/names.js';
import { probeCodexDoctor } from '../../../../src/api/codex-doctor-endpoint.js';
import type {
  HarnessAdapter,
  TaskSessionInputs,
} from '../../../../src/harnesses/impls/learner/types.js';

vi.mock('../../../../src/api/codex-doctor-endpoint.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/api/codex-doctor-endpoint.js')>();
  return {
    ...actual,
    probeCodexDoctor: vi.fn(),
  };
});

/** Minimal no-op adapter to satisfy the required `adapter` field. */
class NoOpAdapter implements HarnessAdapter {
  readonly name = 'noop';
  readonly allowsHarnessSelfModification = false;
  async runTask(_inputs: TaskSessionInputs): Promise<void> {}
}

describe('LearnerHarness.isReady — Codex variant (#348)', () => {
  it('returns ready=true for a live ChatGPT OAuth session', async () => {
    vi.mocked(probeCodexDoctor).mockResolvedValue({
      installed: true,
      authenticated: true,
      authStatus: 'ok',
      credentialMode: 'chatgpt-oauth',
      exitCode: 0,
      stdout: 'codex 1.2.3',
      stderr: '',
      cliVersion: '1.2.3',
      versionStatus: 'untested',
    });
    const harness = new LearnerHarness({ name: CODEX_HARNESS, adapter: new NoOpAdapter() });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(true);
    expect(probeCodexDoctor).toHaveBeenCalled();
  });

  it('returns ready=true for generic Codex API-key mode', async () => {
    vi.mocked(probeCodexDoctor).mockResolvedValue({
      installed: true,
      authenticated: true,
      authStatus: 'ok',
      credentialMode: 'api-key',
      exitCode: 0,
      stdout: 'codex 1.2.3',
      stderr: '',
      cliVersion: '1.2.3',
      versionStatus: 'untested',
    });
    const harness = new LearnerHarness({ name: CODEX_HARNESS, adapter: new NoOpAdapter() });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(true);
  });

  it('returns ready=false with install nextStep when codex binary missing', async () => {
    vi.mocked(probeCodexDoctor).mockResolvedValue({
      installed: false,
      authenticated: false,
      authStatus: 'not_configured',
      credentialMode: 'not-configured',
      exitCode: null,
      stdout: '',
      stderr: '',
      cliVersion: null,
      versionStatus: 'unknown',
    });
    const harness = new LearnerHarness({ name: CODEX_HARNESS, adapter: new NoOpAdapter() });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/not installed/i);
    expect(result.nextStep?.description).toMatch(/install/i);
    expect(result.nextStep?.url).toBe('/api/codex/doctor');
  });

  it('returns ready=false with sign-in nextStep when codex auth not configured', async () => {
    vi.mocked(probeCodexDoctor).mockResolvedValue({
      installed: true,
      authenticated: false,
      authStatus: 'not_configured',
      credentialMode: 'not-configured',
      exitCode: 0,
      stdout: 'codex 1.2.3',
      stderr: '',
      cliVersion: '1.2.3',
      versionStatus: 'untested',
    });
    const harness = new LearnerHarness({ name: CODEX_HARNESS, adapter: new NoOpAdapter() });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
    expect(result.nextStep?.description).toMatch(/sign in|OPENAI_API_KEY|codex login/i);
  });

  // #366: a stale/expired auth.json must not read as ready. The reason MUST
  // be distinct from the not-configured case so the operator sees a
  // re-login hint rather than a first-time sign-in hint.
  it('returns ready=false with a distinct re-login reason when codex auth is expired', async () => {
    vi.mocked(probeCodexDoctor).mockResolvedValue({
      installed: true,
      authenticated: false,
      authStatus: 'expired',
      credentialMode: 'invalid',
      exitCode: 0,
      stdout: 'codex 1.2.3',
      stderr: '',
      cliVersion: '1.2.3',
      versionStatus: 'untested',
    });
    const harness = new LearnerHarness({ name: CODEX_HARNESS, adapter: new NoOpAdapter() });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/expired/i);
    // Distinct from the not-configured reason.
    expect(result.reason).not.toMatch(/not configured/i);
    expect(result.nextStep?.description).toMatch(/codex login|expired/i);
    expect(result.nextStep?.url).toBe('/api/codex/doctor');
  });
});
