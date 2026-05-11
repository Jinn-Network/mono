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
    '- Before planning, use Network Tools to search donated SWE execution data: call search_records, inspect_record, and acquire_artifact for useful donated IPFS records.',
    `- Submit the final swe-rebench-v2-solution.v1 payload by calling submit_typed_payload. Do not write ${inputs.workingDir}/.execute/solution-payload.json directly unless submit_typed_payload is unavailable; if fallback is required, write {"schemaVersion":"swe-rebench-v2-solution.v1","patch":"<unified diff>"} to that path.`,
    `- If you rely on the harvester git-diff fallback, the patch must be present as git diff output under ${inputs.workingDir}/repo.`,
  ];
}

export function buildInitialPrompt(inputs: TaskSessionInputs): string {
  return [
    'You are executing a Jinn task.',
    'Complete the task described by the task payload below.',
    'Use the available skills, tools, and runtime context exposed by this harness.',
    'Keep all task work inside `workingDir`.',
    'When the task requires a typed SolverNet payload, call submit_typed_payload. Do not write .execute/solution-payload.json directly unless submit_typed_payload is unavailable; if fallback is required, the file must match the exact SolverNet schema.',
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
