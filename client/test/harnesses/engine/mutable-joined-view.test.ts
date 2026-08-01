import { describe, expect, it } from 'vitest';
import { createMutableJoinedSolverNetsView } from '../../../src/harnesses/engine/joined-solver-nets-view.js';

describe('createMutableJoinedSolverNetsView', () => {
  it('starts empty and reflects entries set after construction', () => {
    const view = createMutableJoinedSolverNetsView({});
    expect(view.manifestCids()).toEqual([]);
    expect(view.get('cidA')).toBeUndefined();

    view.set('cidA', { roles: ['solver'] });
    expect(view.get('cidA')).toEqual({ roles: ['solver'] });
    expect(view.manifestCids()).toEqual(['cidA']);
  });

  it('seeds from an initial config block', () => {
    const view = createMutableJoinedSolverNetsView({
      cidB: { manifestCid: 'cidB', roles: ['evaluator'] },
    });
    expect(view.get('cidB')).toEqual({ roles: ['evaluator'] });
  });
});
