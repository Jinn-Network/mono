import { describe, it, expect } from 'vitest';
import { RestorerImplRegistry } from '../../../src/restorer/engine/registry.js';
import type { RestorerImpl } from '../../../src/restorer/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeImpl(name: string, kinds: string[]): RestorerImpl {
  return {
    name,
    version: '1.0.0',
    supports: (spec) => kinds.includes(spec.kind),
    run: async () => {
      throw new Error('not implemented in test');
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RestorerImplRegistry', () => {
  describe('register + list', () => {
    it('registers and lists impls', () => {
      const reg = new RestorerImplRegistry();
      const impl = makeImpl('alpha', ['portfolio.v0']);
      reg.register(impl);
      expect(reg.list()).toHaveLength(1);
      expect(reg.list()[0]!.name).toBe('alpha');
    });

    it('list returns all registered impls including disabled', () => {
      const reg = new RestorerImplRegistry({ disabled: ['alpha'] });
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      reg.register(makeImpl('beta', ['portfolio.v1']));
      expect(reg.list()).toHaveLength(2);
    });
  });

  describe('findFor — first-match dispatch', () => {
    it('returns first impl that supports the kind', () => {
      const reg = new RestorerImplRegistry();
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      reg.register(makeImpl('beta', ['portfolio.v0']));
      expect(reg.findFor({ kind: 'portfolio.v0' })?.name).toBe('alpha');
    });

    it('returns undefined when no impl supports the kind', () => {
      const reg = new RestorerImplRegistry();
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      expect(reg.findFor({ kind: 'unknown.v1' })).toBeUndefined();
    });

    it('returns undefined for empty registry', () => {
      const reg = new RestorerImplRegistry();
      expect(reg.findFor({ kind: 'portfolio.v0' })).toBeUndefined();
    });
  });

  describe('findFor — byKind dispatch', () => {
    it('byKind wins over registration order', () => {
      const reg = new RestorerImplRegistry({
        byKind: { 'portfolio.v0': 'beta' },
      });
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      reg.register(makeImpl('beta', ['portfolio.v0']));
      expect(reg.findFor({ kind: 'portfolio.v0' })?.name).toBe('beta');
    });

    it('byKind falls through to first-match if named impl not registered', () => {
      const reg = new RestorerImplRegistry({
        byKind: { 'portfolio.v0': 'nonexistent' },
      });
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      // nonexistent is not registered → cannot support ctx → fall through to first-match
      expect(reg.findFor({ kind: 'portfolio.v0' })?.name).toBe('alpha');
    });

    it('byKind returns undefined if named impl is disabled', () => {
      const reg = new RestorerImplRegistry({
        byKind: { 'portfolio.v0': 'alpha' },
        disabled: ['alpha'],
      });
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      expect(reg.findFor({ kind: 'portfolio.v0' })).toBeUndefined();
    });
  });

  describe('findFor — default dispatch', () => {
    it('default impl is used when no byKind match', () => {
      const reg = new RestorerImplRegistry({ default: 'beta' });
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      reg.register(makeImpl('beta', ['portfolio.v0', 'portfolio.v1']));
      // portfolio.v1 has no byKind, no first-match for alpha, so default beta applies
      expect(reg.findFor({ kind: 'portfolio.v1' })?.name).toBe('beta');
    });

    it('default impl is skipped if it does not support the kind', () => {
      const reg = new RestorerImplRegistry({ default: 'beta' });
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      reg.register(makeImpl('beta', ['portfolio.v1']));
      // default=beta but beta does not support portfolio.v0
      // falls through to first-match → alpha
      const found = reg.findFor({ kind: 'portfolio.v0' });
      expect(found?.name).toBe('alpha');
    });

    it('default impl is skipped if disabled', () => {
      const reg = new RestorerImplRegistry({ default: 'beta', disabled: ['beta'] });
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      reg.register(makeImpl('beta', ['portfolio.v0']));
      expect(reg.findFor({ kind: 'portfolio.v0' })?.name).toBe('alpha');
    });
  });

  describe('findFor — disabled filtering', () => {
    it('disabled impls are excluded from first-match', () => {
      const reg = new RestorerImplRegistry({ disabled: ['alpha'] });
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      reg.register(makeImpl('beta', ['portfolio.v0']));
      expect(reg.findFor({ kind: 'portfolio.v0' })?.name).toBe('beta');
    });

    it('returns undefined when all impls are disabled', () => {
      const reg = new RestorerImplRegistry({ disabled: ['alpha', 'beta'] });
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      reg.register(makeImpl('beta', ['portfolio.v0']));
      expect(reg.findFor({ kind: 'portfolio.v0' })).toBeUndefined();
    });
  });

});

// ── New (kind, type) dispatch tests ──────────────────────────────────────────

const stubImpl = (name: string, supports: RestorerImpl['supports']): RestorerImpl => ({
  name,
  version: '0',
  supports,
  async run() { throw new Error('not used in dispatch tests'); },
});

describe('RestorerImplRegistry.findFor', () => {
  it('byKind resolves the restorer impl when type is restoration', () => {
    const r = new RestorerImplRegistry({ byKind: { 'x': 'x-rest' } });
    const rest = stubImpl('x-rest', ({kind, type}) => kind === 'x' && type !== 'evaluation');
    const eval_ = stubImpl('x-eval', ({kind, type}) => kind === 'x' && type === 'evaluation');
    r.register(rest); r.register(eval_);
    expect(r.findFor({ kind: 'x', type: 'restoration' })?.name).toBe('x-rest');
    expect(r.findFor({ kind: 'x' })?.name).toBe('x-rest');
  });

  it('falls through to first-match for evaluation', () => {
    const r = new RestorerImplRegistry({ byKind: { 'x': 'x-rest' } });
    const rest = stubImpl('x-rest', ({kind, type}) => kind === 'x' && type !== 'evaluation');
    const eval_ = stubImpl('x-eval', ({kind, type}) => kind === 'x' && type === 'evaluation');
    r.register(rest); r.register(eval_);
    // byKind points at x-rest but x-rest.supports({type:'evaluation'}) is false
    // → registry falls through to first-match, which finds x-eval
    expect(r.findFor({ kind: 'x', type: 'evaluation' })?.name).toBe('x-eval');
  });

  it('disabled impls are filtered before dispatch', () => {
    const r = new RestorerImplRegistry({ disabled: ['x-rest'] });
    r.register(stubImpl('x-rest', ({kind}) => kind === 'x'));
    r.register(stubImpl('y-rest', ({kind}) => kind === 'y'));
    expect(r.findFor({ kind: 'x' })).toBeUndefined();
    expect(r.findFor({ kind: 'y' })?.name).toBe('y-rest');
  });

  it('falls through to default when byKind names an impl that does not support the ctx', () => {
    const r = new RestorerImplRegistry({
      byKind: { 'x': 'x-rest' },
      default: 'catch-all',
    });
    const rest = stubImpl('x-rest', ({kind, type}) => kind === 'x' && type !== 'evaluation');
    const catchAll = stubImpl('catch-all', () => true);
    r.register(rest);
    r.register(catchAll);
    // byKind points at x-rest, which rejects evaluation; default (catch-all)
    // supports everything → registry must return it before first-match.
    expect(r.findFor({ kind: 'x', type: 'evaluation' })?.name).toBe('catch-all');
  });
});

// ── wrapWith universal-wrap policy (jinn-mono-0k2) ────────────────────────────

describe('RestorerImplRegistry.findFor — wrapWith policy', () => {
  it('wrapWith returns the wrapper for non-evaluation dispatch when it supports the ctx', () => {
    const r = new RestorerImplRegistry({ wrapWith: 'wrapper' });
    const wrapper = stubImpl('wrapper', ({type}) => type !== 'evaluation');
    const specialist = stubImpl('specialist', ({kind}) => kind === 'x');
    r.register(specialist);
    r.register(wrapper);
    expect(r.findFor({ kind: 'x', type: 'restoration' })?.name).toBe('wrapper');
    // Default ctx (no type) is treated as restoration too.
    expect(r.findFor({ kind: 'x' })?.name).toBe('wrapper');
  });

  it('wrapWith bypasses byKind for non-evaluation', () => {
    const r = new RestorerImplRegistry({
      wrapWith: 'wrapper',
      byKind: { x: 'specialist' },
    });
    const wrapper = stubImpl('wrapper', ({type}) => type !== 'evaluation');
    const specialist = stubImpl('specialist', ({kind}) => kind === 'x');
    r.register(specialist);
    r.register(wrapper);
    expect(r.findFor({ kind: 'x', type: 'restoration' })?.name).toBe('wrapper');
  });

  it('wrapWith does NOT apply to evaluation dispatch (specialist evaluator wins)', () => {
    const r = new RestorerImplRegistry({ wrapWith: 'wrapper' });
    const wrapper = stubImpl('wrapper', ({type}) => type !== 'evaluation');
    const evalImpl = stubImpl('evaluator', ({kind, type}) => kind === 'x' && type === 'evaluation');
    r.register(wrapper);
    r.register(evalImpl);
    expect(r.findFor({ kind: 'x', type: 'evaluation' })?.name).toBe('evaluator');
  });

  it('wrapWith=undefined dispatches a non-evaluation kind directly to its specialist', () => {
    // Direct exercise of the wrapWith=undefined path — operator opt-out
    // benchmarks / raw-impl behaviour. With no wrapWith, byKind / first-match
    // should win.
    const r = new RestorerImplRegistry({ byKind: { x: 'specialist' } });
    const wrapper = stubImpl('wrapper', ({type}) => type !== 'evaluation');
    const specialist = stubImpl('specialist', ({kind}) => kind === 'x');
    r.register(specialist);
    r.register(wrapper);
    expect(r.findFor({ kind: 'x', type: 'restoration' })?.name).toBe('specialist');
    // Even without byKind, first-match should pick the specialist
    // (registered before wrapper) and not silently fall back to wrapper.
    const r2 = new RestorerImplRegistry();
    r2.register(specialist);
    r2.register(wrapper);
    // wrapper.supports() returns true for non-evaluation, but byKind/default
    // are unset and first-match scans in registration order — specialist
    // wins for kind=x.
    expect(r2.findFor({ kind: 'x', type: 'restoration' })?.name).toBe('specialist');
  });

  it('wrapWith=null is treated as off (operator explicit opt-out via JinnConfig)', () => {
    const r = new RestorerImplRegistry({ wrapWith: null, byKind: { x: 'specialist' } });
    const wrapper = stubImpl('wrapper', ({type}) => type !== 'evaluation');
    const specialist = stubImpl('specialist', ({kind}) => kind === 'x');
    r.register(specialist);
    r.register(wrapper);
    expect(r.findFor({ kind: 'x', type: 'restoration' })?.name).toBe('specialist');
  });

  it('wrapWith falls through when the named wrapper is not registered', () => {
    const r = new RestorerImplRegistry({
      wrapWith: 'nonexistent',
      byKind: { x: 'specialist' },
    });
    const specialist = stubImpl('specialist', ({kind}) => kind === 'x');
    r.register(specialist);
    expect(r.findFor({ kind: 'x', type: 'restoration' })?.name).toBe('specialist');
  });

  it('wrapWith falls through when the named wrapper is disabled', () => {
    const r = new RestorerImplRegistry({
      wrapWith: 'wrapper',
      disabled: ['wrapper'],
      byKind: { x: 'specialist' },
    });
    const wrapper = stubImpl('wrapper', ({type}) => type !== 'evaluation');
    const specialist = stubImpl('specialist', ({kind}) => kind === 'x');
    r.register(specialist);
    r.register(wrapper);
    expect(r.findFor({ kind: 'x', type: 'restoration' })?.name).toBe('specialist');
  });

  it('wrapWith falls through when the named wrapper does not supports() the ctx', () => {
    // Wrapper only supports kind=y; for kind=x it's a miss → byKind/specialist applies.
    const r = new RestorerImplRegistry({
      wrapWith: 'wrapper',
      byKind: { x: 'specialist' },
    });
    const wrapper = stubImpl('wrapper', ({kind}) => kind === 'y');
    const specialist = stubImpl('specialist', ({kind}) => kind === 'x');
    r.register(specialist);
    r.register(wrapper);
    expect(r.findFor({ kind: 'x', type: 'restoration' })?.name).toBe('specialist');
    expect(r.findFor({ kind: 'y', type: 'restoration' })?.name).toBe('wrapper');
  });
});
