import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeLearnerImpl } from '../../../../src/restorer/impls/claude-code-learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/restorer/impls/claude-code-learner/test-utils/noop-adapter.js';
import { fakeFullPipelineRun } from '../../../../src/restorer/impls/claude-code-learner/test-utils/fake-plugin-outputs.js';
import { makeRestorationCtx } from '@test/restoration-ctx.js';
import type { RestorationContext } from '../../../../src/restorer/types.js';

function makeCtx(workingDir: string, implStateDir: string, kind = 'portfolio.v0'): RestorationContext {
  const endTs = Date.now() + 60_000;
  return makeRestorationCtx({
    intent: {
      id: 'shim-test-1',
      description: 'shim test',
      window: { startTs: Date.now() - 1000, endTs },
      spec: { kind },
    } as RestorationContext['intent'],
    intentCid: 'bafyshim',
    workingDir,
    implStateDir,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  });
}

describe('ClaudeCodeLearnerImpl — shim lifecycle (NoOp adapter)', () => {
  let workingDir: string;
  let implStateDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-shim-work-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-shim-state-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(implStateDir, { recursive: true, force: true });
  });

  it('exposes name and version', () => {
    const impl = new ClaudeCodeLearnerImpl({ adapter: new NoOpHarnessAdapter() });
    expect(impl.name).toEqual('claude-code-learner');
    expect(impl.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('supports() returns true for restoration kinds but false for evaluation (restoration-only impl)', () => {
    const impl = new ClaudeCodeLearnerImpl({ adapter: new NoOpHarnessAdapter() });
    expect(impl.supports({ kind: 'portfolio.v0' })).toBe(true);
    expect(impl.supports({ kind: 'prediction.v0' })).toBe(true);
    expect(impl.supports({ kind: 'portfolio.v0', type: 'restoration' })).toBe(true);
    expect(impl.supports({ kind: 'portfolio.v0', type: 'evaluation' })).toBe(false);
    expect(impl.supports({ kind: 'anything', type: 'evaluation' })).toBe(false);
  });

  it('run(ctx) invokes adapter with derived IntentSessionInputs and harvests output', async () => {
    const adapter = new NoOpHarnessAdapter();
    const impl = new ClaudeCodeLearnerImpl({ adapter });
    const ctx = makeCtx(workingDir, implStateDir);

    const out = await impl.run(ctx);

    expect(adapter.getInvocations()).toHaveLength(1);
    const invocation = adapter.getInvocations()[0];
    expect(invocation.inputs.intentId).toEqual('shim-test-1');
    expect(invocation.inputs.intentKind).toEqual('portfolio.v0');
    expect(invocation.inputs.workingDir).toEqual(workingDir);
    expect(invocation.inputs.implStateDir).toEqual(implStateDir);
    expect(invocation.inputs.windowEndTs).toEqual(ctx.intent.window.endTs);
    expect(invocation.pluginRoot).toMatch(/plugins\/claude-code-learner$/);

    expect(out.venueRef.name).toEqual('claude-code-learner');
    expect(out.gating).toMatchObject({
      phasesCompleted: [
        'orient',
        'strategize',
        'plan',
        'execute',
        'debrief',
        'improve',
        'memory-consolidation',
      ],
      executeReturnReason: 'all-steps-completed',
      debriefVerdict: 'yes',
      timingPosture: 'early-return',
    });
  });

  it('run(ctx) throws when adapter writes no artifacts (hard-fail on missing required artifacts)', async () => {
    const adapter = new NoOpHarnessAdapter().on(async () => {
      // Simulate harness exiting without writing anything.
    });
    const impl = new ClaudeCodeLearnerImpl({ adapter });
    const ctx = makeCtx(workingDir, implStateDir);

    await expect(impl.run(ctx)).rejects.toThrow('Required artifact missing');
  });

  it('honors a custom pluginRoot override', async () => {
    const adapter = new NoOpHarnessAdapter();
    const customRoot = mkdtempSync(join(tmpdir(), 'jinn-shim-plugin-'));
    try {
      const impl = new ClaudeCodeLearnerImpl({ adapter, pluginRoot: customRoot });
      const ctx = makeCtx(workingDir, implStateDir);
      await impl.run(ctx);
      expect(adapter.getInvocations()[0].pluginRoot).toEqual(customRoot);
    } finally {
      rmSync(customRoot, { recursive: true, force: true });
    }
  });
});
