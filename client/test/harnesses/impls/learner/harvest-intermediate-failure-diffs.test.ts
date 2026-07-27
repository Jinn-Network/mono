import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harvestOutput } from '../../../../src/harnesses/impls/learner/harvest.js';

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

function writeTypedPayload(workingDir: string, payload: Record<string, unknown>): void {
  const dir = join(workingDir, '.execute');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'solution-payload.json'), JSON.stringify(payload, null, 2));
}

function writeIfd(workingDir: string, diffs: unknown): void {
  const dir = join(workingDir, '.execute');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'intermediate-failure-diffs.json'), JSON.stringify(diffs));
}

describe('harvestOutput — intermediateFailureDiffs (#2230)', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-harvest-ifd-'));
    writeFullPipeline(workingDir);
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('sets intermediateFailureDiffs from durable file on typed-payload harvest', async () => {
    writeTypedPayload(workingDir, {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+new\n',
    });
    writeIfd(workingDir, ['diff --git a/x b/x\n+failed\n']);

    const out = await harvestOutput(workingDir, 'solve-only', {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    expect(out.intermediateFailureDiffs).toEqual(['diff --git a/x b/x\n+failed\n']);
  });

  it('omits the field when the durable file is absent', async () => {
    writeTypedPayload(workingDir, {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+new\n',
    });

    const out = await harvestOutput(workingDir, 'solve-only', {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    expect(out.intermediateFailureDiffs).toBeUndefined();
  });

  it('omits the field when the durable file is empty or only empties', async () => {
    writeTypedPayload(workingDir, {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+new\n',
    });
    writeIfd(workingDir, ['', '']);

    const out = await harvestOutput(workingDir, 'solve-only', {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    expect(out.intermediateFailureDiffs).toBeUndefined();
  });

  it('omits the field when the durable file is malformed', async () => {
    writeTypedPayload(workingDir, {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+new\n',
    });
    mkdirSync(join(workingDir, '.execute'), { recursive: true });
    writeFileSync(join(workingDir, '.execute', 'intermediate-failure-diffs.json'), '{not-json');

    const out = await harvestOutput(workingDir, 'solve-only', {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    expect(out.intermediateFailureDiffs).toBeUndefined();
  });

  it('attaches on gating-only harvest (no typed payload)', async () => {
    writeIfd(workingDir, ['diff A']);
    const out = await harvestOutput(workingDir, 'full');
    expect(out.intermediateFailureDiffs).toEqual(['diff A']);
    expect(out.solutionPayload).toBeUndefined();
  });
});
