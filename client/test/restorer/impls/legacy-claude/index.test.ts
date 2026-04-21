/**
 * Tests for LegacyClaudeImpl — the RestorerImpl fallback for spec=undefined intents.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyClaudeImpl } from '../../../../src/restorer/impls/legacy-claude/index.js';
import type { RestorationContext } from '../../../../src/restorer/types.js';
import type { Runner, RunnerContext } from '../../../../src/runner/runner.js';
import type { DesiredState } from '../../../../src/types/desired-state.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeIntent(overrides: Partial<DesiredState> = {}): DesiredState {
  return {
    id: 'test-request-id',
    description: 'The service should be healthy.',
    ...overrides,
  };
}

function makeContext(intent: DesiredState, workingDir: string): RestorationContext {
  return {
    intent,
    implStateDir: join(workingDir, 'impl-state'),
    workingDir,
    log: vi.fn(),
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('LegacyClaudeImpl', () => {
  it('supports spec.kind="" (legacy intents from engine runImpl)', () => {
    const runner: Runner = { run: vi.fn() };
    const impl = new LegacyClaudeImpl({ runner });
    expect(impl.supports({ kind: '' })).toBe(true);
  });

  it('supports spec.kind="legacy"', () => {
    const runner: Runner = { run: vi.fn() };
    const impl = new LegacyClaudeImpl({ runner });
    expect(impl.supports({ kind: 'legacy' })).toBe(true);
  });

  it('does not support other spec kinds', () => {
    const runner: Runner = { run: vi.fn() };
    const impl = new LegacyClaudeImpl({ runner });
    expect(impl.supports({ kind: 'portfolio.v0' })).toBe(false);
    expect(impl.supports({ kind: 'portfolio.v0.eval' })).toBe(false);
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

    it('calls runner.run with correct context and returns RestorationOutput', async () => {
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

      const intent = makeIntent();
      const ctx = makeContext(intent, workingDir);

      const output = await impl.run(ctx);

      // Runner was called with the intent and a correct context
      expect(runner.run).toHaveBeenCalledOnce();
      const [calledIntent, calledCtx] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [DesiredState, RunnerContext];
      expect(calledIntent.id).toBe('test-request-id');
      expect(calledCtx.requestId).toBe('test-request-id');
      expect(calledCtx.timeoutMs).toBe(60_000);
      expect(calledCtx.storePath).toBe('/tmp/test.db');
      expect(calledCtx.daemonApiUrl).toBe('http://127.0.0.1:7331');

      // Output shape is valid RestorationOutput
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
      const ctx = makeContext(makeIntent(), workingDir);
      const output = await impl.run(ctx);

      expect(output.gating['result']).toBe('custom result data');
    });

    it('handles empty runner result gracefully', async () => {
      const runner: Runner = {
        run: vi.fn().mockResolvedValue({ data: '' }),
      };

      const impl = new LegacyClaudeImpl({ runner });
      const ctx = makeContext(makeIntent(), workingDir);
      const output = await impl.run(ctx);

      expect(output.gating['result']).toBe('');
      expect(output.informational?.['artifactCount']).toBe(0);
    });

    it('uses workingDir from context as runnerCtx.workingDirectory', async () => {
      const runner: Runner = {
        run: vi.fn().mockResolvedValue({ data: '' }),
      };

      const impl = new LegacyClaudeImpl({ runner, workingDirectory: '/default' });
      const ctx = makeContext(makeIntent(), workingDir);
      await impl.run(ctx);

      const [, calledCtx] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [DesiredState, RunnerContext];
      // workingDir from context takes priority over config default
      expect(calledCtx.workingDirectory).toBe(workingDir);
    });

    it('falls back to config workingDirectory when ctx.workingDir is undefined', async () => {
      const runner: Runner = {
        run: vi.fn().mockResolvedValue({ data: '' }),
      };

      const impl = new LegacyClaudeImpl({ runner, workingDirectory: '/custom-default' });
      const ctx = makeContext(makeIntent(), workingDir);
      // Override workingDir to simulate undefined
      const ctxNoDir = { ...ctx, workingDir: undefined as unknown as string };
      await impl.run(ctxNoDir);

      const [, calledCtx] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [DesiredState, RunnerContext];
      expect(calledCtx.workingDirectory).toBe('/custom-default');
    });
  });
});

// ── Integration: engine dispatch by spec kind ──────────────────────────────────

describe('RestorerImplRegistry dispatch (integration)', () => {
  it('routes spec=undefined intents to legacy-claude via default fallback', async () => {
    const { RestorerImplRegistry } = await import('../../../../src/restorer/engine/registry.js');
    const { LegacyClaudeImpl: LCI } = await import('../../../../src/restorer/impls/legacy-claude/index.js');

    const runner: Runner = { run: vi.fn() };
    const registry = new RestorerImplRegistry({ default: 'legacy-claude' });
    registry.register(new LCI({ runner }));

    // spec.kind='' is what the engine passes for specKind=null intents
    const impl = registry.findFor({ kind: '' });
    expect(impl).toBeDefined();
    expect(impl?.name).toBe('legacy-claude');
  });

  it('routes portfolio.v0 to the correct impl by byKind config', async () => {
    const { RestorerImplRegistry } = await import('../../../../src/restorer/engine/registry.js');
    const { ClaudeMcpHyperliquidImpl } = await import('../../../../src/restorer/impls/claude-mcp-hyperliquid/index.js');
    const { LegacyClaudeImpl: LCI } = await import('../../../../src/restorer/impls/legacy-claude/index.js');

    const runner: Runner = { run: vi.fn() };
    const registry = new RestorerImplRegistry({
      byKind: { 'portfolio.v0': 'claude-mcp-hyperliquid' },
      default: 'legacy-claude',
    });

    registry.register(new LCI({ runner }));
    registry.register(new ClaudeMcpHyperliquidImpl());

    const impl = registry.findFor({ kind: 'portfolio.v0' });
    expect(impl?.name).toBe('claude-mcp-hyperliquid');
  });

  it('routes portfolio.v0.eval to portfolio-v0-evaluator by byKind config', async () => {
    const { RestorerImplRegistry } = await import('../../../../src/restorer/engine/registry.js');
    const { PortfolioV0Evaluator } = await import('../../../../src/restorer/impls/portfolio-v0-evaluator/index.js');
    const { LegacyClaudeImpl: LCI } = await import('../../../../src/restorer/impls/legacy-claude/index.js');

    const runner: Runner = { run: vi.fn() };
    const registry = new RestorerImplRegistry({
      byKind: { 'portfolio.v0.eval': 'portfolio-v0-evaluator' },
      default: 'legacy-claude',
    });

    registry.register(new LCI({ runner }));
    registry.register(new PortfolioV0Evaluator());

    const impl = registry.findFor({ kind: 'portfolio.v0.eval' });
    expect(impl?.name).toBe('portfolio-v0-evaluator');
  });

  it('returns undefined for unknown spec kind when no default matches', async () => {
    const { RestorerImplRegistry } = await import('../../../../src/restorer/engine/registry.js');
    const { LegacyClaudeImpl: LCI } = await import('../../../../src/restorer/impls/legacy-claude/index.js');

    const runner: Runner = { run: vi.fn() };
    const registry = new RestorerImplRegistry({});  // no default, no byKind
    registry.register(new LCI({ runner }));

    // 'unknown-kind' does not match legacy-claude.supports()
    const impl = registry.findFor({ kind: 'unknown-kind' });
    expect(impl).toBeUndefined();
  });
});
