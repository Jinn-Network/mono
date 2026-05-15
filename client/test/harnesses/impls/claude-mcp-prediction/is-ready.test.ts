import { describe, expect, it, vi } from 'vitest';
import { probeClaudeAuth } from '../../../../src/preflight/claude-auth.js';
import { ClaudeMcpPredictionImpl } from '../../../../src/harnesses/impls/claude-mcp-prediction/index.js';

vi.mock('../../../../src/preflight/claude-auth.js', () => ({
  probeClaudeAuth: vi.fn(),
}));

describe('ClaudeMcpPredictionImpl.isReady', () => {
  it('returns ready=true when claude auth status reports logged in', async () => {
    vi.mocked(probeClaudeAuth).mockReturnValue({
      authenticated: true,
      context: 'bare',
      detail: 'logged in as test@example.com',
      email: 'test@example.com',
    });
    const harness = new ClaudeMcpPredictionImpl();
    const result = await harness.isReady!({ solverType: 'prediction.v1', role: 'restoration' });
    expect(result.ready).toBe(true);
  });

  it('returns ready=false with sign-in nextStep when not authenticated', async () => {
    vi.mocked(probeClaudeAuth).mockReturnValue({
      authenticated: false,
      context: 'bare',
      detail: 'not logged in',
    });
    const harness = new ClaudeMcpPredictionImpl();
    const result = await harness.isReady!({ solverType: 'prediction.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('not logged in');
    expect(result.nextStep?.description).toMatch(/sign in/i);
    expect(result.nextStep?.url).toBe('/v1/auth/claude/spawn');
  });

  it('returns ready=false when claude binary is missing', async () => {
    vi.mocked(probeClaudeAuth).mockReturnValue({
      authenticated: false,
      context: 'bare',
      detail: 'claude binary claude not found on PATH',
    });
    const harness = new ClaudeMcpPredictionImpl();
    const result = await harness.isReady!({ solverType: 'prediction.v1', role: 'restoration' });
    expect(result.ready).toBe(false);
    expect(result.nextStep?.url).toBe('/v1/setup/claude/install');
  });
});
