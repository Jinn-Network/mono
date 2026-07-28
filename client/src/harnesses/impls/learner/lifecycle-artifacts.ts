import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const LEARNER_PHASE_ORDER = [
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
] as const;

export type LearnerPhase = (typeof LEARNER_PHASE_ORDER)[number];

export const LEARNER_PHASE_PRIMARY_ARTIFACT: Readonly<Record<LearnerPhase, string>> = {
  orient: 'summary.json',
  strategize: 'strategy.json',
  plan: 'plan.json',
  execute: 'summary.json',
  debrief: 'analysis.json',
  improve: 'summary.json',
  'memory-consolidation': 'consolidation_record.json',
};

export type LearnerPhaseRange =
  | 'full'
  | 'pre-execute'
  | 'post-execute'
  | 'solve-only';

const REQUIRED_PHASES_BY_RANGE: Readonly<Record<LearnerPhaseRange, readonly LearnerPhase[]>> = {
  full: LEARNER_PHASE_ORDER,
  'pre-execute': ['orient', 'strategize', 'plan'],
  'post-execute': ['debrief', 'improve', 'memory-consolidation'],
  // Frozen-mode specialist solves are harvested from their typed payload or
  // repository diff and intentionally require no generic learner artifacts.
  'solve-only': [],
};

export type LearnerTerminalEvidence =
  | { kind: 'complete'; requiredArtifacts: readonly string[] }
  | { kind: 'failure'; errorArtifact: string }
  | { kind: 'incomplete'; missingArtifacts: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function resolveLearnerPhaseRange(value?: string): LearnerPhaseRange {
  if (value === 'pre-execute' || value === 'post-execute' || value === 'solve-only') {
    return value;
  }
  return 'full';
}

export function requiredLearnerPhases(
  range: LearnerPhaseRange,
  mode: 'train' | 'frozen' = 'train',
): readonly LearnerPhase[] {
  const phases = REQUIRED_PHASES_BY_RANGE[range];
  if (mode === 'train') return phases;
  return phases.filter(
    (phase) => phase !== 'improve' && phase !== 'memory-consolidation',
  );
}

export function learnerPhaseArtifactPath(
  workingDir: string,
  phase: LearnerPhase,
): string {
  return join(workingDir, `.${phase}`, LEARNER_PHASE_PRIMARY_ARTIFACT[phase]);
}

/**
 * Read a required learner artifact as a JSON object.
 *
 * This is the shared validity boundary for harvesting and adapter terminal
 * evidence. Arrays, scalars, partial writes, and unreadable files are not
 * valid learner artifacts.
 */
export function requiredReadJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`Required artifact missing: ${path}`);
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `Cannot read required artifact ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `Required artifact contains invalid JSON: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function firstValidLearnerErrorArtifact(workingDir: string): string | undefined {
  const errorsDir = join(workingDir, '.errors');
  let entries: string[];
  try {
    entries = readdirSync(errorsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const path = join(errorsDir, entry);
    try {
      requiredReadJson(path);
      return path;
    } catch {
      // A malformed error artifact is not authoritative terminal evidence.
    }
  }
  return undefined;
}

export function inspectLearnerTerminalEvidence(input: {
  workingDir: string;
  mode: 'train' | 'frozen';
  phaseRange?: string;
}): LearnerTerminalEvidence {
  const errorArtifact = firstValidLearnerErrorArtifact(input.workingDir);
  if (errorArtifact) {
    return { kind: 'failure', errorArtifact };
  }

  const range = resolveLearnerPhaseRange(input.phaseRange);
  const requiredArtifacts = requiredLearnerPhases(range, input.mode).map((phase) =>
    learnerPhaseArtifactPath(input.workingDir, phase));
  const missingArtifacts = requiredArtifacts.filter((path) => {
    try {
      requiredReadJson(path);
      return false;
    } catch {
      return true;
    }
  });

  if (missingArtifacts.length > 0) {
    return { kind: 'incomplete', missingArtifacts };
  }
  return { kind: 'complete', requiredArtifacts };
}
