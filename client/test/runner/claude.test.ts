import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPrompt } from '../../src/runner/claude.js';
import { TrajectoryCollector } from '../../src/trajectory/collector.js';

// ── Module mock for tracedSpawn ────────────────────────────────────────────────
// We mock the trajectory index to intercept tracedSpawn calls without
// spawning a real Claude binary.
vi.mock('../../src/trajectory/index.js', () => ({
  tracedSpawn: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

describe('Claude runner', () => {
  it('builds a prompt from a desired state', () => {
    const prompt = buildPrompt({
      id: 'ds-1',
      description: 'The API should return 200 on /health',
      context: { endpoint: 'https://api.example.com/health' },
    });

    expect(prompt).toContain('The API should return 200 on /health');
    expect(prompt).toContain('desired state');
  });
});

describe('ClaudeRunner — tracedSpawn integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls tracedSpawn when trajectory is in RunnerContext', async () => {
    // Import after mock is set up
    const { tracedSpawn } = await import('../../src/trajectory/index.js');
    const { ClaudeRunner } = await import('../../src/runner/claude.js');

    const collector = new TrajectoryCollector({ intentCid: 'bafy', runId: 'runner-test-1' });
    const runner = new ClaudeRunner({ claudePath: 'claude', model: 'test-model' });

    // Minimal job
    const job = {
      id: 'job-1',
      description: 'Test job',
    };

    // Context with trajectory — tracedSpawn path
    const context = {
      requestId: 'req-1' as unknown as import('../../src/types/index.js').RequestId,
      workingDirectory: '/tmp/test',
      timeoutMs: 5000,
      trajectory: collector,
    };

    // tracedSpawn returns exitCode 0 → runner should succeed
    await runner.run(job as unknown as import('../../src/types/desired-state.js').RestorationJob, context);

    expect(tracedSpawn).toHaveBeenCalledOnce();
    const call = (tracedSpawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.collector).toBe(collector);
    expect(call.cmd).toBe('claude');
    expect(call.stateFrom).toBe('PREPARED');
    expect(call.stateTo).toBe('RAN_CLAUDE');
    expect(call.args).toContain('-p');
    expect(call.args).toContain('--mcp-config');
  });

  it('does NOT call tracedSpawn when no trajectory is in RunnerContext', async () => {
    const { tracedSpawn } = await import('../../src/trajectory/index.js');

    // We cannot easily intercept the raw spawn path without a full e2e setup,
    // but we can assert tracedSpawn was NOT called.
    // Note: the raw spawnAgent path will fail (no real claude binary), so we
    // assert at the point of the throw (before tracedSpawn would be called).
    const { ClaudeRunner } = await import('../../src/runner/claude.js');
    const runner = new ClaudeRunner({ claudePath: 'claude-nonexistent' });

    const job = { id: 'job-2', description: 'Test' };
    const context = {
      requestId: 'req-2' as unknown as import('../../src/types/index.js').RequestId,
      workingDirectory: '/tmp/test',
      timeoutMs: 1000,
      // No trajectory field
    };

    // Will reject because the binary doesn't exist, but tracedSpawn should NOT be called.
    await expect(
      runner.run(job as unknown as import('../../src/types/desired-state.js').RestorationJob, context),
    ).rejects.toThrow();

    expect(tracedSpawn).not.toHaveBeenCalled();
  });
});
