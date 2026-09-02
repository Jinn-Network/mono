/**
 * Unit tests for the shared structured-value walker (issue #3038).
 *
 * The walker owns traversal only — container classification, recursion, and
 * the container-scoped depth cap. Redaction / masking vocabulary belongs to
 * the caller's `leaf` and `entry` policy.
 */

import { describe, expect, it } from 'vitest';
import {
  isPlainRecord,
  walkStructured,
  TRUNCATED_MARKER,
} from '../../src/util/structured-walk.js';

const identity = { leaf: (v: unknown) => v };

describe('isPlainRecord', () => {
  it('accepts object literals and null-prototype records', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
  });

  it('rejects arrays, null, primitives, and non-plain objects', () => {
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord('s')).toBe(false);
    expect(isPlainRecord(new Map())).toBe(false);
    expect(isPlainRecord(new Set())).toBe(false);
    expect(isPlainRecord(new Date())).toBe(false);
    expect(isPlainRecord(new Error('x'))).toBe(false);
    expect(isPlainRecord(new (class Foo {})())).toBe(false);
  });
});

describe('walkStructured', () => {
  it('walks arrays and plain records, applying the leaf policy', () => {
    const out = walkStructured({ a: [1, { b: 'x' }] }, {
      leaf: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
    });
    expect(out).toEqual({ a: [1, { b: 'X' }] });
  });

  it('routes non-plain objects to the leaf policy instead of collapsing to {}', () => {
    const map = new Map([['k', 'v']]);
    const seen: unknown[] = [];
    const out = walkStructured({ map }, {
      leaf: (v) => {
        seen.push(v);
        return '<leaf>';
      },
    });
    expect(out).toEqual({ map: '<leaf>' });
    expect(seen).toEqual([map]);
  });

  it('does not mutate the input', () => {
    const input = { a: { b: 'x' } };
    walkStructured(input, { leaf: () => 'replaced' });
    expect(input).toEqual({ a: { b: 'x' } });
  });

  it('caps containers past maxDepth but leaves deep primitives typed', () => {
    // depth 0 = top-level container; a container at depth 3 exceeds maxDepth 2.
    const deep = { l1: { l2: { l3: { l4: 'too deep' } } } };
    expect(walkStructured(deep, { ...identity, maxDepth: 2 })).toEqual({
      l1: { l2: { l3: TRUNCATED_MARKER } },
    });

    const deepPrimitive = { l1: { l2: { l3: 7, ok: false } } };
    expect(walkStructured(deepPrimitive, { ...identity, maxDepth: 2 })).toEqual({
      l1: { l2: { l3: 7, ok: false } },
    });
  });

  it('accepts a caller-supplied truncation replacement', () => {
    const deep = { l1: { l2: [1] } };
    expect(walkStructured(deep, { ...identity, maxDepth: 1, truncated: null })).toEqual({
      l1: { l2: null },
    });
  });

  it('recurses without bound when maxDepth is unset', () => {
    let node: Record<string, unknown> = { leaf: 'v' };
    for (let i = 0; i < 40; i++) node = { nested: node };
    expect(walkStructured(node, identity)).toEqual(node);
  });

  it('lets an entry policy override a record property before recursion', () => {
    const out = walkStructured({ secret: { nested: 1 }, keep: { nested: 2 } }, {
      leaf: (v) => v,
      entry: (key, value) => (key === 'secret' ? { value: '<masked>' } : undefined),
    });
    expect(out).toEqual({ secret: '<masked>', keep: { nested: 2 } });
  });

  it('applies the entry policy only inside records, not array elements', () => {
    const out = walkStructured({ list: [{ secret: 1 }] }, {
      leaf: (v) => v,
      entry: (key) => (key === 'secret' ? { value: '<masked>' } : undefined),
    });
    expect(out).toEqual({ list: [{ secret: '<masked>' }] });
  });
});
