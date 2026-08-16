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

export function fakePredictionCorpusRetrieval(
  workingDir: string,
  opts: {
    retrievalUsed?: boolean;
    recordsConsidered?: string[];
    recordsCited?: string[];
    recordsUsed?: string[];
    inspectedRefs?: string[];
    acquiredArtifacts?: Array<Record<string, unknown>>;
    affectedForecast?: boolean;
    probabilityYes?: string;
    consensusSnapshotRef?: string;
  } = {},
): void {
  const recordsConsidered = opts.recordsConsidered ?? [];
  const recordsCited = opts.recordsCited ?? [];
  const recordsUsed = opts.recordsUsed ?? recordsCited;
  const inspectedRefs = opts.inspectedRefs ?? recordsConsidered.slice(0, 1);

  writeJson(join(workingDir, '.execute', 'prediction-corpus-retrieval.json'), {
    schemaVersion: 'jinn.prediction_corpus_retrieval.v1',
    retrievalUsed: opts.retrievalUsed ?? recordsUsed.length > 0,
    queries: [
      {
        tool: 'search_records',
        intent: 'exact-condition',
        query: 'solverType:prediction.v1 conditionId:0xabc venue:polymarket',
      },
    ],
    records: {
      considered: recordsConsidered,
      inspected: inspectedRefs,
      cited: recordsCited,
      used: recordsUsed,
    },
    acquiredArtifacts: opts.acquiredArtifacts ?? [],
    forecast: {
      probabilityYes: opts.probabilityYes ?? '0.62',
      consensusSnapshotRef: opts.consensusSnapshotRef ?? 'task.spec.consensusSnapshot',
    },
    selfAssessment: {
      affectedForecast: opts.affectedForecast ?? recordsUsed.length > 0,
      summary: recordsUsed.length > 0
        ? 'Prior scored records affected calibration.'
        : 'Retrieval was attempted but no useful records were found.',
    },
  });
}

export function fakePredictionV1Solution(
  workingDir: string,
  opts: {
    probabilityYes?: string;
    submittedAt?: string;
    modelId?: string;
    confidence?: string;
    methodology?: string;
    sourceRefs?: Array<{ title: string; url: string }>;
  } = {},
): void {
  writeJson(join(workingDir, '.execute', 'prediction-v1-solution.json'), {
    schemaVersion: 'jinn.prediction_v1_restoration_payload.v1',
    probabilityYes: opts.probabilityYes ?? '0.62',
    submittedAt: opts.submittedAt ?? '2026-05-02T01:00:00.000Z',
    modelId: opts.modelId ?? 'claude-code-learner/prediction-v1-test',
    confidence: opts.confidence ?? 'medium',
    methodology: opts.methodology ?? 'Test fixture for the learner-authored prediction.v1 Execute output.',
    sourceRefs: opts.sourceRefs ?? [
      {
        title: 'Polymarket market',
        url: 'https://polymarket.com/event/test-market',
      },
    ],
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

export function fakeLearnerFeedback(
  workingDir: string,
  opts: {
    recordsConsidered?: string[];
    recordsCited?: string[];
    recordsUsed?: string[];
    acquiredArtifacts?: Array<Record<string, unknown>>;
    solverBrier?: string;
    consensusBrier?: string;
    brierSpread?: string;
  } = {},
): void {
  writeJson(join(workingDir, '.debrief', 'learner-feedback.json'), {
    schemaVersion: 'jinn.learner_feedback.v1',
    task: { solverType: 'prediction.v1' },
    skillsUsed: ['prediction-corpus-retrieval'],
    toolsUsed: ['get_task', 'search_records', 'inspect_record'],
    retrieval: {
      queries: [
        { tool: 'search_records', intent: 'similar-scored-verdicts', query: 'prediction.v1 scored verdict' },
      ],
      recordsConsidered: opts.recordsConsidered ?? [],
      recordsCited: opts.recordsCited ?? [],
      recordsUsed: opts.recordsUsed ?? opts.recordsCited ?? [],
      acquiredArtifacts: opts.acquiredArtifacts ?? [],
    },
    forecast: {
      probabilityYes: '0.62',
      consensusSnapshotRef: 'task.spec.consensusSnapshot',
    },
    selfAssessment: {
      affectedForecast: (opts.recordsUsed ?? opts.recordsCited ?? []).length > 0,
      summary: 'Captured learner-facing evidence for future strategy analysis.',
    },
    verdictFeedback: {
      verdictRef: 'verdict:prediction-v1:example',
      solverBrier: opts.solverBrier ?? '0.144400',
      consensusBrier: opts.consensusBrier ?? '0.184900',
      brierSpread: opts.brierSpread ?? '-0.040500',
    },
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
