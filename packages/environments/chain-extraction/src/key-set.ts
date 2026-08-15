// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { normalizeAddress, normalizeSlot, type Hex32, type HexAddress } from "./hex.js";

/**
 * The set of state keys a run touched, an artifact carries, or a widening must add.
 * Canonical by construction: sorted, deduplicated, normalized. Two sets are equal iff
 * their digests are equal, which is what makes "what is this blackholed run missing?"
 * a subtraction instead of a judgement call.
 */
export interface StateKeySet {
  /** Accounts whose balance/nonce were read. */
  readonly accounts: readonly HexAddress[];
  /** Accounts whose code was read. A superset relationship with `accounts` is not
   * assumed: code can be read without the account fields and vice versa. */
  readonly code: readonly HexAddress[];
  readonly storage: readonly { readonly address: HexAddress; readonly slots: readonly Hex32[] }[];
}

export function emptyKeySet(): StateKeySet {
  return { accounts: [], code: [], storage: [] };
}

function withSortedInsert(values: readonly string[], value: string): readonly string[] {
  if (values.includes(value)) return values;
  return [...values, value].sort(compareCodeUnitStrings);
}

export function keySetWithAccount(set: StateKeySet, address: string): StateKeySet {
  return { ...set, accounts: withSortedInsert(set.accounts, normalizeAddress(address)) };
}

export function keySetWithCode(set: StateKeySet, address: string): StateKeySet {
  return { ...set, code: withSortedInsert(set.code, normalizeAddress(address)) };
}

export function keySetWithSlot(set: StateKeySet, address: string, slot: string): StateKeySet {
  const account = normalizeAddress(address);
  const key = normalizeSlot(slot);
  const existing = set.storage.find((entry) => entry.address === account);
  const storage = existing === undefined
    ? [...set.storage, { address: account, slots: [key] }]
    : set.storage.map((entry) => entry.address === account
      ? { address: account, slots: withSortedInsert(entry.slots, key) }
      : entry);
  return {
    ...set,
    storage: storage
      .map((entry) => ({ address: entry.address, slots: entry.slots }))
      .sort((left, right) => compareCodeUnitStrings(left.address, right.address)),
  };
}

export function unionKeySets(left: StateKeySet, right: StateKeySet): StateKeySet {
  let merged: StateKeySet = left;
  for (const address of right.accounts) merged = keySetWithAccount(merged, address);
  for (const address of right.code) merged = keySetWithCode(merged, address);
  for (const entry of right.storage) {
    for (const slot of entry.slots) merged = keySetWithSlot(merged, entry.address, slot);
  }
  return merged;
}

/** Everything in `left` that `right` does not carry. The widening delta. */
export function differenceKeySets(left: StateKeySet, right: StateKeySet): StateKeySet {
  const rightSlots = new Map(right.storage.map((entry) => [entry.address, new Set(entry.slots)]));
  return {
    accounts: left.accounts.filter((address) => !right.accounts.includes(address)),
    code: left.code.filter((address) => !right.code.includes(address)),
    storage: left.storage
      .map((entry) => ({
        address: entry.address,
        slots: entry.slots.filter((slot) => !(rightSlots.get(entry.address)?.has(slot) ?? false)),
      }))
      .filter((entry) => entry.slots.length > 0),
  };
}

export function keySetSize(set: StateKeySet): number {
  return set.accounts.length
    + set.code.length
    + set.storage.reduce((total, entry) => total + entry.slots.length, 0);
}

export function keySetIsEmpty(set: StateKeySet): boolean {
  return keySetSize(set) === 0;
}

export function keySetDigest(set: StateKeySet): Sha256Digest {
  return recordDigest(canonicalJsonBytes(set));
}
