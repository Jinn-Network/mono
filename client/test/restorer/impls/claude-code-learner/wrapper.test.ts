import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeLearnerWrapper } from '../../../../src/restorer/impls/claude-code-learner/wrapper.js';
import { ClaudeCodeLearnerImpl } from '../../../../src/restorer/impls/claude-code-learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/restorer/impls/claude-code-learner/test-utils/noop-adapter.js';
import {
  fakeFullPipelineRun,
  fakeOrientSummary,
  fakeStrategy,
  fakePlan,
  fakeDebriefAnalysis,
  fakeImproveSummary,
  fakeMemoryConsolidationRecord,
} from '../../../../src/restorer/impls/claude-code-learner/test-utils/fake-plugin-outputs.js';
import { makeRestorationCtx } from '@test/restoration-ctx.js';
import type { RestorerImpl, RestorationContext, RestorationOutput, ReadyStatus } from '../../../../src/restorer/types.js';
import type { DesiredState } from '../../../../src/types/desired-state.js';

function makeFakeSpecialist(kinds: string[]): RestorerImpl & { runCalled: boolean } {
  const stub = {
    name: `specialist-${kinds.join(',')}`,
    version: '0.0.1',
    runCalled: false,
    supports: (spec: { kind: string }) => kinds.includes(spec.kind),
    async run(ctx: RestorationContext): Promise<RestorationOutput> {
      stub.runCalled = true;
      // Simulate specialist writing its execute outputs.
      const dir = join(ctx.workingDir, '.execute');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'summary.json'),
        JSON.stringify({
          stepsCompleted: ['specialist-step-1'],
          stepsFailed: [],
          decisions: [],
          elapsedMs: 100,
          returnReason: 'all-steps-completed',
        }),
      );
      return {
        venueRef: { name: stub.name },
        gating: { specialistRan: true },
      };
    },
  };
  return stub;
}

function makeCtx(workingDir: string, implStateDir: string, kind: string): RestorationContext {
  const endTs = Date.now() + 60_000;
  return makeRestorationCtx({
    intent: {
      id: 'wrapper-test-1',
      description: 'wrapper test',
      window: { startTs: Date.now() - 1000, endTs },
      spec: { kind },
    } as RestorationContext['intent'],
    intentCid: 'bafywrapper',
    workingDir,
    implStateDir,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  });
}

function makeSpecialistWithGates(
  kinds: string[],
  gates: Partial<Pick<RestorerImpl, 'isReady' | 'canAttempt' | 'enableMetadata' | 'onEnable' | 'onDisable'>>,
): RestorerImpl {
  return {
    name: `specialist-${kinds.join(',')}`,
    version: '0.0.1',
    supports: (spec: { kind: string }) => kinds.includes(spec.kind),
    async run(_ctx: RestorationContext): Promise<RestorationOutput> {
      return { venueRef: { name: 'specialist' }, gating: {} };
    },
    ...gates,
  };
}

describe('ClaudeCodeLearnerWrapper', () => {
  let workingDir: string;
  let implStateDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-wrap-work-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-wrap-state-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(implStateDir, { recursive: true, force: true });
  });

  it('supports() always returns true (first-match)', () => {
    const adapter = new NoOpHarnessAdapter();
    const shim = new ClaudeCodeLearnerImpl({ adapter });
    const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [] });
    expect(wrapper.supports({ kind: 'portfolio.v0' })).toBe(true);
    expect(wrapper.supports({ kind: 'random.kind' })).toBe(true);
  });

  it('delegates Execute to specialist when kind has one (and skips plugin Execute)', async () => {
    const specialist = makeFakeSpecialist(['portfolio.v0']);
    const adapter = new NoOpHarnessAdapter().on(async (inputs) => {
      const phaseRange = inputs.adapterEnv?.JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE ?? 'all';
      const wd = inputs.workingDir;
      if (phaseRange === 'pre-execute') {
        fakeOrientSummary(wd, inputs.intentId, inputs.intentKind ?? 'unknown');
        fakeStrategy(wd, 'early-return');
        fakePlan(wd, 1);
      } else if (phaseRange === 'post-execute') {
        fakeDebriefAnalysis(wd, 'yes');
        fakeImproveSummary(wd);
        fakeMemoryConsolidationRecord(wd);
      } else {
        // 'all' — not reachable in this test (specialist path).
        fakeFullPipelineRun(wd, { intentKind: inputs.intentKind ?? 'unknown' });
      }
    });
    const shim = new ClaudeCodeLearnerImpl({ adapter });
    const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [specialist] });

    const ctx = makeCtx(workingDir, implStateDir, 'portfolio.v0');
    const out = await wrapper.run(ctx);

    expect(specialist.runCalled).toBe(true);
    expect(out.venueRef.name).toEqual('claude-code-learner');
    expect(out.gating).toMatchObject({
      executeSpecialist: 'specialist-portfolio.v0',
      executeReturnReason: 'all-steps-completed',
    });

    // Two shim passes: pre-execute (1-3) and post-execute (5-7).
    const invocations = adapter.getInvocations();
    expect(invocations).toHaveLength(2);
    expect(invocations[0].inputs.adapterEnv?.JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE).toEqual('pre-execute');
    expect(invocations[1].inputs.adapterEnv?.JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE).toEqual('post-execute');
  });

  it('the post-Execute pass sees Execute artifacts the specialist produced', async () => {
    const specialist = makeFakeSpecialist(['portfolio.v0']);
    let postExecuteCallSawExecuteArtifact = false;
    const adapter = new NoOpHarnessAdapter().on(async (inputs) => {
      const phaseRange = inputs.adapterEnv?.JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE ?? 'all';
      const wd = inputs.workingDir;
      if (phaseRange === 'pre-execute') {
        fakeOrientSummary(wd, inputs.intentId, inputs.intentKind ?? 'unknown');
        fakeStrategy(wd, 'early-return');
        fakePlan(wd, 1);
      } else if (phaseRange === 'post-execute') {
        // Verify .execute/summary.json exists at this point.
        postExecuteCallSawExecuteArtifact = existsSync(join(wd, '.execute', 'summary.json'));
        fakeDebriefAnalysis(wd, 'yes');
        fakeImproveSummary(wd);
        fakeMemoryConsolidationRecord(wd);
      } else {
        // 'all' — for non-specialist path; not reachable in this test.
        fakeFullPipelineRun(wd, { intentKind: inputs.intentKind ?? 'unknown' });
      }
    });
    const shim = new ClaudeCodeLearnerImpl({ adapter });
    const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [specialist] });

    const ctx = makeCtx(workingDir, implStateDir, 'portfolio.v0');
    const out = await wrapper.run(ctx);

    expect(specialist.runCalled).toBe(true);
    expect(postExecuteCallSawExecuteArtifact).toBe(true); // critical: post-Execute pass had Execute artifacts available
    expect(adapter.getInvocations()).toHaveLength(2); // two shim passes
    expect(out.gating.executeSpecialist).toEqual('specialist-portfolio.v0');
  });

  it('runs full plugin pipeline (including Execute) when no specialist matches', async () => {
    const adapter = new NoOpHarnessAdapter();
    const shim = new ClaudeCodeLearnerImpl({ adapter });
    const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [] });

    const ctx = makeCtx(workingDir, implStateDir, 'unknown.kind');
    const out = await wrapper.run(ctx);

    expect(out.venueRef.name).toEqual('claude-code-learner');
    expect(out.gating.phasesCompleted).toContain('execute');
  });

  it('skips specialist when its supports() returns false even if it is in the list', async () => {
    const wrongSpecialist = makeFakeSpecialist(['prediction.v0']);
    const adapter = new NoOpHarnessAdapter();
    const shim = new ClaudeCodeLearnerImpl({ adapter });
    const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [wrongSpecialist] });

    const ctx = makeCtx(workingDir, implStateDir, 'portfolio.v0');
    await wrapper.run(ctx);

    expect(wrongSpecialist.runCalled).toBe(false);
  });

  describe('gate method delegation', () => {
    it('isReady() delegates to specialist and propagates not-ready status', async () => {
      const specialist = makeSpecialistWithGates(['portfolio.v0'], {
        async isReady(): Promise<ReadyStatus> {
          return { ready: false, reason: 'no api-wallet' };
        },
      });
      const adapter = new NoOpHarnessAdapter();
      const shim = new ClaudeCodeLearnerImpl({ adapter });
      const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [specialist] });

      const status = await wrapper.isReady!();
      expect(status.ready).toBe(false);
      expect(status.reason).toBe('no api-wallet');
    });

    it('isReady() returns ready when no specialist defines isReady', async () => {
      const specialist = makeFakeSpecialist(['portfolio.v0']);
      const adapter = new NoOpHarnessAdapter();
      const shim = new ClaudeCodeLearnerImpl({ adapter });
      const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [specialist] });

      const status = await wrapper.isReady!();
      expect(status.ready).toBe(true);
    });

    it('isReady() returns ready when all specialists report ready', async () => {
      const specialist = makeSpecialistWithGates(['portfolio.v0'], {
        async isReady(): Promise<ReadyStatus> {
          return { ready: true };
        },
      });
      const adapter = new NoOpHarnessAdapter();
      const shim = new ClaudeCodeLearnerImpl({ adapter });
      const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [specialist] });

      const status = await wrapper.isReady!();
      expect(status.ready).toBe(true);
    });

    it('canAttempt() delegates to specialist for matching kind and propagates rejection', async () => {
      const specialist = makeSpecialistWithGates(['portfolio.v0'], {
        async canAttempt(_intent: DesiredState) {
          return { ok: false as const, reason: 'window closed' };
        },
      });
      const adapter = new NoOpHarnessAdapter();
      const shim = new ClaudeCodeLearnerImpl({ adapter });
      const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [specialist] });

      const intent: DesiredState = { id: 'test', description: 'test', spec: { kind: 'portfolio.v0' } };
      const result = await wrapper.canAttempt!(intent);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; reason: string }).reason).toBe('window closed');
    });

    it('canAttempt() returns ok:true when no specialist matches kind', async () => {
      const specialist = makeSpecialistWithGates(['prediction.v0'], {
        async canAttempt(_intent: DesiredState) {
          return { ok: false as const, reason: 'wrong kind' };
        },
      });
      const adapter = new NoOpHarnessAdapter();
      const shim = new ClaudeCodeLearnerImpl({ adapter });
      const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [specialist] });

      const intent: DesiredState = { id: 'test', description: 'test', spec: { kind: 'portfolio.v0' } };
      const result = await wrapper.canAttempt!(intent);
      expect(result.ok).toBe(true);
    });

    it('canAttempt() returns ok:true when matching specialist has no canAttempt', async () => {
      const specialist = makeFakeSpecialist(['portfolio.v0']);
      const adapter = new NoOpHarnessAdapter();
      const shim = new ClaudeCodeLearnerImpl({ adapter });
      const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [specialist] });

      const intent: DesiredState = { id: 'test', description: 'test', spec: { kind: 'portfolio.v0' } };
      const result = await wrapper.canAttempt!(intent);
      expect(result.ok).toBe(true);
    });

    it('enableMetadata() returns undefined (no kind context for delegation)', () => {
      const adapter = new NoOpHarnessAdapter();
      const shim = new ClaudeCodeLearnerImpl({ adapter });
      const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [] });

      expect(wrapper.enableMetadata?.()).toBeUndefined();
    });

    it('onEnable() returns ready status', async () => {
      const adapter = new NoOpHarnessAdapter();
      const shim = new ClaudeCodeLearnerImpl({ adapter });
      const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [] });

      const result = await wrapper.onEnable!({});
      expect(result.status).toBe('ready');
    });

    it('onDisable() resolves without error', async () => {
      const adapter = new NoOpHarnessAdapter();
      const shim = new ClaudeCodeLearnerImpl({ adapter });
      const wrapper = new ClaudeCodeLearnerWrapper({ shim, specialists: [] });

      await expect(wrapper.onDisable!()).resolves.toBeUndefined();
    });
  });
});
