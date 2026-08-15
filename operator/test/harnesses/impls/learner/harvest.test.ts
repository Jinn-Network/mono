import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  harvestOutput,
  requiredReadJson,
} from '../../../../src/harnesses/impls/learner/harvest.js';
import {
  fakeLearnerFeedback,
  fakePredictionCorpusRetrieval,
  fakePredictionV1Solution,
} from '../../../../src/harnesses/impls/learner/test-utils/fake-plugin-outputs.js';
import { makePredictionV1Task } from '../prediction-v1-test-helpers.js';

function writePhaseArtifact(workingDir: string, phase: string, fileName: string, payload: unknown): void {
  const dir = join(workingDir, `.${phase}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), JSON.stringify(payload, null, 2));
}

function writeFullPipeline(workingDir: string): void {
  writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
  writePhaseArtifact(workingDir, 'strategize', 'strategy.json', {
    approach: 'a',
    timingPosture: 'early-return',
  });
  writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
  writePhaseArtifact(workingDir, 'execute', 'summary.json', {
    stepsCompleted: ['step-1'],
    stepsFailed: [],
    returnReason: 'all-steps-completed',
    elapsedMs: 100,
  });
  writePhaseArtifact(workingDir, 'debrief', 'analysis.json', { successCriteriaMet: 'yes' });
  writePhaseArtifact(workingDir, 'improve', 'summary.json', { changesAccepted: 0 });
  writePhaseArtifact(workingDir, 'memory-consolidation', 'consolidation_record.json', {
    durable: {},
    ephemeral: {},
  });
}

// ── requiredReadJson ──────────────────────────────────────────────────────────

describe('requiredReadJson', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jinn-req-read-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when file is missing', () => {
    const path = join(tmpDir, 'nonexistent.json');
    expect(() => requiredReadJson(path)).toThrow();
  });

  it('throws when file contains invalid JSON', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, 'not-valid-json{{{');
    expect(() => requiredReadJson(path)).toThrow();
  });

  it('returns parsed object when file contains valid JSON', () => {
    const path = join(tmpDir, 'good.json');
    writeFileSync(path, JSON.stringify({ foo: 'bar' }));
    expect(requiredReadJson(path)).toEqual({ foo: 'bar' });
  });
});

// ── harvestOutput ─────────────────────────────────────────────────────────────

describe('harvestOutput', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-harvest-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.LEARNER_PHASE_RANGE;
  });

  // ── Required artifact validation ────────────────────────────────────────────

  it('throws when a required phase artifact is missing (full range — orient)', async () => {
    // Write all phases except orient.
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    writePhaseArtifact(workingDir, 'execute', 'summary.json', { stepsCompleted: [] });
    writePhaseArtifact(workingDir, 'debrief', 'analysis.json', { successCriteriaMet: 'yes' });
    writePhaseArtifact(workingDir, 'improve', 'summary.json', { changesAccepted: 0 });
    writePhaseArtifact(workingDir, 'memory-consolidation', 'consolidation_record.json', {});
    await expect(harvestOutput(workingDir, 'full')).rejects.toThrow();
  });

  it('throws when a required phase artifact contains corrupt JSON (full range — orient)', async () => {
    writeFullPipeline(workingDir);
    writeFileSync(join(workingDir, '.orient', 'summary.json'), 'corrupt{{{');
    await expect(harvestOutput(workingDir, 'full')).rejects.toThrow();
  });

  it('throws when a required phase artifact is missing (pre-execute range — orient)', async () => {
    // Strategize and plan present; orient missing.
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    await expect(harvestOutput(workingDir, 'pre-execute')).rejects.toThrow();
  });

  it('throws when a required phase artifact is missing (post-execute range — debrief)', async () => {
    // Improve and memory-consolidation present; debrief missing.
    writePhaseArtifact(workingDir, 'improve', 'summary.json', { changesAccepted: 0 });
    writePhaseArtifact(workingDir, 'memory-consolidation', 'consolidation_record.json', {});
    await expect(harvestOutput(workingDir, 'post-execute')).rejects.toThrow();
  });

  it('succeeds when all required phase artifacts are present (full range)', async () => {
    writeFullPipeline(workingDir);
    await expect(harvestOutput(workingDir, 'full')).resolves.toBeDefined();
  });

  it('succeeds when all required phase artifacts are present (pre-execute range)', async () => {
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    await expect(harvestOutput(workingDir, 'pre-execute')).resolves.toBeDefined();
  });

  it('succeeds when all required phase artifacts are present (post-execute range)', async () => {
    writePhaseArtifact(workingDir, 'debrief', 'analysis.json', { successCriteriaMet: 'yes' });
    writePhaseArtifact(workingDir, 'improve', 'summary.json', { changesAccepted: 0 });
    writePhaseArtifact(workingDir, 'memory-consolidation', 'consolidation_record.json', {});
    await expect(harvestOutput(workingDir, 'post-execute')).resolves.toBeDefined();
  });

  // ── solve-only range (frozen mode — no learning-phase artifacts) ────────────

  it('solve-only: requires NO phase artifacts (empty workingDir does not throw)', async () => {
    // Frozen mode skips the learning phases (improve, memory-consolidation), so
    // requiring any phase artifacts is wrong. solve-only requires none.
    await expect(harvestOutput(workingDir, 'solve-only')).resolves.toBeDefined();
  });

  it('solve-only: still returns the swe-rebench patch when a repo diff is present', async () => {
    const repoDir = join(workingDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'example.py'), 'old = True\n');
    execFileSync('git', ['add', 'example.py'], { cwd: repoDir });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'example.py'), 'old = False\n');

    const out = await harvestOutput(workingDir, 'solve-only', {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    expect(out.solutionPayload).toMatchObject({ schemaVersion: 'swe-rebench-v2-solution.v1' });
    expect((out.solutionPayload as Record<string, unknown>).patch).toContain('old = False');
  });

  // ── Empty run — no payload, no phase artifacts (#814) ───────────────────────

  it('empty run: no typed payload and no phase artifacts — names the missing deliverable, not .orient/summary.json', async () => {
    // The harness produced nothing: no solution-payload.json and no phase dirs.
    // The error must be deliverable-oriented, not phase-telemetry-oriented.
    await expect(harvestOutput(workingDir, 'full')).rejects.toThrow(/appears empty/);
    await expect(harvestOutput(workingDir, 'full')).rejects.not.toThrow(/\.orient\/summary\.json/);
  });

  it('partial run: some phase artifacts present but a required primary missing — still throws Required artifact missing', async () => {
    // A non-required phase (orient) produced artifacts, so the run is not empty,
    // but post-execute requires debrief whose primary artifact is absent.
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    const requiredPath = join(workingDir, '.debrief', 'analysis.json');
    await expect(harvestOutput(workingDir, 'post-execute')).rejects.toThrow(
      `Required artifact missing: ${requiredPath}`,
    );
  });

  // ── Optional artifact handling (warn, don't throw) ──────────────────────────

  it('does not throw when optional artifact is absent; logs a warning', async () => {
    // In pre-execute range, execute is optional.
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(harvestOutput(workingDir, 'pre-execute')).resolves.toBeDefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not throw when optional artifact is corrupt; logs a warning (reframes malformed-JSON test)', async () => {
    // In pre-execute range, execute is optional — corrupt execute summary must warn, not throw.
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    const dir = join(workingDir, '.execute');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), 'not-json{');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(harvestOutput(workingDir, 'pre-execute')).resolves.toBeDefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── Phase range from env var ────────────────────────────────────────────────

  it('reads LEARNER_PHASE_RANGE from env when phaseRange arg not provided', async () => {
    process.env.LEARNER_PHASE_RANGE = 'pre-execute';
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    // pre-execute only needs orient/strategize/plan; should succeed
    await expect(harvestOutput(workingDir)).resolves.toBeDefined();
  });

  it('defaults to full range when LEARNER_PHASE_RANGE is not set', async () => {
    delete process.env.LEARNER_PHASE_RANGE;
    // Only pre-execute phases present — full range requires all 7
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    await expect(harvestOutput(workingDir)).rejects.toThrow();
  });

  // ── Gating field extraction ────────────────────────────────────────────────

  it('reports phasesCompleted from per-phase output presence', async () => {
    writeFullPipeline(workingDir);
    const out = await harvestOutput(workingDir, 'full');
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
    });
  });

  it('lifts execute summary fields into gating when present', async () => {
    writeFullPipeline(workingDir);
    writePhaseArtifact(workingDir, 'execute', 'summary.json', {
      stepsCompleted: ['step-1', 'step-2'],
      stepsFailed: [],
      returnReason: 'all-steps-completed',
      elapsedMs: 12345,
    });
    const out = await harvestOutput(workingDir, 'full');
    expect(out.gating).toMatchObject({
      executeReturnReason: 'all-steps-completed',
      executeStepsCompleted: 2,
      executeStepsFailed: 0,
    });
  });

  it('lifts strategize timingPosture into gating when present', async () => {
    writeFullPipeline(workingDir);
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', {
      approach: 'foo',
      timingPosture: 'hold-and-revise',
    });
    const out = await harvestOutput(workingDir, 'full');
    expect(out.gating.timingPosture).toEqual('hold-and-revise');
  });

  it('reports debrief.successCriteriaMet into gating when present', async () => {
    writeFullPipeline(workingDir);
    writePhaseArtifact(workingDir, 'debrief', 'analysis.json', {
      successCriteriaMet: 'partial',
    });
    const out = await harvestOutput(workingDir, 'full');
    expect(out.gating.debriefVerdict).toEqual('partial');
  });

  it('returns correct venueRef', async () => {
    writeFullPipeline(workingDir);
    const out = await harvestOutput(workingDir, 'full');
    expect(out.venueRef.name).toEqual('claude-code-learner');
  });

  // -- prediction.v1 typed solution harvesting --------------------------------

  it('requires learner-authored prediction.v1 solution output for prediction tasks', async () => {
    writeFullPipeline(workingDir);
    await expect(harvestOutput(workingDir, 'full', makePredictionV1Task())).rejects.toThrow(
      /prediction\.v1 learner solution missing/,
    );
  });

  it('harvests learner-authored prediction.v1 solution payload and artifact metadata', async () => {
    writeFullPipeline(workingDir);
    fakePredictionV1Solution(workingDir, {
      probabilityYes: '62%',
      submittedAt: '2026-05-02T01:00:00.000Z',
      modelId: 'claude-code-learner/prediction-v1-test',
      confidence: 'high',
    });

    const out = await harvestOutput(workingDir, 'full', makePredictionV1Task());

    expect(out.venueRef.name).toEqual('claude-code-learner');
    expect(out.solutionPayload).toMatchObject({
      probabilityYes: '0.6200',
      submittedAt: '2026-05-02T01:00:00.000Z',
      format: 'decimal',
      modelId: 'claude-code-learner/prediction-v1-test',
      confidence: 'high',
      methodology: 'Test fixture for the learner-authored prediction.v1 Execute output.',
      sourceRefs: [
        {
          title: 'Polymarket market',
          url: 'https://polymarket.com/event/test-market',
        },
      ],
    });
    expect(out.gating).toMatchObject({
      probabilityYes: '0.6200',
      submittedAt: '2026-05-02T01:00:00.000Z',
      modelId: 'claude-code-learner/prediction-v1-test',
      phasesCompleted: [
        'orient',
        'strategize',
        'plan',
        'execute',
        'debrief',
        'improve',
        'memory-consolidation',
      ],
    });
    expect(out.informational).toMatchObject({
      source: makePredictionV1Task().spec.source,
      consensusSnapshot: makePredictionV1Task().spec.consensusSnapshot,
    });
    expect(out.artifacts).toEqual([
      expect.objectContaining({
        path: '.execute/prediction-v1-solution.json',
        artifactType: 'prediction_v1_solution',
        tags: expect.arrayContaining(['prediction', 'solution', 'learner-output']),
        access: { priceUsdc: '0' },
        metadata: expect.objectContaining({
          schema: 'jinn.prediction_v1_restoration_payload.v1',
          source: 'agent-authored',
        }),
      }),
    ]);
  });

  // ── Optional learner feedback artifacts ───────────────────────────────────

  it('does not invent learner feedback artifacts when retrieval output is absent', async () => {
    writeFullPipeline(workingDir);
    const out = await harvestOutput(workingDir, 'full');
    expect(out.artifacts ?? []).toEqual([]);
    expect(out.informational?.learnerFeedbackArtifacts).toBeUndefined();
  });

  it('harvests prediction corpus retrieval attempts with no results', async () => {
    writeFullPipeline(workingDir);
    fakePredictionCorpusRetrieval(workingDir, {
      retrievalUsed: false,
      recordsConsidered: [],
      recordsCited: [],
      recordsUsed: [],
      inspectedRefs: [],
      affectedForecast: false,
    });

    const out = await harvestOutput(workingDir, 'full');
    expect(out.artifacts).toEqual([
      expect.objectContaining({
        path: '.execute/prediction-corpus-retrieval.json',
        artifactType: 'prediction_corpus_retrieval',
        tags: expect.arrayContaining(['learner-feedback', 'prediction', 'corpus-retrieval']),
        access: { priceUsdc: '0' },
        metadata: expect.objectContaining({
          schema: 'jinn.prediction_corpus_retrieval.v1',
          source: 'agent-authored',
          queries: 1,
          recordsConsidered: 0,
          recordsCited: 0,
          recordsUsed: 0,
          inspectedRefs: 0,
          acquiredArtifacts: 0,
          retrievalUsed: false,
          affectedForecast: false,
        }),
      }),
    ]);
  });

  it('harvests cited and used prediction corpus record refs without ranking in the Harness', async () => {
    writeFullPipeline(workingDir);
    fakePredictionCorpusRetrieval(workingDir, {
      recordsConsidered: ['record:older', 'record:same-condition'],
      recordsCited: ['record:same-condition'],
      recordsUsed: ['record:same-condition'],
      inspectedRefs: ['projection:same-condition'],
      affectedForecast: true,
    });

    const out = await harvestOutput(workingDir, 'full');
    expect(out.artifacts?.[0]).toMatchObject({
      path: '.execute/prediction-corpus-retrieval.json',
      metadata: {
        recordsConsidered: 2,
        recordsCited: 1,
        recordsUsed: 1,
        inspectedRefs: 1,
        affectedForecast: true,
      },
    });
    expect(requiredReadJson(join(workingDir, '.execute', 'prediction-corpus-retrieval.json'))).toMatchObject({
      records: {
        cited: ['record:same-condition'],
        used: ['record:same-condition'],
      },
    });
  });

  it('preserves explicit acquisition and payment metadata authored by the agent', async () => {
    writeFullPipeline(workingDir);
    fakePredictionCorpusRetrieval(workingDir, {
      recordsConsidered: ['record:paid-context'],
      recordsCited: ['record:paid-context'],
      acquiredArtifacts: [
        {
          artifactRef: 'artifact:paid-analysis',
          priceUsdc: '0.25',
          acquisition: {
            tool: 'acquire_artifact',
            status: 'paid',
            txHash: '0xabc123',
          },
          reason: 'Needed full prior reasoning to resolve an ambiguity.',
        },
      ],
    });

    const out = await harvestOutput(workingDir, 'full');
    expect(out.artifacts?.[0].metadata).toMatchObject({
      acquiredArtifacts: 1,
    });
    expect(requiredReadJson(join(workingDir, '.execute', 'prediction-corpus-retrieval.json'))).toMatchObject({
      acquiredArtifacts: [
        {
          priceUsdc: '0.25',
          acquisition: {
            tool: 'acquire_artifact',
            status: 'paid',
            txHash: '0xabc123',
          },
        },
      ],
    });
  });

  it('harvests verdict-linked generic learner feedback when debrief writes it', async () => {
    writeFullPipeline(workingDir);
    fakeLearnerFeedback(workingDir, {
      recordsConsidered: ['record:a', 'record:b'],
      recordsCited: ['record:b'],
      recordsUsed: ['record:b'],
      solverBrier: '0.144400',
      consensusBrier: '0.184900',
      brierSpread: '-0.040500',
    });

    const out = await harvestOutput(workingDir, 'full');
    expect(out.artifacts).toEqual([
      expect.objectContaining({
        path: '.debrief/learner-feedback.json',
        artifactType: 'learner_feedback',
        metadata: expect.objectContaining({
          schema: 'jinn.learner_feedback.v1',
          queries: 1,
          recordsConsidered: 2,
          recordsCited: 1,
          recordsUsed: 1,
          acquiredArtifacts: 0,
          hasVerdictFeedback: true,
        }),
      }),
    ]);
    expect(out.informational?.learnerFeedbackArtifacts).toEqual([
      expect.objectContaining({
        path: '.debrief/learner-feedback.json',
        artifactType: 'learner_feedback',
      }),
    ]);
  });
});

// ── Generic typed-payload path (submit_typed_payload MCP tool) ───────────────

describe('harvestOutput — generic typed-payload path', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-harvest-typed-'));
    writeFullPipeline(workingDir);
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function writeTypedPayload(payload: Record<string, unknown>): void {
    const dir = join(workingDir, '.execute');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'solution-payload.json'), JSON.stringify(payload, null, 2));
  }

  it('reads .execute/solution-payload.json when solverType is not prediction.v1 (restoration role)', async () => {
    const swePayload = {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+new\n',
    };
    writeTypedPayload(swePayload);

    const out = await harvestOutput(workingDir, undefined, {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    expect(out.solutionPayload).toEqual(swePayload);
    expect(out.verdictPayload).toBeUndefined();
    const swArtifact = out.artifacts?.find(
      (a) => a.path === '.execute/solution-payload.json',
    );
    expect(swArtifact?.artifactType).toBe('swe-rebench-v2_v1_solution');
    expect(swArtifact?.metadata).toMatchObject({
      schemaVersion: 'swe-rebench-v2-solution.v1',
      source: 'agent-authored',
      solverType: 'swe-rebench-v2.v1',
    });
  });

  it('does not fail typed-payload harvest when learner execute summary is missing', async () => {
    rmSync(join(workingDir, '.execute', 'summary.json'), { force: true });
    const swePayload = {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+new\n',
    };
    writeTypedPayload(swePayload);

    const out = await harvestOutput(workingDir, undefined, {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    expect(out.solutionPayload).toEqual(swePayload);
    expect(out.gating).toMatchObject({
      phasesCompleted: expect.arrayContaining(['execute']),
    });
  });

  it('normalizes a direct SWE patch-only payload before validation', async () => {
    const patch = 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+new\n';
    writeTypedPayload({ patch });

    const out = await harvestOutput(workingDir, undefined, {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    expect(out.solutionPayload).toEqual({
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch,
    });
    const payloadPath = join(workingDir, '.execute', 'solution-payload.json');
    expect(JSON.parse(readFileSync(payloadPath, 'utf8'))).toEqual(out.solutionPayload);
  });

  it('rejects malformed direct SWE typed payloads at harvest time', async () => {
    writeTypedPayload({
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: '',
    });

    await expect(
      harvestOutput(workingDir, undefined, {
        id: 'task-1',
        description: 'd',
        solverType: 'swe-rebench-v2.v1',
        role: 'restoration',
      } as never),
    ).rejects.toThrow(/failed swe-rebench-v2\.v1\/solution validation/);
  });

  it('rejects corrupt direct typed payload files at harvest time', async () => {
    const dir = join(workingDir, '.execute');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'solution-payload.json'), '{');

    await expect(
      harvestOutput(workingDir, undefined, {
        id: 'task-1',
        description: 'd',
        solverType: 'swe-rebench-v2.v1',
        role: 'restoration',
      } as never),
    ).rejects.toThrow(/invalid JSON in typed payload/);
  });

  it('reads typed payload as verdictPayload for evaluation role', async () => {
    const verdict = {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: 1,
      passed_match: true,
      evaluator_cost_usd: 0,
    };
    writeTypedPayload(verdict);

    const out = await harvestOutput(workingDir, undefined, {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'evaluation',
    } as never);

    expect(out.verdictPayload).toEqual(verdict);
    expect(out.solutionPayload).toBeUndefined();
    const swArtifact = out.artifacts?.find(
      (a) => a.path === '.execute/solution-payload.json',
    );
    expect(swArtifact?.artifactType).toBe('swe-rebench-v2_v1_verdict');
  });

  it('materializes a swe-rebench restoration payload from repo diff when phase summaries are absent', async () => {
    rmSync(workingDir, { recursive: true, force: true });
    mkdirSync(workingDir, { recursive: true });
    const repoDir = join(workingDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'example.py'), 'old = True\n');
    execFileSync('git', ['add', 'example.py'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'example.py'), 'old = False\n');

    const out = await harvestOutput(workingDir, undefined, {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    expect(out.solutionPayload).toMatchObject({
      schemaVersion: 'swe-rebench-v2-solution.v1',
    });
    expect((out.solutionPayload as Record<string, unknown>).patch).toContain('old = True');
    expect((out.solutionPayload as Record<string, unknown>).patch).toContain('old = False');
    const payloadPath = join(workingDir, '.execute', 'solution-payload.json');
    expect(existsSync(payloadPath)).toBe(true);
    expect(JSON.parse(readFileSync(payloadPath, 'utf8'))).toEqual(out.solutionPayload);
  });

  function makeRepoWithDiff(workingDir: string): string {
    const repoDir = join(workingDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'example.py'), 'old = True\n');
    mkdirSync(join(repoDir, 'tests'), { recursive: true });
    writeFileSync(join(repoDir, 'tests', 'test_example.py'), 'def test_old():\n    assert True\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repoDir });
    // The model edits the source AND adds a regression test (normal agent behaviour).
    writeFileSync(join(repoDir, 'example.py'), 'old = False\n');
    writeFileSync(
      join(repoDir, 'tests', 'test_example.py'),
      'def test_old():\n    assert True\n\ndef test_new():\n    assert True\n',
    );
    return repoDir;
  }

  it('strips test-file changes from the materialized git-diff restoration patch', async () => {
    rmSync(workingDir, { recursive: true, force: true });
    mkdirSync(workingDir, { recursive: true });
    makeRepoWithDiff(workingDir);

    const out = await harvestOutput(workingDir, undefined, {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    const patch = (out.solutionPayload as Record<string, unknown>).patch as string;
    expect(patch).toContain('example.py');
    expect(patch).toContain('old = False');
    expect(patch).not.toContain('tests/test_example.py');
    expect(patch).not.toContain('test_new');
  });

  it('prefers the git-diff harvest over a stale agent-authored solution-payload.json for swe-rebench restoration', async () => {
    rmSync(workingDir, { recursive: true, force: true });
    mkdirSync(workingDir, { recursive: true });
    makeRepoWithDiff(workingDir);
    const dir = join(workingDir, '.execute');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'solution-payload.json'),
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-solution.v1',
        patch: 'diff --git a/STALE.py b/STALE.py\n--- a/STALE.py\n+++ b/STALE.py\n@@ -1 +1 @@\n-x\n+y\n',
      }),
    );

    const out = await harvestOutput(workingDir, undefined, {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    const patch = (out.solutionPayload as Record<string, unknown>).patch as string;
    expect(patch).toContain('example.py');
    expect(patch).not.toContain('STALE');
  });

  it('falls through to phase-artifact-only shape when no typed payload was submitted', async () => {
    // No .execute/solution-payload.json written.
    const out = await harvestOutput(workingDir, undefined, {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    expect(out.solutionPayload).toBeUndefined();
    expect(out.verdictPayload).toBeUndefined();
    expect(out.gating).toBeDefined();
  });

  it('accepts arbitrary solution-payload.json when task has no solverType (learner-full-cycle smoke)', async () => {
    const genericPayload = { foo: 'world', bar: 'world', baz: 'world' };
    writeTypedPayload(genericPayload);

    const out = await harvestOutput(workingDir, undefined, {
      id: 'task-1',
      description: 'write output.json',
      role: 'restoration',
    } as never);

    expect(out.solutionPayload).toEqual(genericPayload);
    const artifact = out.artifacts?.find((a) => a.path === '.execute/solution-payload.json');
    expect(artifact?.artifactType).toBe('learner_solution');
    expect(artifact?.metadata?.solverType).toBeUndefined();
  });

  it('rejects portfolio-shaped payloads only when solverType is portfolio.v0', async () => {
    writeTypedPayload({ foo: 'world', bar: 'world', baz: 'world' });

    await expect(
      harvestOutput(workingDir, undefined, {
        id: 'task-1',
        description: 'd',
        solverType: 'portfolio.v0',
        role: 'restoration',
      } as never),
    ).rejects.toThrow(/failed portfolio\.v0\/solution validation/);
  });
});
