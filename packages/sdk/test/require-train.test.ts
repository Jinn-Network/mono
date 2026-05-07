import { describe, it, expect } from 'vitest';
import { requireTrain, HarnessError } from '../src/harness.js';
import type { HarnessContext } from '../src/harness.js';

function ctxWithMode(mode: 'train' | 'frozen'): HarnessContext {
  return {
    task: { id: 't1', solverType: 'prediction.v1' } as any,
    implStateDir: '/tmp/x',
    workingDir: '/tmp/y',
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    trajectory: { addSpan: () => {} } as any,
    mode,
  };
}

describe('requireTrain', () => {
  it('returns silently when mode is "train"', () => {
    expect(() => requireTrain(ctxWithMode('train'), 'update state')).not.toThrow();
  });

  it('throws HarnessError when mode is "frozen"', () => {
    expect(() => requireTrain(ctxWithMode('frozen'), 'update state'))
      .toThrowError(HarnessError);
  });

  it('error message includes the action name', () => {
    try {
      requireTrain(ctxWithMode('frozen'), 'update constitutional state');
      throw new Error('should not reach');
    } catch (e) {
      expect((e as Error).message).toContain('update constitutional state');
      expect((e as Error).message).toContain('frozen');
    }
  });
});
