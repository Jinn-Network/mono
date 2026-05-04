import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OutputArtifact } from '../../../types/portfolio.js';
import type { Solution } from '../../types.js';

const PHASE_ORDER = [
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
] as const;

type Phase = (typeof PHASE_ORDER)[number];

const PHASE_PRIMARY_ARTIFACT: Record<Phase, string> = {
  orient: 'summary.json',
  strategize: 'strategy.json',
  plan: 'plan.json',
  execute: 'summary.json',
  debrief: 'analysis.json',
  improve: 'summary.json',
  'memory-consolidation': 'consolidation_record.json',
};

type PhaseRange = 'full' | 'pre-execute' | 'post-execute';

const REQUIRED_PHASES: Record<PhaseRange, Phase[]> = {
  full: [...PHASE_ORDER],
  'pre-execute': ['orient', 'strategize', 'plan'],
  'post-execute': ['debrief', 'improve', 'memory-consolidation'],
};

const OPTIONAL_LEARNER_ARTIFACTS = [
  {
    path: '.execute/prediction-corpus-retrieval.json',
    artifactType: 'prediction_corpus_retrieval',
    schema: 'jinn.prediction_corpus_retrieval.v1',
    tags: ['learner-feedback', 'prediction', 'corpus-retrieval'],
  },
  {
    path: 'prediction-corpus-retrieval.json',
    artifactType: 'prediction_corpus_retrieval',
    schema: 'jinn.prediction_corpus_retrieval.v1',
    tags: ['learner-feedback', 'prediction', 'corpus-retrieval'],
  },
  {
    path: '.debrief/learner-feedback.json',
    artifactType: 'learner_feedback',
    schema: 'jinn.learner_feedback.v1',
    tags: ['learner-feedback', 'prediction'],
  },
  {
    path: 'learner-feedback.json',
    artifactType: 'learner_feedback',
    schema: 'jinn.learner_feedback.v1',
    tags: ['learner-feedback', 'prediction'],
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Like safeReadJson but throws on missing file or invalid JSON.
 * Used for required phase artifacts where a silent failure would allow an
 * empty-looking success to propagate through the engine.
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

function readOptionalLearnerArtifact(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      console.warn(`[claude-code-learner] harvestOutput: learner artifact skipped; expected JSON object — ${path}`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(
      `[claude-code-learner] harvestOutput: learner artifact skipped; invalid JSON — ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function detectCompletedPhases(workingDir: string): string[] {
  const completed: string[] = [];
  for (const phase of PHASE_ORDER) {
    const dir = join(workingDir, `.${phase}`);
    if (!existsSync(dir)) continue;
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      const entries = readdirSync(dir);
      if (entries.length > 0) completed.push(phase);
    } catch {
      // Best-effort; ignore permission / IO errors.
    }
  }
  return completed;
}

function resolvePhaseRange(override?: string): PhaseRange {
  const raw = override ?? process.env.JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE ?? 'full';
  if (raw === 'pre-execute' || raw === 'post-execute') return raw;
  return 'full';
}

function lengthOf(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function summarizeLearnerArtifact(payload: Record<string, unknown>): Record<string, unknown> {
  const records = nestedRecord(payload, 'records');
  const retrieval = nestedRecord(payload, 'retrieval');
  const inspectedRefs = payload['inspectedRefs'] ?? records?.['inspected'] ?? retrieval?.['inspectedRefs'];
  const acquiredArtifacts = payload['acquiredArtifacts'] ?? retrieval?.['acquiredArtifacts'];
  const selfAssessment = nestedRecord(payload, 'selfAssessment');
  const verdictFeedback = payload['verdictFeedback'] ?? payload['postVerdict'] ?? payload['outcome'];
  const summary: Record<string, unknown> = {};

  const queries = lengthOf(payload['queries'] ?? payload['searchIntents'] ?? retrieval?.['queries']);
  if (queries !== undefined) summary.queries = queries;

  const considered = lengthOf(payload['recordsConsidered'] ?? records?.['considered'] ?? retrieval?.['recordsConsidered']);
  if (considered !== undefined) summary.recordsConsidered = considered;

  const cited = lengthOf(payload['recordsCited'] ?? records?.['cited'] ?? retrieval?.['recordsCited']);
  if (cited !== undefined) summary.recordsCited = cited;

  const used = lengthOf(payload['recordsUsed'] ?? records?.['used'] ?? retrieval?.['recordsUsed']);
  if (used !== undefined) summary.recordsUsed = used;

  const inspected = lengthOf(inspectedRefs);
  if (inspected !== undefined) summary.inspectedRefs = inspected;

  const acquired = lengthOf(acquiredArtifacts);
  if (acquired !== undefined) summary.acquiredArtifacts = acquired;

  if (typeof payload['retrievalUsed'] === 'boolean') summary.retrievalUsed = payload['retrievalUsed'];
  if (typeof selfAssessment?.['affectedForecast'] === 'boolean') {
    summary.affectedForecast = selfAssessment['affectedForecast'];
  }
  if (verdictFeedback !== undefined) summary.hasVerdictFeedback = true;

  return summary;
}

function collectLearnerArtifacts(workingDir: string): OutputArtifact[] {
  const artifacts: OutputArtifact[] = [];
  const seen = new Set<string>();

  for (const candidate of OPTIONAL_LEARNER_ARTIFACTS) {
    if (seen.has(candidate.path)) continue;
    const fullPath = join(workingDir, candidate.path);
    const payload = readOptionalLearnerArtifact(fullPath);
    if (!payload) continue;
    seen.add(candidate.path);

    artifacts.push({
      path: candidate.path,
      artifactType: candidate.artifactType,
      tags: [...candidate.tags],
      metadata: {
        schema: candidate.schema,
        source: 'agent-authored',
        ...summarizeLearnerArtifact(payload),
      },
      access: { priceUsdc: '0' },
    });
  }

  return artifacts;
}

/**
 * Construct Solution from the plugin's per-phase artifacts.
 *
 * Phase range (from phaseRange arg, JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE env, or 'full'):
 *   full         — all 7 phases required
 *   pre-execute  — orient, strategize, plan required (phases 1–3)
 *   post-execute — debrief, improve, memory-consolidation required (phases 5–7)
 *
 * Required phase artifacts: hard-fail (throw) if missing or corrupt JSON.
 * Optional phase artifacts (outside the required range): safeReadJson + warn on null.
 */
export function harvestOutput(workingDir: string, phaseRange?: string): Solution {
  const range = resolvePhaseRange(phaseRange);
  const requiredPhases = new Set<Phase>(REQUIRED_PHASES[range]);

  // Hard-fail on missing or corrupt primary artifacts for all required phases.
  const validated = new Map<Phase, Record<string, unknown>>();
  for (const phase of REQUIRED_PHASES[range]) {
    const path = join(workingDir, `.${phase}`, PHASE_PRIMARY_ARTIFACT[phase]);
    validated.set(phase, requiredReadJson(path));
  }

  const phasesCompleted = detectCompletedPhases(workingDir);
  const gating: Record<string, unknown> = { phasesCompleted };

  // Read a phase's primary artifact for optional gating-field extraction.
  // Required phases: use the already-validated result (no second read).
  // Optional phases: safeReadJson + warn on null.
  function readForGating(phase: Phase): Record<string, unknown> | null {
    if (requiredPhases.has(phase)) {
      return validated.get(phase) ?? null;
    }
    const path = join(workingDir, `.${phase}`, PHASE_PRIMARY_ARTIFACT[phase]);
    const data = safeReadJson(path);
    if (data === null) {
      console.warn(
        `[claude-code-learner] harvestOutput: optional artifact absent or corrupt — ${path}`,
      );
    }
    return data;
  }

  const strategy = readForGating('strategize');
  if (strategy && typeof strategy.timingPosture === 'string') {
    gating.timingPosture = strategy.timingPosture;
  }

  const exec = readForGating('execute');
  if (exec) {
    if (typeof exec.returnReason === 'string') gating.executeReturnReason = exec.returnReason;
    if (Array.isArray(exec.stepsCompleted)) gating.executeStepsCompleted = exec.stepsCompleted.length;
    if (Array.isArray(exec.stepsFailed)) gating.executeStepsFailed = exec.stepsFailed.length;
    if (typeof exec.elapsedMs === 'number') gating.executeElapsedMs = exec.elapsedMs;
  }

  const debrief = readForGating('debrief');
  if (debrief && typeof debrief.successCriteriaMet === 'string') {
    gating.debriefVerdict = debrief.successCriteriaMet;
  }

  const learnerArtifacts = collectLearnerArtifacts(workingDir);
  const informational = learnerArtifacts.length > 0
    ? {
        learnerFeedbackArtifacts: learnerArtifacts.map((artifact) => ({
          path: artifact.path,
          artifactType: artifact.artifactType,
          metadata: artifact.metadata,
        })),
      }
    : undefined;

  return {
    venueRef: { name: 'claude-code-learner' },
    gating,
    ...(informational ? { informational } : {}),
    ...(learnerArtifacts.length > 0 ? { artifacts: learnerArtifacts } : {}),
  };
}
