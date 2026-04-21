import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../../src/restorer/engine/canonical-json.js';

describe('canonicalJson', () => {
  it('serialises null', () => {
    expect(canonicalJson(null)).toBe('null');
  });

  it('serialises undefined as null', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('serialises booleans', () => {
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
  });

  it('serialises numbers', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(3.14)).toBe('3.14');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-1)).toBe('-1');
  });

  it('serialises NaN as null', () => {
    expect(canonicalJson(NaN)).toBe('null');
  });

  it('serialises Infinity as null', () => {
    expect(canonicalJson(Infinity)).toBe('null');
    expect(canonicalJson(-Infinity)).toBe('null');
  });

  it('serialises strings with JSON escaping', () => {
    expect(canonicalJson('hello')).toBe('"hello"');
    expect(canonicalJson('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('serialises arrays preserving order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('serialises empty array', () => {
    expect(canonicalJson([])).toBe('[]');
  });

  it('serialises objects with sorted keys', () => {
    const obj = { z: 1, a: 2, m: 3 };
    expect(canonicalJson(obj)).toBe('{"a":2,"m":3,"z":1}');
  });

  it('drops undefined values in objects', () => {
    const obj = { a: 1, b: undefined, c: 3 };
    expect(canonicalJson(obj)).toBe('{"a":1,"c":3}');
  });

  it('serialises empty object', () => {
    expect(canonicalJson({})).toBe('{}');
  });

  it('produces deterministic output regardless of insertion order', () => {
    const obj1 = { b: 2, a: 1 };
    const obj2 = { a: 1, b: 2 };
    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
  });

  it('recursively sorts nested object keys', () => {
    const obj = { z: { y: 1, a: 2 }, a: { z: 3, a: 4 } };
    expect(canonicalJson(obj)).toBe('{"a":{"a":4,"z":3},"z":{"a":2,"y":1}}');
  });

  it('handles nested arrays and objects', () => {
    const complex = { arr: [{ b: 2, a: 1 }], val: true };
    expect(canonicalJson(complex)).toBe('{"arr":[{"a":1,"b":2}],"val":true}');
  });

  it('is idempotent: JSON.parse then re-serialise gives the same result', () => {
    const obj = { signature: '0xabc', schemaVersion: 'v1', generatedAt: 1234567890 };
    const str1 = canonicalJson(obj);
    const reparsed = JSON.parse(str1);
    expect(canonicalJson(reparsed)).toBe(str1);
  });

  it('excludes a field when manually omitted before calling', () => {
    // Simulates the manifest-signing pattern where `signature` is omitted
    const manifest = { schemaVersion: 'v1', generatedAt: 100, signature: { algo: 'secp256k1' } };
    const { signature: _sig, ...unsigned } = manifest;
    const canon = canonicalJson(unsigned);
    expect(canon).not.toContain('signature');
    expect(canon).toContain('schemaVersion');
  });

  describe('bigint serialisation (RFC 8785 alignment)', () => {
    it('emits raw decimal digits without quotes for positive bigint', () => {
      expect(canonicalJson({ n: 12345678901234567890n })).toBe('{"n":12345678901234567890}');
    });

    it('emits raw decimal digits without quotes for zero bigint', () => {
      expect(canonicalJson({ n: 0n })).toBe('{"n":0}');
    });

    it('emits raw decimal digits without quotes for negative bigint', () => {
      expect(canonicalJson({ n: -5n })).toBe('{"n":-5}');
    });

    it('does NOT quote the bigint value (regression guard against JSON.stringify(String(n)))', () => {
      const result = canonicalJson({ n: 42n });
      // Must be {"n":42} not {"n":"42"}
      expect(result).toBe('{"n":42}');
      expect(result).not.toContain('"42"');
    });
  });
});
