// SPDX-License-Identifier: Apache-2.0

import type { StateEntryCounts } from "@jinn-network/chain-environment-record";
import { compareCodeUnitStrings } from "@jinn-network/trust-core";

import type { AnchorCapture } from "./anchor.js";
import {
  mergeIntoStateArtifact,
  stateArtifactEntryCounts,
  type StateArtifact,
  type StateArtifactAccount,
} from "./artifact.js";
import type { BudgetedArchivePort } from "./budget.js";
import { ChainExtractionError } from "./errors.js";
import { stageFail, stageOk, type StageOutcome } from "./failures.js";
import { isEmptyBytes, normalizeAddress, type Hex32, type HexAddress } from "./hex.js";
import { STATE_ARTIFACT_SCHEMA_VERSION } from "./identifiers.js";
import {
  differenceKeySets,
  emptyKeySet,
  keySetIsEmpty,
  keySetWithAccount,
  keySetWithCode,
  keySetWithSlot,
  type StateKeySet,
} from "./key-set.js";
import type { ChainStateDump, StateDumpPort } from "./ports.js";

export interface HarvestOptions {
  readonly journal: StateKeySet;
  readonly anchor: AnchorCapture;
  readonly dump?: StateDumpPort;
  /** Required when `dump` is present; defaults to the connected baseline instance id. */
  readonly instanceId?: string;
}

export interface HarvestResult {
  readonly artifact: StateArtifact;
  readonly entryCounts: StateEntryCounts;
  readonly dumpOmissions: StateKeySet;
  readonly dumpOnlyEntries: StateKeySet;
}

function classifyArchiveError(
  cause: unknown,
): { reason: "archive-budget-exhausted" | "archive-unreachable" | "archive-self-disagreement"; detail: string } {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/Archive budget exhausted/u.test(message)) {
    return { reason: "archive-budget-exhausted", detail: message };
  }
  if (cause instanceof ChainExtractionError && /committed/u.test(message)) {
    return { reason: "archive-self-disagreement", detail: message };
  }
  return { reason: "archive-unreachable", detail: message };
}

function keySetFromDump(dump: ChainStateDump): StateKeySet {
  let keys = emptyKeySet();
  for (const rawAddress of Object.keys(dump.accounts).sort(compareCodeUnitStrings)) {
    const address = normalizeAddress(rawAddress);
    const account = dump.accounts[rawAddress]!;
    keys = keySetWithAccount(keys, address);
    if (account.code !== undefined) keys = keySetWithCode(keys, address);
    if (account.storage !== undefined) {
      for (const slot of Object.keys(account.storage).sort(compareCodeUnitStrings)) {
        keys = keySetWithSlot(keys, address, slot);
      }
    }
  }
  return keys;
}

function touchedAddresses(journal: StateKeySet): readonly HexAddress[] {
  const addresses = new Set<HexAddress>([
    ...journal.accounts,
    ...journal.code,
    ...journal.storage.map((entry) => entry.address),
  ]);
  return [...addresses].sort(compareCodeUnitStrings);
}

export async function harvestTouchedState(
  archive: BudgetedArchivePort,
  options: HarvestOptions,
): Promise<StageOutcome<HarvestResult>> {
  const { journal, anchor } = options;

  if (keySetIsEmpty(journal)) {
    return stageFail(
      "harvest-empty",
      "Nothing was read through the archive port; the journal is empty.",
    );
  }

  const blockNumber = anchor.blockNumber;
  const additions: StateArtifactAccount[] = [];

  try {
    for (const address of touchedAddresses(journal)) {
      const accountState = await archive.getAccount(address, blockNumber);
      const balance = accountState?.balanceWei ?? "0x0";
      const nonce = accountState?.nonce ?? "0x0";

      let code: string | undefined;
      if (journal.code.includes(address)) {
        const codeBytes = await archive.getCode(address, blockNumber);
        code = isEmptyBytes(codeBytes) ? undefined : codeBytes;
      }

      const storageEntry = journal.storage.find((entry) => entry.address === address);
      const storage = [];
      for (const slot of storageEntry?.slots ?? []) {
        const value = await archive.getStorageAt(address, slot, blockNumber);
        storage.push({ slot: slot as Hex32, value });
      }

      additions.push({
        address,
        balance,
        nonce,
        ...(code === undefined ? {} : { code }),
        storage,
      });
    }

    const artifact = mergeIntoStateArtifact({
      schemaVersion: STATE_ARTIFACT_SCHEMA_VERSION,
      anchor: {
        blockNumber: anchor.blockNumber,
        blockHash: anchor.blockHash,
        stateRoot: anchor.stateRoot,
        timestamp: anchor.timestamp,
      },
      accounts: [],
    }, additions);

    let dumpOmissions = emptyKeySet();
    let dumpOnlyEntries = emptyKeySet();

    if (options.dump !== undefined) {
      let dumped: ChainStateDump;
      try {
        dumped = await options.dump.dump(options.instanceId ?? "connected");
      } catch (cause) {
        const { reason, detail } = classifyArchiveError(cause);
        return stageFail(reason, detail);
      }
      const dumpKeys = keySetFromDump(dumped);
      dumpOmissions = differenceKeySets(journal, dumpKeys);
      dumpOnlyEntries = differenceKeySets(dumpKeys, journal);
    }

    return stageOk({
      artifact,
      entryCounts: stateArtifactEntryCounts(artifact),
      dumpOmissions,
      dumpOnlyEntries,
    });
  } catch (cause) {
    const { reason, detail } = classifyArchiveError(cause);
    return stageFail(reason, detail);
  }
}
