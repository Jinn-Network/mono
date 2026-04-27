import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  harvestOutput,
  requiredReadJson,
} from '../../../../src/restorer/impls/claude-code-learner/harvest.js';

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
    delete process.env.JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE;
  });

  // ── Required artifact validation ────────────────────────────────────────────

  it('throws when a required phase artifact is missing (full range — orient)', () => {
    // Write all phases except orient.
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    writePhaseArtifact(workingDir, 'execute', 'summary.json', { stepsCompleted: [] });
    writePhaseArtifact(workingDir, 'debrief', 'analysis.json', { successCriteriaMet: 'yes' });
    writePhaseArtifact(workingDir, 'improve', 'summary.json', { changesAccepted: 0 });
    writePhaseArtifact(workingDir, 'memory-consolidation', 'consolidation_record.json', {});
    expect(() => harvestOutput(workingDir, 'full')).toThrow();
  });

  it('throws when a required phase artifact contains corrupt JSON (full range — orient)', () => {
    writeFullPipeline(workingDir);
    writeFileSync(join(workingDir, '.orient', 'summary.json'), 'corrupt{{{');
    expect(() => harvestOutput(workingDir, 'full')).toThrow();
  });

  it('throws when a required phase artifact is missing (pre-execute range — orient)', () => {
    // Strategize and plan present; orient missing.
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    expect(() => harvestOutput(workingDir, 'pre-execute')).toThrow();
  });

  it('throws when a required phase artifact is missing (post-execute range — debrief)', () => {
    // Improve and memory-consolidation present; debrief missing.
    writePhaseArtifact(workingDir, 'improve', 'summary.json', { changesAccepted: 0 });
    writePhaseArtifact(workingDir, 'memory-consolidation', 'consolidation_record.json', {});
    expect(() => harvestOutput(workingDir, 'post-execute')).toThrow();
  });

  it('succeeds when all required phase artifacts are present (full range)', () => {
    writeFullPipeline(workingDir);
    expect(() => harvestOutput(workingDir, 'full')).not.toThrow();
  });

  it('succeeds when all required phase artifacts are present (pre-execute range)', () => {
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    expect(() => harvestOutput(workingDir, 'pre-execute')).not.toThrow();
  });

  it('succeeds when all required phase artifacts are present (post-execute range)', () => {
    writePhaseArtifact(workingDir, 'debrief', 'analysis.json', { successCriteriaMet: 'yes' });
    writePhaseArtifact(workingDir, 'improve', 'summary.json', { changesAccepted: 0 });
    writePhaseArtifact(workingDir, 'memory-consolidation', 'consolidation_record.json', {});
    expect(() => harvestOutput(workingDir, 'post-execute')).not.toThrow();
  });

  // ── Optional artifact handling (warn, don't throw) ──────────────────────────

  it('does not throw when optional artifact is absent; logs a warning', () => {
    // In pre-execute range, execute is optional.
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => harvestOutput(workingDir, 'pre-execute')).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not throw when optional artifact is corrupt; logs a warning (reframes malformed-JSON test)', () => {
    // In pre-execute range, execute is optional — corrupt execute summary must warn, not throw.
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    const dir = join(workingDir, '.execute');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), 'not-json{');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => harvestOutput(workingDir, 'pre-execute')).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── Phase range from env var ────────────────────────────────────────────────

  it('reads JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE from env when phaseRange arg not provided', () => {
    process.env.JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE = 'pre-execute';
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    // pre-execute only needs orient/strategize/plan; should succeed
    expect(() => harvestOutput(workingDir)).not.toThrow();
  });

  it('defaults to full range when JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE is not set', () => {
    delete process.env.JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE;
    // Only pre-execute phases present — full range requires all 7
    writePhaseArtifact(workingDir, 'orient', 'summary.json', { topics: [] });
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', { approach: 'a' });
    writePhaseArtifact(workingDir, 'plan', 'plan.json', { steps: [] });
    expect(() => harvestOutput(workingDir)).toThrow();
  });

  // ── Gating field extraction ────────────────────────────────────────────────

  it('reports phasesCompleted from per-phase output presence', () => {
    writeFullPipeline(workingDir);
    const out = harvestOutput(workingDir, 'full');
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

  it('lifts execute summary fields into gating when present', () => {
    writeFullPipeline(workingDir);
    writePhaseArtifact(workingDir, 'execute', 'summary.json', {
      stepsCompleted: ['step-1', 'step-2'],
      stepsFailed: [],
      returnReason: 'all-steps-completed',
      elapsedMs: 12345,
    });
    const out = harvestOutput(workingDir, 'full');
    expect(out.gating).toMatchObject({
      executeReturnReason: 'all-steps-completed',
      executeStepsCompleted: 2,
      executeStepsFailed: 0,
    });
  });

  it('lifts strategize timingPosture into gating when present', () => {
    writeFullPipeline(workingDir);
    writePhaseArtifact(workingDir, 'strategize', 'strategy.json', {
      approach: 'foo',
      timingPosture: 'hold-and-revise',
    });
    const out = harvestOutput(workingDir, 'full');
    expect(out.gating.timingPosture).toEqual('hold-and-revise');
  });

  it('reports debrief.successCriteriaMet into gating when present', () => {
    writeFullPipeline(workingDir);
    writePhaseArtifact(workingDir, 'debrief', 'analysis.json', {
      successCriteriaMet: 'partial',
    });
    const out = harvestOutput(workingDir, 'full');
    expect(out.gating.debriefVerdict).toEqual('partial');
  });

  it('returns correct venueRef', () => {
    writeFullPipeline(workingDir);
    const out = harvestOutput(workingDir, 'full');
    expect(out.venueRef.name).toEqual('claude-code-learner');
  });
});
