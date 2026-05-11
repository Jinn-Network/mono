// client/test/harnesses/impls/hermes-agent/prompt.test.ts
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
    expect(p).toContain('submit_typed_payload');
    expect(p).toContain('/wd');
    expect(p).toContain('/state');
    expect(p).toContain('train');
  });

  it('includes SWE-rebench v2 guidance when solverType matches', () => {
    const p = buildInitialPrompt(baseInputs());
    expect(p).toContain('SWE-rebench v2');
    expect(p).toContain('Unidata/netcdf-c');
    expect(p).toContain('a'.repeat(40));
    expect(p).toContain('submit_typed_payload');
  });

  it('omits SWE-rebench guidance for non-SWE solver types', () => {
    const inputs = baseInputs();
    inputs.taskBody!.solverType = 'prediction.v1';
    inputs.solverType = 'prediction.v1';
    const p = buildInitialPrompt(inputs);
    expect(p).not.toContain('SWE-rebench v2 restoration');
  });

  it('omits SWE-rebench guidance for evaluation role', () => {
    const inputs = baseInputs();
    inputs.taskBody!.role = 'evaluation';
    const p = buildInitialPrompt(inputs);
    expect(p).not.toContain('SWE-rebench v2 restoration');
  });
});
