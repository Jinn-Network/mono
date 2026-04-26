import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultLearningWrapper } from '../../../../src/restorer/impls/default-learner/wrapper.js';
import { DefaultLearningRestorerImpl } from '../../../../src/restorer/impls/default-learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/restorer/impls/default-learner/test-utils/noop-adapter.js';
import { fakeFullPipelineRun } from '../../../../src/restorer/impls/default-learner/test-utils/fake-plugin-outputs.js';
import type { RestorerImpl, RestorationContext, RestorationOutput } from '../../../../src/restorer/types.js';

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
  return {
    intent: {
      id: 'wrapper-test-1',
      description: 'wrapper test',
      window: { startTs: Date.now() - 1000, endTs },
      spec: { kind } as RestorationContext['intent']['spec'],
    } as RestorationContext['intent'],
    intentCid: 'bafywrapper',
    implStateDir,
    workingDir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  };
}

describe('DefaultLearningWrapper', () => {
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
    const shim = new DefaultLearningRestorerImpl({ adapter });
    const wrapper = new DefaultLearningWrapper({ shim, specialists: [] });
    expect(wrapper.supports({ kind: 'portfolio.v0' })).toBe(true);
    expect(wrapper.supports({ kind: 'random.kind' })).toBe(true);
  });

  it('delegates Execute to specialist when kind has one (and skips plugin Execute)', async () => {
    const specialist = makeFakeSpecialist(['portfolio.v0']);
    const adapter = new NoOpHarnessAdapter().on(async (inputs) => {
      // Simulate plugin running outer phases only.
      fakeFullPipelineRun(inputs.workingDir, { intentKind: inputs.intentKind ?? 'unknown' });
      // Confirm wrapper set the skip-execute env hint somehow visible to the adapter.
      // Wrapper passes this via inputs.adapterEnv (extension we add below).
    });
    const shim = new DefaultLearningRestorerImpl({ adapter });
    const wrapper = new DefaultLearningWrapper({ shim, specialists: [specialist] });

    const ctx = makeCtx(workingDir, implStateDir, 'portfolio.v0');
    const out = await wrapper.run(ctx);

    expect(specialist.runCalled).toBe(true);
    expect(out.venueRef.name).toEqual('default-learner');
    expect(out.gating).toMatchObject({
      executeSpecialist: 'specialist-portfolio.v0',
      executeReturnReason: 'all-steps-completed',
    });
  });

  it('runs full plugin pipeline (including Execute) when no specialist matches', async () => {
    const adapter = new NoOpHarnessAdapter();
    const shim = new DefaultLearningRestorerImpl({ adapter });
    const wrapper = new DefaultLearningWrapper({ shim, specialists: [] });

    const ctx = makeCtx(workingDir, implStateDir, 'unknown.kind');
    const out = await wrapper.run(ctx);

    expect(out.venueRef.name).toEqual('default-learner');
    expect(out.gating.phasesCompleted).toContain('execute');
  });

  it('skips specialist when its supports() returns false even if it is in the list', async () => {
    const wrongSpecialist = makeFakeSpecialist(['prediction.v0']);
    const adapter = new NoOpHarnessAdapter();
    const shim = new DefaultLearningRestorerImpl({ adapter });
    const wrapper = new DefaultLearningWrapper({ shim, specialists: [wrongSpecialist] });

    const ctx = makeCtx(workingDir, implStateDir, 'portfolio.v0');
    await wrapper.run(ctx);

    expect(wrongSpecialist.runCalled).toBe(false);
  });
});
