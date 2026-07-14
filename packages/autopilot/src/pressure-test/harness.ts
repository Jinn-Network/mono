import { buildHeadlessPrompt } from '../headless.js';
import { runSkillHeadless, type SkillRunResult } from './run-skill.js';
import { classifyRun, type RunVerdict } from './detect-block.js';

export interface PressureCase {
  skill: string;
  scenarioName: string;
  scenario: string;
  /** Returns true if the skill's expected deliverable exists in `cwd`. */
  deliverableCheck: (cwd: string) => boolean;
}

export interface PressureResult {
  skill: string;
  scenarioName: string;
  verdict: RunVerdict;
}

/**
 * Run one pressure case: compose the headless prompt, run the skill, classify.
 * `run` is injectable so the glue is unit-testable without spawning `claude`.
 */
export async function pressureTest(
  c: PressureCase,
  cwd: string,
  run: (prompt: string) => Promise<SkillRunResult> = (p) =>
    runSkillHeadless(p, { cwd, timeoutMs: 600_000 }),
): Promise<PressureResult> {
  const result = await run(buildHeadlessPrompt(c.skill, c.scenario));
  const verdict = classifyRun(result.stdout, {
    producedDeliverable: c.deliverableCheck(cwd),
  });
  return { skill: c.skill, scenarioName: c.scenarioName, verdict };
}
