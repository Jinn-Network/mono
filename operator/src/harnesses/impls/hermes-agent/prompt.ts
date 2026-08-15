// operator/src/harnesses/impls/hermes-agent/prompt.ts
import type { TaskSessionInputs } from '../learner/types.js';

/**
 * Construct the initial task prompt for the Hermes agent.
 *
 * The harness deliberately does NOT bake SolverNet-specific guidance into
 * this prompt. Per-SolverNet task patterns (repo setup, schema shape,
 * submission expectations) live in the SolverPlugin's SKILL.md files
 * (e.g. `swe-rebench-v2-runtime/skills/task/SKILL.md`). The harness loads
 * those skills via `solverPluginRoots` and the agent picks them up at
 * runtime. Adding SolverNet branching here would re-create the leak that
 * retired the earlier `sweRebenchV2Guidance()` helper — every new
 * SolverNet would require a code change in every harness's prompt
 * builder.
 */
export function buildInitialPrompt(inputs: TaskSessionInputs): string {
  return [
    'You are executing a Jinn task.',
    'Complete the task described by the task payload below.',
    'Use the available skills, tools, and runtime context exposed by this harness.',
    'Keep all task work inside `workingDir`.',
    'When the task expects a typed SolverNet payload, hand your final result back through the typed-payload submission tool in your Jinn client catalogue — it validates against the active SolverNet contract schema before persisting. Direct file writes to .execute/solution-payload.json are a last-resort fallback when no such tool is available.',
    '',
    'Session inputs:',
    `- goal.id = ${inputs.taskId}`,
    inputs.taskCid ? `- goal.cid = ${inputs.taskCid}` : '',
    `- workingDir = ${inputs.workingDir}`,
    `- implStateDir = ${inputs.implStateDir}`,
    `- goal.deadline = ${inputs.windowEndTs} (ms since epoch)`,
    `- msUntilDeadline = ${inputs.msUntilEndTs}`,
    `- mode = ${inputs.mode}`,
    inputs.taskBody
      ? `\ngoal (full body):\n${JSON.stringify(inputs.taskBody, null, 2)}`
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
