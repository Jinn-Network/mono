// SPDX-License-Identifier: Apache-2.0

import type { ChainStateBackend } from "@jinn-network/chain-environment-record";
import { keccak_256 } from "@noble/hashes/sha3.js";

import type { StateArtifact, StateArtifactAccount } from "./artifact.js";
import type { BudgetedArchivePort } from "./budget.js";
import {
  isEmptyBytes,
  normalizeAddress,
  normalizeHex32,
  normalizeQuantity,
  normalizeSlot,
  type Hex32,
  type HexAddress,
} from "./hex.js";
import {
  emptyKeySet,
  keySetWithAccount,
  keySetWithCode,
  keySetWithSlot,
  type StateKeySet,
} from "./key-set.js";

const EMPTY_CODE_HASH = `0x${"c5".repeat(32)}` as Hex32;

function codeHashFromBytes(code: string): Hex32 {
  if (isEmptyBytes(code)) return EMPTY_CODE_HASH;
  const body = code.startsWith("0x") ? code.slice(2) : code;
  const bytes = Uint8Array.from((body.match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)));
  return normalizeHex32(`0x${[...keccak_256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`);
}

function findAccount(artifact: StateArtifact, address: HexAddress): StateArtifactAccount | undefined {
  return artifact.accounts.find((account) => account.address === address);
}

function slotValue(account: StateArtifactAccount, slot: Hex32): Hex32 | undefined {
  const entry = account.storage.find((item) => item.slot === slot);
  return entry === undefined ? undefined : normalizeHex32(entry.value);
}

export interface LayeredStateBackend extends ChainStateBackend {
  /** Keys that were not in the artifact and were fetched from the archive. */
  misses(): StateKeySet;
}

/**
 * Artifact first, archive on miss, every miss journaled. The miss set is the widening delta.
 * `getBlockHeader` passes through to the archive; it is not a closure key.
 */
export function createLayeredStateBackend(
  artifact: StateArtifact,
  archive: BudgetedArchivePort,
): LayeredStateBackend {
  let misses = emptyKeySet();
  const blockNumber = artifact.anchor.blockNumber;

  function recordAccountMiss(address: HexAddress): void {
    misses = keySetWithAccount(misses, address);
  }

  function recordCodeMiss(address: HexAddress): void {
    misses = keySetWithCode(misses, address);
  }

  function recordSlotMiss(address: HexAddress, slot: Hex32): void {
    misses = keySetWithSlot(misses, address, slot);
  }

  return {
    misses: () => misses,

    async getAccount(address, block) {
      const account = normalizeAddress(address);
      const entry = findAccount(artifact, account);
      if (entry !== undefined) {
        const code = entry.code ?? "0x";
        return {
          nonce: normalizeQuantity(entry.nonce),
          balanceWei: normalizeQuantity(entry.balance),
          codeHash: codeHashFromBytes(code),
        };
      }
      recordAccountMiss(account);
      const state = await archive.getAccount(account, block);
      if (state === undefined) return undefined;
      return {
        nonce: state.nonce,
        balanceWei: state.balanceWei,
        codeHash: state.codeHash,
        ...(state.storageRoot === undefined ? {} : { storageRoot: state.storageRoot }),
      };
    },

    async getCode(address, block) {
      const account = normalizeAddress(address);
      const entry = findAccount(artifact, account);
      if (entry?.code !== undefined) {
        return entry.code;
      }
      recordCodeMiss(account);
      return archive.getCode(account, block);
    },

    async getStorageAt(address, slot, block) {
      const account = normalizeAddress(address);
      const key = normalizeSlot(slot);
      const entry = findAccount(artifact, account);
      const committed = entry === undefined ? undefined : slotValue(entry, key);
      if (committed !== undefined) {
        return committed;
      }
      recordSlotMiss(account, key);
      return archive.getStorageAt(account, key, block);
    },

    async getBlockHeader(block) {
      return archive.getBlockHeader(block);
    },
  };
}
