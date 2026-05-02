import { describe, it, expect } from 'vitest';
import { freezeSecrets } from '../../../src/harnesses/capability/scoped-secrets.js';

describe('freezeSecrets', () => {
  it('exposes the keys the source has at construction', () => {
    const view = freezeSecrets({ A: '1', B: '2' });
    expect(Object.keys(view).sort()).toEqual(['A', 'B']);
    expect(view.A).toBe('1');
    expect(view.B).toBe('2');
  });

  it('returns a frozen object that rejects mutations in strict mode', () => {
    const view = freezeSecrets({ API_KEY: 'k1' });
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => {
      (view as Record<string, string>).API_KEY = 'overwritten';
    }).toThrow();
  });

  it('snapshots the source — later mutations of the source do not leak in', () => {
    const source: Record<string, string> = { A: '1' };
    const view = freezeSecrets(source);
    source.A = 'overwritten';
    source.B = 'new';
    expect(view.A).toBe('1');
    expect((view as Record<string, string | undefined>).B).toBeUndefined();
  });
});
