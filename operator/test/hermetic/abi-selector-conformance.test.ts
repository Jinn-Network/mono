import { describe, it, expect } from 'vitest';
import { keccak256, toBytes, type Hex } from 'viem';
import { KNOWN_INNER_ERRORS } from '../../src/adapters/mech/safe-revert.js';

/**
 * ABI / selector conformance — the deterministic, consumer-side half of the
 * spec §5 fidelity strategy ("ABI/selector conformance, pinned in CI" +
 * "consumer-contract pairing for shims").
 *
 * The mech adapter decodes on-chain reverts through a HARDCODED selector table
 * (KNOWN_INNER_ERRORS in operator/src/adapters/mech/safe-revert.ts): a 4-byte
 * selector → { name, params } map for JinnRouterV2/V3 + TaskCoordinator errors.
 * If a table entry drifts from the real error signature (a typo in the name, a
 * changed param type, a bad copy-paste of the selector), the adapter silently
 * mis-decodes a real revert — exactly the residual-shim divergence §5 warns
 * about. The selector for `error Name(type1,type2)` is the first 4 bytes of
 * `keccak256("Name(type1,type2)")`, so the table is self-checking: recompute
 * each selector from its canonical signature and assert it matches the key.
 *
 * This is hermetic — no Solidity compile, no snapshot, no network. The OTHER
 * half of §5 (asserting our table against the REAL deployed bytecode, to catch
 * "OLAS upgraded their interface") needs real deployed contracts and lives in
 * the adversarial snapshot suite + the environment suite, not here.
 */

/** Strip parameter names from a `params` string, leaving the comma-joined type list. */
function typesOnly(params: string): string {
  const trimmed = params.trim();
  if (trimmed === '') return '';
  return trimmed
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0]) // first token is the Solidity type
    .join(',');
}

/** 4-byte error selector = first 4 bytes of keccak256 of the canonical signature. */
function selectorFor(name: string, params: string): Hex {
  const signature = `${name}(${typesOnly(params)})`;
  return keccak256(toBytes(signature)).slice(0, 10).toLowerCase() as Hex;
}

describe('mech adapter revert-selector conformance (spec §5)', () => {
  it('every KNOWN_INNER_ERRORS selector matches keccak256 of its canonical signature', () => {
    const drift: string[] = [];
    for (const [selector, { name, params }] of Object.entries(KNOWN_INNER_ERRORS)) {
      const expected = selectorFor(name, params);
      if (expected !== selector.toLowerCase()) {
        drift.push(
          `${name}(${typesOnly(params)}): table has ${selector}, signature computes ${expected}`,
        );
      }
    }
    expect(drift, `revert selector table drifted from the canonical signatures:\n${drift.join('\n')}`).toEqual([]);
  });

  it('has no duplicate selectors (one selector cannot decode to two errors)', () => {
    const keys = Object.keys(KNOWN_INNER_ERRORS).map((k) => k.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every selector is a well-formed 4-byte hex string', () => {
    for (const selector of Object.keys(KNOWN_INNER_ERRORS)) {
      expect(selector).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });
});
