import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RestorationOutput } from '../../types.js';

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

function safeReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    return JSON.parse(text) as Record<string, unknown>;
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
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Required artifact contains invalid JSON: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
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

/**
 * Construct RestorationOutput from the plugin's per-phase artifacts.
 *
 * Phase range (from phaseRange arg, JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE env, or 'full'):
 *   full         — all 7 phases required
 *   pre-execute  — orient, strategize, plan required (phases 1–3)
 *   post-execute — debrief, improve, memory-consolidation required (phases 5–7)
 *
 * Required phase artifacts: hard-fail (throw) if missing or corrupt JSON.
 * Optional phase artifacts (outside the required range): safeReadJson + warn on null.
 */
export function harvestOutput(workingDir: string, phaseRange?: string): RestorationOutput {
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

  return {
    venueRef: { name: 'claude-code-learner' },
    gating,
  };
}
