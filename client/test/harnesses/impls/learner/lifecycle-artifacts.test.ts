import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectLearnerTerminalEvidence,
  requiredLearnerPhases,
  resolveLearnerPhaseRange,
} from '../../../../src/harnesses/impls/learner/lifecycle-artifacts.js';

const primaryArtifacts = {
  orient: 'summary.json',
  strategize: 'strategy.json',
  plan: 'plan.json',
  execute: 'summary.json',
  debrief: 'analysis.json',
  improve: 'summary.json',
  'memory-consolidation': 'consolidation_record.json',
} as const;

type TestPhase = keyof typeof primaryArtifacts;

function writeJsonObject(path: string, payload: Record<string, unknown> = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload));
}

function writePhases(workingDir: string, phases: readonly TestPhase[]): void {
  for (const phase of phases) {
    writeJsonObject(join(workingDir, `.${phase}`, primaryArtifacts[phase]));
  }
}

describe('learner lifecycle artifact contract', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-learner-lifecycle-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it.each([
    {
      range: 'full',
      mode: 'train' as const,
      required: [
        'orient',
        'strategize',
        'plan',
        'execute',
        'debrief',
        'improve',
        'memory-consolidation',
      ],
    },
    {
      range: 'full',
      mode: 'frozen' as const,
      required: ['orient', 'strategize', 'plan', 'execute', 'debrief'],
    },
    {
      range: 'pre-execute',
      mode: 'train' as const,
      required: ['orient', 'strategize', 'plan'],
    },
    {
      range: 'post-execute',
      mode: 'train' as const,
      required: ['debrief', 'improve', 'memory-consolidation'],
    },
    {
      range: 'post-execute',
      mode: 'frozen' as const,
      required: ['debrief'],
    },
    {
      range: 'solve-only',
      mode: 'frozen' as const,
      required: [],
    },
  ])(
    'requires $required for phaseRange=$range mode=$mode',
    ({ range, mode, required }) => {
      expect(
        requiredLearnerPhases(resolveLearnerPhaseRange(range), mode),
      ).toEqual(required);
    },
  );

  it('defaults an absent or unknown phase range to full', () => {
    expect(resolveLearnerPhaseRange()).toBe('full');
    expect(resolveLearnerPhaseRange('unknown')).toBe('full');
  });

  it('reports complete only when every required primary artifact is valid JSON', () => {
    const phases = [
      'orient',
      'strategize',
      'plan',
      'execute',
      'debrief',
      'improve',
      'memory-consolidation',
    ] as const;
    writePhases(workingDir, phases);

    expect(
      inspectLearnerTerminalEvidence({
        workingDir,
        mode: 'train',
        phaseRange: 'full',
      }),
    ).toEqual({
      kind: 'complete',
      requiredArtifacts: phases.map((phase) =>
        join(workingDir, `.${phase}`, primaryArtifacts[phase])),
    });
  });

  it('reports corrupt and missing required primary artifacts as incomplete', () => {
    writePhases(workingDir, ['orient', 'strategize']);
    const corruptPlan = join(workingDir, '.plan', 'plan.json');
    mkdirSync(join(workingDir, '.plan'), { recursive: true });
    writeFileSync(corruptPlan, 'not-json{');

    expect(
      inspectLearnerTerminalEvidence({
        workingDir,
        mode: 'train',
        phaseRange: 'pre-execute',
      }),
    ).toEqual({
      kind: 'incomplete',
      missingArtifacts: [corruptPlan],
    });
  });

  it('uses the first lexically sorted valid learner error JSON as terminal failure evidence', () => {
    const errorsDir = join(workingDir, '.errors');
    mkdirSync(errorsDir, { recursive: true });
    writeFileSync(join(errorsDir, '00-corrupt.json'), 'not-json{');
    writeJsonObject(join(errorsDir, 'plan.json'), { phase: 'plan' });
    writeJsonObject(join(errorsDir, 'strategize.json'), { phase: 'strategize' });

    expect(
      inspectLearnerTerminalEvidence({
        workingDir,
        mode: 'train',
        phaseRange: 'full',
      }),
    ).toEqual({
      kind: 'failure',
      errorArtifact: join(errorsDir, 'plan.json'),
    });
  });

  it('does not treat a corrupt learner error file as terminal evidence', () => {
    const errorsDir = join(workingDir, '.errors');
    mkdirSync(errorsDir, { recursive: true });
    writeFileSync(join(errorsDir, 'plan.json'), 'not-json{');

    const evidence = inspectLearnerTerminalEvidence({
      workingDir,
      mode: 'train',
      phaseRange: 'full',
    });

    expect(evidence.kind).toBe('incomplete');
  });
});
