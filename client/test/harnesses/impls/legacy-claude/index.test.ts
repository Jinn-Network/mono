/**
 * Tests for LegacyClaudeImpl — the Harness fallback for Tasks with no solverType.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyClaudeImpl } from '../../../../src/harnesses/impls/legacy-claude/index.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Runner, RunnerContext } from '../../../../src/runner/runner.js';
import type { Task } from '../../../../src/types/task.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-request-id',
    description: 'The service should be healthy.',
    ...overrides,
  };
}

function makeContext(task: Task, workingDir: string): HarnessContext {
  return {
    task,
    implStateDir: join(workingDir, 'impl-state'),
    workingDir,
    log: vi.fn(),
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: {
      taskCid: '',
      runId: 'test',
      addSpan: () => undefined,
      snapshot: () => ({ spans: [], redactionManifest: { spans: [], totalRedactions: 0 } }),
    } as unknown as HarnessContext['trajectory'],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('LegacyClaudeImpl', () => {
  it('supports empty solverType for health-check Tasks', () => {
    const runner: Runner = { run: vi.fn() };
    const impl = new LegacyClaudeImpl({ runner });
    expect(impl.supports({ solverType: '' })).toBe(true);
  });

  it('supports solverType="legacy"', () => {
    const runner: Runner = { run: vi.fn() };
    const impl = new LegacyClaudeImpl({ runner });
    expect(impl.supports({ solverType: 'legacy' })).toBe(true);
  });

  it('does not support other SolverTypes', () => {
    const runner: Runner = { run: vi.fn() };
    const impl = new LegacyClaudeImpl({ runner });
    expect(impl.supports({ solverType: 'portfolio.v0' })).toBe(false);
    expect(impl.supports({ solverType: 'portfolio.v0.eval' })).toBe(false);
  });

  it('canAttempt always returns ok:true', async () => {
    const runner: Runner = { run: vi.fn() };
    const impl = new LegacyClaudeImpl({ runner });
    const result = await impl.canAttempt!({ id: 'x', description: 'y' });
    expect(result.ok).toBe(true);
  });

  it('name and version are set correctly', () => {
    const runner: Runner = { run: vi.fn() };
    const impl = new LegacyClaudeImpl({ runner });
    expect(impl.name).toBe('legacy-claude');
    expect(impl.version).toBe('1.0.0');
  });

  describe('run()', () => {
    let workingDir: string;

    beforeEach(() => {
      workingDir = mkdtempSync(join(tmpdir(), 'legacy-claude-test-'));
    });

    afterEach(() => {
      rmSync(workingDir, { recursive: true, force: true });
    });

    it('calls runner.run with correct context and returns Solution', async () => {
      const mockResult = { data: 'Service is healthy.', artifacts: [] };
      const runner: Runner = {
        run: vi.fn().mockResolvedValue(mockResult),
      };

      const impl = new LegacyClaudeImpl({
        runner,
        workingDirectory: '/tmp',
        timeoutMs: 60_000,
        storePath: '/tmp/test.db',
        daemonApiUrl: 'http://127.0.0.1:7331',
      });

      const task = makeTask();
      const ctx = makeContext(task, workingDir);

      const output = await impl.run(ctx);

      // Runner was called with the Task and a correct context.
      expect(runner.run).toHaveBeenCalledOnce();
      const [calledIntent, calledCtx] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [Task, RunnerContext];
      expect(calledIntent.id).toBe('test-request-id');
      expect(calledCtx.requestId).toBe('test-request-id');
      expect(calledCtx.timeoutMs).toBe(60_000);
      expect(calledCtx.storePath).toBe('/tmp/test.db');
      expect(calledCtx.daemonApiUrl).toBe('http://127.0.0.1:7331');

      // Output shape is valid Solution
      expect(output.venueRef.name).toBe('legacy');
      expect(output.gating).toBeDefined();
      expect(output.gating['result']).toBe('Service is healthy.');
      expect(output.informational?.['runnerResult']).toBe('Service is healthy.');
      expect(Array.isArray(output.artifacts)).toBe(true);
    });

    it('propagates runner result data into gating.result', async () => {
      const runner: Runner = {
        run: vi.fn().mockResolvedValue({ data: 'custom result data' }),
      };

      const impl = new LegacyClaudeImpl({ runner });
      const ctx = makeContext(makeTask(), workingDir);
      const output = await impl.run(ctx);

      expect(output.gating['result']).toBe('custom result data');
    });

    it('populates verdictPayload for evaluation tasks', async () => {
      const verdict = {
        protocol: 'jinn-client/v1',
        type: 'evaluation-verdict',
        success: true,
        reason: 'ok',
      };
      const runner: Runner = {
        run: vi.fn().mockResolvedValue({ data: JSON.stringify(verdict) }),
      };

      const impl = new LegacyClaudeImpl({ runner });
      const ctx = makeContext(makeTask({ role: 'evaluation' }), workingDir);
      const output = await impl.run(ctx);

      expect(output.verdictPayload).toEqual(verdict);
    });

    it('handles empty runner result gracefully', async () => {
      const runner: Runner = {
        run: vi.fn().mockResolvedValue({ data: '' }),
      };

      const impl = new LegacyClaudeImpl({ runner });
      const ctx = makeContext(makeTask(), workingDir);
      const output = await impl.run(ctx);

      expect(output.gating['result']).toBe('');
      expect(output.informational?.['artifactCount']).toBe(0);
    });

    it('uses workingDir from context as runnerCtx.workingDirectory', async () => {
      const runner: Runner = {
        run: vi.fn().mockResolvedValue({ data: '' }),
      };

      const impl = new LegacyClaudeImpl({ runner, workingDirectory: '/default' });
      const ctx = makeContext(makeTask(), workingDir);
      await impl.run(ctx);

      const [, calledCtx] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [Task, RunnerContext];
      // workingDir from context takes priority over config default
      expect(calledCtx.workingDirectory).toBe(workingDir);
    });

    it('falls back to config workingDirectory when ctx.workingDir is undefined', async () => {
      const runner: Runner = {
        run: vi.fn().mockResolvedValue({ data: '' }),
      };

      const impl = new LegacyClaudeImpl({ runner, workingDirectory: '/custom-default' });
      const ctx = makeContext(makeTask(), workingDir);
      // Override workingDir to simulate undefined
      const ctxNoDir = { ...ctx, workingDir: undefined as unknown as string };
      await impl.run(ctxNoDir);

      const [, calledCtx] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [Task, RunnerContext];
      expect(calledCtx.workingDirectory).toBe('/custom-default');
    });

    it('passes corpusEnv through to RunnerContext for MCP credential forwarding', async () => {
      const runner: Runner = { run: vi.fn().mockResolvedValue({ data: '' }) };
      const corpusEnv = {
        subgraphUrl: 'https://subgraph.example/graphql',
        ipfsGatewayUrl: 'https://gateway.example',
        agentPrivateKey: `0x${'a'.repeat(64)}`,
        selfSafeAddress: `0x${'b'.repeat(40)}`,
      };
      const impl = new LegacyClaudeImpl({ runner, corpusEnv });
      await impl.run(makeContext(makeTask(), workingDir));

      const [, calledCtx] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [Task, RunnerContext];
      expect(calledCtx.corpusEnv).toEqual(corpusEnv);
    });
  });
});

// ── Integration: engine dispatch by SolverType ────────────────────────────────

describe('HarnessRegistry dispatch (integration)', () => {
  it('routes Tasks with no solverType to legacy-claude via default fallback', async () => {
    const { HarnessRegistry } = await import('../../../../src/harnesses/engine/registry.js');
    const { LegacyClaudeImpl: LCI } = await import('../../../../src/harnesses/impls/legacy-claude/index.js');

    const runner: Runner = { run: vi.fn() };
    const registry = new HarnessRegistry({ default: 'legacy-claude' });
    registry.register(new LCI({ runner }));

    // solverType='' is what the engine passes for solverType=null Tasks.
    const impl = registry.findFor({ solverType: '' });
    expect(impl).toBeDefined();
    expect(impl?.name).toBe('legacy-claude');
  });

  it('routes portfolio.v0 to the SolverNet-selected Harness', async () => {
    const { HarnessRegistry } = await import('../../../../src/harnesses/engine/registry.js');
    const { ClaudeMcpHyperliquidImpl } = await import('../../../../src/harnesses/impls/claude-mcp-hyperliquid/index.js');
    const { LegacyClaudeImpl: LCI } = await import('../../../../src/harnesses/impls/legacy-claude/index.js');

    const runner: Runner = { run: vi.fn() };
    const registry = new HarnessRegistry({
      solverTypeHarnesses: { 'portfolio.v0': 'claude-mcp-hyperliquid' },
      default: 'legacy-claude',
    });

    registry.register(new LCI({ runner }));
    registry.register(new ClaudeMcpHyperliquidImpl());

    const impl = registry.findFor({ solverType: 'portfolio.v0' });
    expect(impl?.name).toBe('claude-mcp-hyperliquid');
  });

  it('routes portfolio.v0 + type=evaluation to portfolio-v0-evaluator via supports() first-match', async () => {
    // Evaluation Tasks are selected via first-match supports() when
    // solverType='portfolio.v0' and role='evaluation'.
    const { HarnessRegistry } = await import('../../../../src/harnesses/engine/registry.js');
    const { PortfolioV0Evaluator } = await import('../../../../src/harnesses/impls/portfolio-v0-evaluator/index.js');
    const { LegacyClaudeImpl: LCI } = await import('../../../../src/harnesses/impls/legacy-claude/index.js');

    const runner: Runner = { run: vi.fn() };
    // No SolverNet-selected Harness for portfolio.v0 — evaluator is selected via supports().
    const registry = new HarnessRegistry({
      default: 'legacy-claude',
    });

    registry.register(new LCI({ runner }));
    registry.register(new PortfolioV0Evaluator());

    const impl = registry.findFor({ solverType: 'portfolio.v0', role: 'evaluation' });
    expect(impl?.name).toBe('portfolio-v0-evaluator');
  });

  it('returns undefined for unknown SolverType when no default matches', async () => {
    const { HarnessRegistry } = await import('../../../../src/harnesses/engine/registry.js');
    const { LegacyClaudeImpl: LCI } = await import('../../../../src/harnesses/impls/legacy-claude/index.js');

    const runner: Runner = { run: vi.fn() };
    const registry = new HarnessRegistry({});
    registry.register(new LCI({ runner }));

    // Unknown SolverTypes do not match legacy-claude.supports().
    const impl = registry.findFor({ solverType: 'unknown-kind' });
    expect(impl).toBeUndefined();
  });
});
