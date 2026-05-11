import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/harnesses/impls/learner/test-utils/noop-adapter.js';
import {
  fakeOrientSummary,
  fakeStrategy,
  fakePlan,
  fakeDebriefAnalysis,
  fakeImproveSummary,
  fakeMemoryConsolidationRecord,
} from '../../../../src/harnesses/impls/learner/test-utils/fake-plugin-outputs.js';
import { makeHarnessCtx } from '@test/harness-ctx.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

function makeCtx(workingDir: string, implStateDir: string): HarnessContext {
  const endTs = Date.now() + 60_000;
  return makeHarnessCtx({
    task: {
      id: 'replan-test-1',
      description: 'replan test',
      solverType: 'unknown.kind',
      window: { startTs: Date.now() - 1000, endTs },
      spec: {},
    } as HarnessContext['task'],
    workingDir,
    implStateDir,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  });
}

describe('claude-code-learner replan path', () => {
  let workingDir: string;
  let implStateDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-replan-work-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-replan-state-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(implStateDir, { recursive: true, force: true });
  });

  it('exercises the replan branch: archives plan-v1.json, writes replan-context.json, succeeds on second plan', async () => {
    const adapter = new NoOpHarnessAdapter().on(async (inputs) => {
      const wd = inputs.workingDir;

      // Outer phases (Orient, Strategize, Plan v1).
      fakeOrientSummary(wd, inputs.signedTaskId, inputs.signedTaskKind ?? 'unknown.kind');
      fakeStrategy(wd, 'early-return');
      fakePlan(wd, 1);

      // Simulate Execute attempt 1 — step fails its successSignal.
      const execDir = join(wd, '.execute');
      mkdirSync(execDir, { recursive: true });
      writeFileSync(
        join(execDir, 'log.jsonl'),
        JSON.stringify({
          ts: Date.now(),
          stepId: 'step-1',
          decision: 'replan',
          summary: 'step-1 failed successSignal',
          retryCount: 0,
          workerStatus: 'failed',
          workerBlockers: ['successSignal not met'],
        }) + '\n',
      );

      // Replan: archive plan.json → plan-v1.json, write replan-context.json,
      // re-invoke Plan to produce a fresh plan.json.
      const planDir = join(wd, '.plan');
      const { copyFileSync } = await import('node:fs');
      copyFileSync(join(planDir, 'plan.json'), join(planDir, 'plan-v1.json'));
      writeFileSync(
        join(planDir, 'replan-context.json'),
        JSON.stringify({
          failedStepId: 'step-1',
          blockers: ['successSignal not met'],
          partialOutputs: [],
        }),
      );
      // Fresh plan v2 (just overwrite plan.json).
      fakePlan(wd, 2);

      // Execute attempt 2 — succeeds.
      writeFileSync(
        join(execDir, 'log.jsonl'),
        JSON.stringify({
          ts: Date.now(),
          stepId: 'step-1',
          decision: 'continue',
          summary: 'step-1 OK on retry',
          retryCount: 1,
          workerStatus: 'success',
          workerBlockers: [],
        }) + '\n',
        { flag: 'a' },
      );
      writeFileSync(
        join(execDir, 'summary.json'),
        JSON.stringify({
          stepsCompleted: ['step-1', 'step-2'],
          stepsFailed: [],
          decisions: ['replan', 'continue', 'continue'],
          elapsedMs: 200,
          returnReason: 'all-steps-completed',
        }),
      );

      // Final outer phases.
      fakeDebriefAnalysis(wd, 'yes');
      fakeImproveSummary(wd);
      fakeMemoryConsolidationRecord(wd);
    });

    const impl = new LearnerHarness({ adapter });
    const ctx = makeCtx(workingDir, implStateDir);
    const out = await impl.run(ctx);

    // Assert the replan-path artifacts landed where they should.
    expect(existsSync(join(workingDir, '.plan', 'plan-v1.json'))).toBe(true);
    expect(existsSync(join(workingDir, '.plan', 'replan-context.json'))).toBe(true);
    expect(existsSync(join(workingDir, '.plan', 'plan.json'))).toBe(true);
    // Final harvest reflects a successful run after replan.
    expect(out.gating).toMatchObject({
      executeReturnReason: 'all-steps-completed',
      executeStepsCompleted: 2,
    });
  });
});
