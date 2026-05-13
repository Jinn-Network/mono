// client/src/harnesses/impls/hermes-agent/prompt.ts
import type { TaskSessionInputs } from '../learner/types.js';

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function taskBodyRecord(inputs: TaskSessionInputs): Record<string, unknown> | null {
  return nestedRecord(inputs.taskBody);
}

function sweRebenchV2Guidance(inputs: TaskSessionInputs): string[] {
  const body = taskBodyRecord(inputs);
  if (body?.solverType !== 'swe-rebench-v2.v1' || body.role === 'evaluation') {
    return [];
  }
  const spec = nestedRecord(body.spec);
  const repo = typeof spec?.repo === 'string' && spec.repo.trim() ? spec.repo.trim() : '<goal.spec.repo>';
  const baseCommit = typeof spec?.base_commit === 'string' && spec.base_commit.trim()
    ? spec.base_commit.trim()
    : '<goal.spec.base_commit>';
  return [
    '',
    'SWE-rebench v2 restoration requirements:',
    `- Use ${inputs.workingDir}/repo as the only task repository checkout. Do not reuse a repo from another workingDir or from implStateDir.`,
    `- If ${inputs.workingDir}/repo/.git is missing, clone https://github.com/${repo}.git into ${inputs.workingDir}/repo and checkout ${baseCommit} before editing.`,
    '- Before planning, look through the Jinn knowledge corpus for prior execution data on the same problem or repo. Pick the appropriate tool from your catalogue for each step: searching for candidate records, examining a single record\'s index card before paying for it, and downloading artifact bytes only when the index card looks relevant.',
    `- When you are done, submit your final result as a typed structured payload conforming to the swe-rebench-v2-solution.v1 schema: {"schemaVersion":"swe-rebench-v2-solution.v1","patch":"<unified diff>"}. Use the typed-payload submission tool from your Jinn client catalogue — it validates against the SolverNet contract schema and returns actionable error issues on mismatch. Do not write ${inputs.workingDir}/.execute/solution-payload.json directly unless no such tool is available; if you must fall back, the file must match the schema exactly.`,
    `- If you rely on the harvester git-diff fallback, the patch must be present as git diff output under ${inputs.workingDir}/repo.`,
  ];
}

export function buildInitialPrompt(inputs: TaskSessionInputs): string {
  return [
    'You are executing a Jinn task.',
    'Complete the task described by the task payload below.',
    'Use the available skills, tools, and runtime context exposed by this harness.',
    'Keep all task work inside `workingDir`.',
    'When the task expects a typed SolverNet payload, hand your final result back through the typed-payload submission tool in your Jinn client catalogue — it validates against the active SolverNet contract schema before persisting. Direct file writes to .execute/solution-payload.json are a last-resort fallback when no such tool is available.',
    ...sweRebenchV2Guidance(inputs),
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
