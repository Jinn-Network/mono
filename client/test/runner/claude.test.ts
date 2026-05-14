import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { buildPrompt } from '../../src/runner/claude.js';
import { TrajectoryCollector } from '../../src/trajectory/collector.js';

// ── Module mock for tracedSpawn ────────────────────────────────────────────────
// We mock the trajectory index to intercept tracedSpawn calls without
// spawning a real Claude binary.
vi.mock('../../src/trajectory/index.js', () => ({
  tracedSpawn: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

describe('Claude runner', () => {
  it('builds a prompt from a Task', () => {
    const prompt = buildPrompt({
      id: 'ds-1',
      description: 'The API should return 200 on /health',
      context: { endpoint: 'https://api.example.com/health' },
    });

    expect(prompt).toContain('The API should return 200 on /health');
    expect(prompt).toContain('Task');
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

    const collector = new TrajectoryCollector({ taskCid: 'bafy', runId: 'runner-test-1' });
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
    await runner.run(job as unknown as import('../../src/types/task.js').Task, context);

    expect(tracedSpawn).toHaveBeenCalledOnce();
    const call = (tracedSpawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.collector).toBe(collector);
    expect(call.cmd).toBe('claude');
    expect(call.stateFrom).toBe('PREPARED');
    expect(call.stateTo).toBe('RAN_CLAUDE');
    expect(call.args).toContain('-p');
    expect(call.args).toContain('--mcp-config');
  });

  it('writes JINN_CORPUS_* MCP env from context.corpusEnv (keyless URLs only — agent EOA stays daemon-side)', async () => {
    const { tracedSpawn } = await import('../../src/trajectory/index.js');
    let captured: { mcpServers: { 'jinn-client': { env: Record<string, string> } } } | undefined;
    vi.mocked(tracedSpawn).mockImplementation(async (opts) => {
      const idx = opts.args.indexOf('--mcp-config');
      const mcpPath = idx >= 0 ? opts.args[idx + 1] : undefined;
      if (mcpPath) {
        const raw = fs.readFileSync(mcpPath, 'utf8');
        captured = JSON.parse(raw) as typeof captured;
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { ClaudeRunner } = await import('../../src/runner/claude.js');
    const collector = new TrajectoryCollector({ taskCid: 'bafy', runId: 'corpus-propagate' });
    const runner = new ClaudeRunner({ claudePath: 'claude', model: 'test-model' });
    const corpusEnv = {
      discoveryUrl: 'https://sg.example/gql',
      ipfsGatewayUrl: 'https://gw.example',
    };
    await runner.run(
      {
        id: 'job-corpus',
        description: 'Test',
      } as unknown as import('../../src/types/task.js').Task,
      {
        requestId: 'req-corpus' as unknown as import('../../src/types/index.js').RequestId,
        workingDirectory: '/tmp/test',
        timeoutMs: 5000,
        trajectory: collector,
        corpusEnv,
      },
    );

    expect(captured).toBeDefined();
    const env = captured!.mcpServers['jinn-client'].env;
    expect(env.JINN_DISCOVERY_URL).toBe('https://sg.example/gql');
    expect(env.JINN_DISCOVERY_MODE).toBe('http');
    expect(env.JINN_CORPUS_IPFS_GATEWAY_URL).toBe('https://gw.example');
    // Security posture: the agent EOA private key NEVER crosses into the MCP
    // subprocess. acquire_artifact proxies to the daemon at DAEMON_API_URL.
    // See spec/2026-04-30-phase-a-umbrella.md §4.
    expect(env.JINN_CORPUS_AGENT_PRIVATE_KEY).toBeUndefined();
    expect(env.JINN_CORPUS_SELF_SAFE_ADDRESS).toBeUndefined();
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
      runner.run(job as unknown as import('../../src/types/task.js').Task, context),
    ).rejects.toThrow();

    expect(tracedSpawn).not.toHaveBeenCalled();
  });
});
