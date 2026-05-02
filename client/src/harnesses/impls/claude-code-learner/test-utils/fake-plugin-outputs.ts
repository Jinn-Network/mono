import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Helpers to seed workingDir with realistic plugin artifacts so tests
 * can exercise the shim's harvest + lifecycle logic without spawning a
 * real harness.
 *
 * Each function writes one phase's output. The shapes match what the
 * plugin (Plan 1) writes per its skill/agent contracts.
 */

function writeJson(path: string, payload: unknown): void {
  const dir = path.substring(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

export function fakeOrientSummary(workingDir: string, taskId: string, solverType: string): void {
  writeJson(join(workingDir, '.orient', 'summary.json'), {
    task: { id: taskId, solverType, window: { startTs: 0, endTs: 0 } },
    topics: [
      { topic: 'task-parse', artifact: 'workingDir/.orient/task-parse.json', summary: 'parsed', flags: [] },
    ],
    openQuestions: [],
  });
}

export function fakeStrategy(workingDir: string, posture: 'early-return' | 'hold-and-revise' | 'continuous-observation'): void {
  writeJson(join(workingDir, '.strategize', 'strategy.json'), {
    approach: 'fake-approach',
    rationale: 'test',
    successCriteria: 'fake passes if test passes',
    timingPosture: posture,
    constraints: [],
    rejectedAlternatives: [],
  });
  writeJson(join(workingDir, '.strategize', 'constitution.json'), {
    successCriteriaCid: 'sha256:fake',
    timingPosture: posture,
    skillBundleCid: 'sha256:fake',
    implStateDirSha: 'fakeSha',
    editableScope: [`${workingDir}/**`],
  });
}

export function fakePlan(workingDir: string, stepCount: number): void {
  writeJson(join(workingDir, '.plan', 'plan.json'), {
    successCriteria: 'fake passes if test passes',
    timingPosture: 'early-return',
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `step-${i + 1}`,
      kind: 'work',
      concurrency: 'sequential',
      description: `fake step ${i + 1}`,
      inputs: {},
      toolsNeeded: [],
      expectedOutputs: [],
      successSignal: 'always',
      abortCondition: 'never',
    })),
  });
}

export function fakeExecuteSummary(
  workingDir: string,
  opts: {
    stepsCompleted?: string[];
    stepsFailed?: string[];
    returnReason?: string;
    elapsedMs?: number;
  } = {},
): void {
  writeJson(join(workingDir, '.execute', 'summary.json'), {
    stepsCompleted: opts.stepsCompleted ?? ['step-1'],
    stepsFailed: opts.stepsFailed ?? [],
    decisions: [],
    elapsedMs: opts.elapsedMs ?? 0,
    returnReason: opts.returnReason ?? 'all-steps-completed',
  });
}

export function fakeDebriefAnalysis(
  workingDir: string,
  verdict: 'yes' | 'no' | 'partial',
): void {
  writeJson(join(workingDir, '.debrief', 'analysis.json'), {
    successCriteriaMet: verdict,
    successCriteriaShortfall: verdict === 'yes' ? null : 'fake shortfall',
    divergencesFromPlan: [],
    crossOperatorSignals: [],
    trend: { kind: 'fake', lastNRuns: 0, passRate: 1, direction: 'flat', notableFailureShapes: [] },
    recommendationsForImprove: [],
  });
}

export function fakeImproveSummary(workingDir: string): void {
  writeJson(join(workingDir, '.improve', 'summary.json'), {
    implStateDirShaBefore: 'fakeShaBefore',
    implStateDirShaAfter: 'fakeShaBefore',
    changesAccepted: 0,
    changesRejected: 0,
    operatorRequests: 0,
    rejectionsRationale: [],
  });
}

export function fakeMemoryConsolidationRecord(workingDir: string): void {
  writeJson(join(workingDir, '.memory-consolidation', 'consolidation_record.json'), {
    ts: Date.now(),
    implStateDirShaBefore: 'fakeShaBefore',
    implStateDirShaAfter: 'fakeShaBefore',
    durable: { skillsArchived: [], promotionsReverted: [], notesCompacted: 0, conflictsResolved: [] },
    ephemeral: { movedToPrivate: [], migratedToImplState: [] },
  });
}

/** Convenience: write all seven happy-path phase artifacts. */
export function fakeFullPipelineRun(
  workingDir: string,
  opts: { taskId?: string; solverType?: string; posture?: 'early-return' | 'hold-and-revise' | 'continuous-observation'; verdict?: 'yes' | 'no' | 'partial' } = {},
): void {
  const taskId = opts.taskId ?? 'fake-task';
  const solverType = opts.solverType ?? 'fake.solver';
  const posture = opts.posture ?? 'early-return';
  const verdict = opts.verdict ?? 'yes';
  fakeOrientSummary(workingDir, taskId, solverType);
  fakeStrategy(workingDir, posture);
  fakePlan(workingDir, 1);
  fakeExecuteSummary(workingDir);
  fakeDebriefAnalysis(workingDir, verdict);
  fakeImproveSummary(workingDir);
  fakeMemoryConsolidationRecord(workingDir);
}
