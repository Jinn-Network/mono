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
 * Walk workingDir/.<phase>/ to determine which phases produced artifacts.
 * A phase is considered "completed" if its dot-namespaced subdirectory
 * exists and contains at least one file.
 */
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

/**
 * Construct RestorationOutput from the plugin's per-phase artifacts.
 *
 * Reads:
 * - workingDir/.execute/summary.json — for stepsCompleted / stepsFailed / returnReason / elapsedMs
 * - workingDir/.strategize/strategy.json — for timingPosture
 * - workingDir/.debrief/analysis.json — for successCriteriaMet
 *
 * Lifts the relevant fields into gating so the engine's packaging /
 * downstream consumers see them. Missing artifacts are treated as
 * "phase did not run" rather than errors — the engine separately
 * verifies tier requirements.
 */
export function harvestOutput(workingDir: string): RestorationOutput {
  const phasesCompleted = detectCompletedPhases(workingDir);

  const gating: Record<string, unknown> = { phasesCompleted };

  const strategy = safeReadJson(join(workingDir, '.strategize', 'strategy.json'));
  if (strategy && typeof strategy.timingPosture === 'string') {
    gating.timingPosture = strategy.timingPosture;
  }

  const exec = safeReadJson(join(workingDir, '.execute', 'summary.json'));
  if (exec) {
    if (typeof exec.returnReason === 'string') gating.executeReturnReason = exec.returnReason;
    if (Array.isArray(exec.stepsCompleted)) gating.executeStepsCompleted = exec.stepsCompleted.length;
    if (Array.isArray(exec.stepsFailed)) gating.executeStepsFailed = exec.stepsFailed.length;
    if (typeof exec.elapsedMs === 'number') gating.executeElapsedMs = exec.elapsedMs;
  }

  const debrief = safeReadJson(join(workingDir, '.debrief', 'analysis.json'));
  if (debrief && typeof debrief.successCriteriaMet === 'string') {
    gating.debriefVerdict = debrief.successCriteriaMet;
  }

  return {
    venueRef: { name: 'default-learner' },
    gating,
  };
}
