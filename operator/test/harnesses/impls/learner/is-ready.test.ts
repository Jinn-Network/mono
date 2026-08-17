import { describe, expect, it, vi } from 'vitest';
import { probeClaudeAuth } from '../../../../src/preflight/claude-auth.js';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/index.js';
import type { HarnessAdapter, TaskSessionInputs } from '../../../../src/harnesses/impls/learner/types.js';

vi.mock('../../../../src/preflight/claude-auth.js', () => {
  const probeClaudeAuth = vi.fn();
  return {
    probeClaudeAuth,
    CLAUDE_INSTALL_URL: '/v1/setup/claude/install',
    CLAUDE_AUTH_LOGIN_CLI: 'claude auth login',
    buildClaudeIsReady:
      (opts: { getClaudePath: () => string; getContext: () => string }) =>
      async (_ctx?: unknown) => {
        const result = probeClaudeAuth({
          context: opts.getContext(),
          cwd: process.cwd(),
          claudePath: opts.getClaudePath(),
        });
        if (result.authenticated) return { ready: true as const, reason: result.detail };
        const binaryMissing = (result.detail as string).includes('not found on PATH');
        return {
          ready: false as const,
          reason: result.detail,
          nextStep: binaryMissing
            ? { description: 'Install Claude Code from the operator app', url: '/v1/setup/claude/install' }
            : { description: 'Sign in with the Claude Code CLI', cli: 'claude auth login' },
        };
      },
  };
});

/** Minimal no-op adapter to satisfy the required `adapter` field. */
class NoOpAdapter implements HarnessAdapter {
  readonly name = 'noop';
  readonly allowsHarnessSelfModification = false;
  async runTask(_inputs: TaskSessionInputs): Promise<void> {}
}

describe('LearnerHarness.isReady', () => {
  it('returns ready=true when claude auth status reports logged in', async () => {
    vi.mocked(probeClaudeAuth).mockReturnValue({
      authenticated: true,
      context: 'bare',
      detail: 'logged in as test@example.com',
      email: 'test@example.com',
    });
    const harness = new LearnerHarness({ adapter: new NoOpAdapter() });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2', role: 'restoration' });
    expect(result.ready).toBe(true);
  });

  it('returns ready=false with sign-in nextStep when not authenticated', async () => {
    vi.mocked(probeClaudeAuth).mockReturnValue({
      authenticated: false,
      context: 'bare',
      detail: 'not logged in',
    });
    const harness = new LearnerHarness({ adapter: new NoOpAdapter() });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('not logged in');
    expect(result.nextStep?.description).toMatch(/sign in/i);
    expect(result.nextStep?.cli).toBe('claude auth login');
  });

  it('returns ready=false when claude binary is missing', async () => {
    vi.mocked(probeClaudeAuth).mockReturnValue({
      authenticated: false,
      context: 'bare',
      detail: 'claude binary claude not found on PATH',
    });
    const harness = new LearnerHarness({ adapter: new NoOpAdapter() });
    const result = await harness.isReady!({ solverType: 'swe-rebench-v2', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.nextStep?.url).toBe('/v1/setup/claude/install');
  });
});
