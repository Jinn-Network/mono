// SPDX-License-Identifier: Apache-2.0

import type { StateEntryCounts } from "@jinn-network/chain-environment-record";
import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
  type Sha256Digest,
} from "@jinn-network/trust-core";
import { z } from "zod";

import { invalidInput } from "./errors.js";
import {
  Hex32Schema,
  HexAddressSchema,
  HexBytesSchema,
  HexQuantitySchema,
  isEmptyBytes,
  type Hex32,
  type HexAddress,
} from "./hex.js";
import { STATE_ARTIFACT_SCHEMA_VERSION } from "./identifiers.js";
import {
  emptyKeySet,
  keySetWithAccount,
  keySetWithCode,
  keySetWithSlot,
  type StateKeySet,
} from "./key-set.js";

/** Runtime-neutral by design: a third party re-verifying an anchored-subset record
 * (design §5.4) must be able to read the slice without any runtime's internals. CE3's
 * materializer translates it into the runtime's own load mechanism. */
export const STATE_ARTIFACT_FORMAT = Object.freeze({ id: "jinn.chain-state-slice", version: "1" });

const StorageEntrySchema = z.strictObject({
  slot: Hex32Schema,
  value: Hex32Schema,
});

export const StateArtifactAccountSchema = z.strictObject({
  address: HexAddressSchema,
  balance: HexQuantitySchema,
  nonce: HexQuantitySchema,
  /** Present iff the account carries code. Absent and `"0x"` are the same world; the
   * schema admits only one spelling so two artifacts of one world cannot differ. */
  code: HexBytesSchema.optional(),
  storage: z.array(StorageEntrySchema),
});
export type StateArtifactAccount = z.infer<typeof StateArtifactAccountSchema>;

export const StateArtifactSchema = z.strictObject({
  schemaVersion: z.literal(STATE_ARTIFACT_SCHEMA_VERSION),
  anchor: z.strictObject({
    blockNumber: z.number().int().nonnegative(),
    blockHash: Hex32Schema,
    stateRoot: Hex32Schema,
    timestamp: z.number().int().nonnegative(),
  }),
  accounts: z.array(StateArtifactAccountSchema),
});
export type StateArtifact = z.infer<typeof StateArtifactSchema>;

function assertOrdered(artifact: StateArtifact): void {
  const addresses = artifact.accounts.map((account) => account.address);
  const sorted = [...addresses].sort(compareCodeUnitStrings);
  if (JSON.stringify(addresses) !== JSON.stringify(sorted)) {
    invalidInput("State artifact accounts must be sorted by address.");
  }
  if (new Set(addresses).size !== addresses.length) {
    invalidInput("State artifact carries a duplicate account address.");
  }
  for (const account of artifact.accounts) {
    const slots = account.storage.map((entry) => entry.slot);
    const sortedSlots = [...slots].sort(compareCodeUnitStrings);
    if (JSON.stringify(slots) !== JSON.stringify(sortedSlots)) {
      invalidInput(`Storage slots for ${account.address} must be sorted.`);
    }
    if (new Set(slots).size !== slots.length) {
      invalidInput(`Storage for ${account.address} carries a duplicate slot.`);
    }
    if (account.code !== undefined && isEmptyBytes(account.code)) {
      invalidInput(`${account.address} declares empty code; omit the field instead.`);
    }
  }
}

export function serializeStateArtifact(artifact: StateArtifact): Uint8Array {
  const parsed = StateArtifactSchema.safeParse(artifact);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    invalidInput(first
      ? `Invalid state artifact at /${first.path.join("/")}: ${first.message}`
      : "Invalid state artifact.");
  }
  assertOrdered(parsed.data);
  return canonicalJsonBytes(parsed.data);
}

export function parseStateArtifact(bytes: Uint8Array): StateArtifact {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    invalidInput("State artifact is not valid UTF-8 JSON.", cause);
  }
  const parsed = StateArtifactSchema.safeParse(decoded);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    invalidInput(first
      ? `Invalid state artifact at /${first.path.join("/")}: ${first.message}`
      : "Invalid state artifact.");
  }
  assertOrdered(parsed.data);
  return parsed.data;
}

export function stateArtifactDigest(bytes: Uint8Array): Sha256Digest {
  return recordDigest(bytes);
}

/** Every key the artifact commits. The widen loop subtracts this from what a run read. */
export function stateArtifactKeySet(artifact: StateArtifact): StateKeySet {
  let keys = emptyKeySet();
  for (const account of artifact.accounts) {
    keys = keySetWithAccount(keys, account.address);
    if (account.code !== undefined) keys = keySetWithCode(keys, account.address);
    for (const entry of account.storage) keys = keySetWithSlot(keys, account.address, entry.slot);
  }
  return keys;
}

export function stateArtifactEntryCount(artifact: StateArtifact): number {
  return artifact.accounts.reduce(
    (total, account) => total + 1 + (account.code === undefined ? 0 : 1) + account.storage.length,
    0,
  );
}

/** CE1's census type. One entry per account, per code blob, per slot -- the denominator
 * the record's E13 arithmetic balances against. */
export function stateArtifactEntryCounts(artifact: StateArtifact): StateEntryCounts {
  return {
    accounts: artifact.accounts.length,
    codeEntries: artifact.accounts.filter((account) => account.code !== undefined).length,
    storageSlots: artifact.accounts.reduce((total, account) => total + account.storage.length, 0),
  };
}

/**
 * Widening is additive. A merge that would *change* an already-committed value is
 * refused: the anchor is frozen, so a differing value means the archive disagreed with
 * itself between calls (design §5.2), and quietly taking the newer one would erase the
 * evidence of that.
 */
export function mergeIntoStateArtifact(
  artifact: StateArtifact,
  additions: readonly StateArtifactAccount[],
): StateArtifact {
  const byAddress = new Map<HexAddress, StateArtifactAccount>(
    artifact.accounts.map((account) => [account.address, account]),
  );

  for (const addition of additions) {
    const existing = byAddress.get(addition.address);
    if (existing === undefined) {
      byAddress.set(addition.address, {
        ...addition,
        storage: [...addition.storage].sort((left, right) =>
          compareCodeUnitStrings(left.slot, right.slot)),
      });
      continue;
    }
    if (existing.balance !== addition.balance || existing.nonce !== addition.nonce) {
      invalidInput(
        `Widening would change committed account fields for ${addition.address}: `
        + `balance ${existing.balance} -> ${addition.balance}, nonce ${existing.nonce} -> ${addition.nonce}.`,
      );
    }
    if (existing.code !== undefined && addition.code !== undefined && existing.code !== addition.code) {
      invalidInput(`Widening would change committed code for ${addition.address}.`);
    }
    const slots = new Map<Hex32, string>(existing.storage.map((entry) => [entry.slot, entry.value]));
    for (const entry of addition.storage) {
      const committed = slots.get(entry.slot);
      if (committed !== undefined && committed !== entry.value) {
        invalidInput(
          `Widening would change committed storage ${addition.address}/${entry.slot}: `
          + `${committed} -> ${entry.value}.`,
        );
      }
      slots.set(entry.slot, entry.value);
    }
    const code = existing.code ?? addition.code;
    const storage = [...slots.entries()]
      .map(([slot, value]) => ({ slot, value }))
      .sort((left, right) => compareCodeUnitStrings(left.slot, right.slot));
    byAddress.set(addition.address, code === undefined
      ? { address: existing.address, balance: existing.balance, nonce: existing.nonce, storage }
      : { address: existing.address, balance: existing.balance, nonce: existing.nonce, code, storage });
  }

  return {
    schemaVersion: artifact.schemaVersion,
    anchor: artifact.anchor,
    accounts: [...byAddress.values()].sort((left, right) =>
      compareCodeUnitStrings(left.address, right.address)),
  };
}
