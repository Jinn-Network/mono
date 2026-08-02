// SPDX-License-Identifier: Apache-2.0

import { invalidInput } from "./errors.js";
import { normalizeAddress, normalizeHex32, normalizeSlot } from "./hex.js";
import type { ArchiveBudgetLimits } from "./identifiers.js";
import {
  emptyKeySet,
  keySetWithAccount,
  keySetWithCode,
  keySetWithSlot,
  type StateKeySet,
} from "./key-set.js";
import type {
  ArchiveAccountProof,
  ArchiveAccountState,
  ArchiveBlockHeader,
  ArchiveRpcPort,
  ArchiveUsage,
  BlockSelector,
} from "./ports.js";
import type { Hex32, HexAddress, HexBytes } from "./hex.js";

export interface BudgetedArchivePort extends ArchiveRpcPort {
  /** The state keys read through this port so far. The harvest ground truth: a forked
   * instance fetches lazily, so what it fetched *is* what execution touched. */
  journal(): StateKeySet;
  usage(): ArchiveUsage;
}

/** Cost proxy: the serialized size of what came back. Exact enough to bound spend, and
 * it needs no cooperation from the host's transport. */
function measure(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * Wraps the injected port with the two ceilings and the access journal. Every module
 * downstream takes the *budgeted* port, so there is no code path in this package that
 * can call an archive without spending against a declared bound.
 */
export function createBudgetedArchivePort(
  port: ArchiveRpcPort,
  limits: ArchiveBudgetLimits,
): BudgetedArchivePort {
  if (!Number.isInteger(limits.maxCalls) || limits.maxCalls <= 0) {
    invalidInput(`maxCalls must be a positive integer; received ${String(limits.maxCalls)}.`);
  }
  if (!Number.isInteger(limits.maxBytes) || limits.maxBytes <= 0) {
    invalidInput(`maxBytes must be a positive integer; received ${String(limits.maxBytes)}.`);
  }

  let calls = 0;
  let bytes = 0;
  let exhausted: "calls" | "bytes" | undefined;
  let journal = emptyKeySet();

  function refuse(kind: "calls" | "bytes"): never {
    exhausted = kind;
    invalidInput(
      kind === "calls"
        ? `Archive budget exhausted: maxCalls=${limits.maxCalls} reached after ${calls} calls.`
        : `Archive budget exhausted: maxBytes=${limits.maxBytes} reached after ${bytes} bytes.`,
    );
  }

  async function spend<T>(operation: () => Promise<T>): Promise<T> {
    if (exhausted !== undefined) refuse(exhausted);
    if (calls + 1 > limits.maxCalls) refuse("calls");
    calls += 1;
    const result = await operation();
    bytes += measure(result);
    if (bytes > limits.maxBytes) refuse("bytes");
    return result;
  }

  return {
    journal: () => journal,
    usage: (): ArchiveUsage => ({
      calls,
      bytes,
      limits,
      ...(exhausted === undefined ? {} : { exhausted }),
    }),

    async getBlockHeader(selector: BlockSelector, signal?: AbortSignal): Promise<ArchiveBlockHeader> {
      // Headers are chain metadata, not agent-visible state: journaling them would
      // widen slices with entries no execution ever read.
      return spend(() => port.getBlockHeader(selector, signal));
    },

    async getAccount(address: HexAddress, block: number, signal?: AbortSignal): Promise<ArchiveAccountState | undefined> {
      const account = normalizeAddress(address);
      const state = await spend(() => port.getAccount(account, block, signal));
      // Journaled whether or not the account exists: execution READ it, so the sealed
      // world must answer the same way, and "absent" is an answer.
      journal = keySetWithAccount(journal, account);
      return state;
    },

    async getCode(address: HexAddress, block: number, signal?: AbortSignal): Promise<HexBytes> {
      const account = normalizeAddress(address);
      const code = await spend(() => port.getCode(account, block, signal));
      journal = keySetWithCode(journal, account);
      return code;
    },

    async getStorageAt(address: HexAddress, slot: Hex32, block: number, signal?: AbortSignal): Promise<Hex32> {
      const account = normalizeAddress(address);
      const key = normalizeSlot(slot);
      const value = await spend(() => port.getStorageAt(account, key, block, signal));
      journal = keySetWithSlot(journal, account, key);
      return normalizeHex32(value);
    },

    async getProof(
      address: HexAddress,
      slots: readonly Hex32[],
      block: number,
      signal?: AbortSignal,
    ): Promise<ArchiveAccountProof> {
      // Proofs are evidence about state already decided upon, not a discovery read.
      return spend(() => port.getProof(
        normalizeAddress(address),
        slots.map((slot) => normalizeSlot(slot)),
        block,
        signal,
      ));
    },
  };
}
