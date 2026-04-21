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

    it('byKind returns undefined if named impl not registered', () => {
      const reg = new RestorerImplRegistry({
        byKind: { 'portfolio.v0': 'nonexistent' },
      });
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      expect(reg.findFor({ kind: 'portfolio.v0' })).toBeUndefined();
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

  describe('resolveImplName — IRestorerImplRegistry compatibility', () => {
    it('returns impl name for a known kind', () => {
      const reg = new RestorerImplRegistry();
      reg.register(makeImpl('alpha', ['portfolio.v0']));
      expect(reg.resolveImplName('portfolio.v0')).toBe('alpha');
    });

    it('returns null for unknown kind', () => {
      const reg = new RestorerImplRegistry();
      expect(reg.resolveImplName('unknown')).toBeNull();
    });

    it('returns null for null input', () => {
      const reg = new RestorerImplRegistry();
      expect(reg.resolveImplName(null)).toBeNull();
    });
  });
});
