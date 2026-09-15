import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
 * Self-consistency is not enough on its own — an entry can agree with itself and
 * still name an error the contract does not declare — so one assertion below
 * also compares the table against `@jinn-network/contract-abis`' COMMITTED full
 * ABIs (#4286). Reading a committed JSON file keeps the suite hermetic.
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

/** Comma-joined canonical input type list of an `error` item in a committed full ABI. */
function errorTypesByName(contract: string): ReadonlyMap<string, string> {
  const require = createRequire(import.meta.url);
  const path = require.resolve(`@jinn-network/contract-abis/generated/full/${contract}.json`);
  const abi = JSON.parse(readFileSync(path, 'utf8')) as readonly {
    readonly type: string;
    readonly name?: string;
    readonly inputs?: readonly { readonly type: string }[];
  }[];
  return new Map(
    abi
      .filter((item) => item.type === 'error' && item.name !== undefined)
      .map((item) => [item.name as string, (item.inputs ?? []).map((i) => i.type).join(',')]),
  );
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

  /**
   * The self-consistency assertions above prove each entry agrees with ITSELF. They cannot catch
   * an entry that names an error the contract does not have, or the wrong parameter types for one
   * it does. This compares the table against compile output (#4286).
   *
   * One direction only, deliberately: JinnRouterV3 declares more errors than the table carries, and
   * JinnRouterV2 is not in `contracts.manifest.json` at all — so an entry matching neither ABI is
   * skipped, not failed. A completeness assertion would be red on arrival and would say nothing
   * about drift.
   */
  it('every table entry that a committed full ABI declares has that ABI\'s parameter types', () => {
    const declared = ['JinnRouterV3', 'TaskCoordinator'].map(
      (contract) => [contract, errorTypesByName(contract)] as const,
    );
    const mismatches: string[] = [];
    let matched = 0;
    for (const { name, params } of Object.values(KNOWN_INNER_ERRORS)) {
      for (const [contract, byName] of declared) {
        const abiTypes = byName.get(name);
        if (abiTypes === undefined) continue;
        matched += 1;
        if (abiTypes !== typesOnly(params)) {
          mismatches.push(`${name}: table ${typesOnly(params)} vs ${contract} ${abiTypes}`);
        }
      }
    }
    expect(matched).toBeGreaterThan(0);
    expect(mismatches, `revert table drifted from compile output:\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('every selector is a well-formed 4-byte hex string', () => {
    for (const selector of Object.keys(KNOWN_INNER_ERRORS)) {
      expect(selector).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });
});
