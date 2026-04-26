import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harvestOutput } from '../../../../src/restorer/impls/default-learner/harvest.js';

describe('harvestOutput', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-harvest-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function writePhaseArtifact(phase: string, fileName: string, payload: unknown): void {
    const dir = join(workingDir, `.${phase}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), JSON.stringify(payload, null, 2));
  }

  it('returns minimal RestorationOutput when no phase artifacts present', () => {
    const out = harvestOutput(workingDir);
    expect(out.venueRef.name).toEqual('default-learner');
    expect(out.gating).toMatchObject({ phasesCompleted: [] });
  });

  it('reports phasesCompleted from per-phase output presence', () => {
    writePhaseArtifact('orient', 'summary.json', { topics: [] });
    writePhaseArtifact('strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact('plan', 'plan.json', { steps: [] });
    writePhaseArtifact('execute', 'summary.json', { stepsCompleted: ['step-1'] });
    const out = harvestOutput(workingDir);
    expect(out.gating).toMatchObject({
      phasesCompleted: ['orient', 'strategize', 'plan', 'execute'],
    });
  });

  it('lifts execute summary fields into gating when present', () => {
    writePhaseArtifact('execute', 'summary.json', {
      stepsCompleted: ['step-1', 'step-2'],
      stepsFailed: [],
      returnReason: 'all-steps-completed',
      elapsedMs: 12345,
    });
    const out = harvestOutput(workingDir);
    expect(out.gating).toMatchObject({
      executeReturnReason: 'all-steps-completed',
      executeStepsCompleted: 2,
      executeStepsFailed: 0,
    });
  });

  it('lifts strategize timingPosture into gating when present', () => {
    writePhaseArtifact('strategize', 'strategy.json', {
      approach: 'foo',
      timingPosture: 'hold-and-revise',
    });
    const out = harvestOutput(workingDir);
    expect(out.gating.timingPosture).toEqual('hold-and-revise');
  });

  it('reports debrief.successCriteriaMet into gating when present', () => {
    writePhaseArtifact('debrief', 'analysis.json', {
      successCriteriaMet: 'partial',
    });
    const out = harvestOutput(workingDir);
    expect(out.gating.debriefVerdict).toEqual('partial');
  });

  it('does not throw on malformed phase JSON; falls back gracefully', () => {
    const dir = join(workingDir, '.execute');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), 'not-json{');
    expect(() => harvestOutput(workingDir)).not.toThrow();
  });
});
