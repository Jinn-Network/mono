// operator/test/harnesses/impls/hermes-agent/prompt.test.ts
import { describe, expect, it } from 'vitest';
import { buildInitialPrompt } from '../../../../src/harnesses/impls/hermes-agent/prompt.js';
import type { TaskSessionInputs } from '../../../../src/harnesses/impls/learner/types.js';

function baseInputs(): TaskSessionInputs {
  return {
    taskId: 't-1',
    requestId: 'req-1',
    taskCid: 'bafy…',
    solverType: 'swe-rebench-v2.v1',
    implStateDir: '/state',
    workingDir: '/wd',
    windowStartTs: 0,
    windowEndTs: 9_999_999_999_999,
    msUntilEndTs: 9_999_999_999,
    abort: new AbortController().signal,
    mode: 'train',
    taskBody: {
      id: 't-1',
      description: 'fix the netcdf bug',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      spec: { repo: 'Unidata/netcdf-c', base_commit: 'a'.repeat(40) },
    },
  };
}

describe('buildInitialPrompt', () => {
  it('includes Jinn task framing and delivery instruction', () => {
    const p = buildInitialPrompt(baseInputs());
    expect(p).toContain('Jinn task');
    // Intent-language reference to the typed-payload submission tool;
    // we deliberately do NOT hardcode the harness-specific registry name
    // (`mcp_jinn_client_submit_typed_payload`) so the model can bridge via
    // tool description. See DR in the harness design spec.
    expect(p).toContain('typed-payload submission tool');
    expect(p).toContain('/wd');
    expect(p).toContain('/state');
    expect(p).toContain('train');
  });

  it('serializes the task body verbatim so SolverPlugin skills can read spec fields', () => {
    // SolverNet-specific guidance (repo setup, schema shape, etc.) is the
    // SolverPlugin's job — it lives in the plugin's SKILL.md files, not in
    // this prompt. The prompt only needs to give the agent the full task
    // body so the skills can read goal.spec.repo / goal.spec.base_commit /
    // etc. at runtime. Assert the body round-trips; don't assert that the
    // prompt itself mentions SWE-rebench or any other SolverNet by name.
    const p = buildInitialPrompt(baseInputs());
    expect(p).toContain('Unidata/netcdf-c');
    expect(p).toContain('a'.repeat(40));
  });

  it('does NOT bake SolverNet-specific guidance into the harness prompt', () => {
    // Regression guard: if a future edit reintroduces a sweRebenchV2Guidance
    // helper (or any analogue), this test fails. The architectural rule is
    // "harnesses generic, plugins teach the task pattern" — keep it.
    const p = buildInitialPrompt(baseInputs());
    expect(p).not.toContain('SWE-rebench v2 restoration requirements');
    expect(p).not.toContain('clone https://github.com/');
    expect(p).not.toContain('swe-rebench-v2-solution.v1');
  });

  it('renders the same generic shape regardless of solverType / role', () => {
    // Sanity: changing solverType or role should NOT add or remove sections.
    // The plugin's skills handle per-SolverNet branching.
    const base = buildInitialPrompt(baseInputs());

    const prediction = baseInputs();
    prediction.taskBody!.solverType = 'prediction.v1';
    prediction.solverType = 'prediction.v1';
    const predictionPrompt = buildInitialPrompt(prediction);

    const evaluation = baseInputs();
    evaluation.taskBody!.role = 'evaluation';
    const evaluationPrompt = buildInitialPrompt(evaluation);

    // Each prompt has the same set of top-level sections (framing lines +
    // Session inputs + body). Counts of structural lines should match.
    const countSessionInputs = (s: string) => (s.match(/Session inputs:/g) ?? []).length;
    expect(countSessionInputs(base)).toBe(1);
    expect(countSessionInputs(predictionPrompt)).toBe(1);
    expect(countSessionInputs(evaluationPrompt)).toBe(1);
  });
});
