// SPDX-License-Identifier: MIT

import type { ContractGeneration } from "@jinn-network/marketplace-binding";
import type { Address, Hex } from "viem";

export type FinalityTier = "safe" | "finalized";

/**
 * EVM derivation annotation from discovery design §6.2 plus the three registered additions
 * ratified by record-discovery Addendum 2026-07-28-c / program ruling §7.21.
 */
export interface DerivationAnnotation {
  readonly chainId: number;
  readonly contract: Address;
  readonly event: string;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly finalityTier: FinalityTier;
  readonly contractGeneration: ContractGeneration;
}

export interface DerivationLog {
  readonly chainId: number;
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly finalityTier: FinalityTier;
}

export function createDerivationAnnotation(
  log: DerivationLog,
  event: string,
  contractGeneration: ContractGeneration,
): DerivationAnnotation {
  return {
    chainId: log.chainId,
    contract: log.address,
    event,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    finalityTier: log.finalityTier,
    contractGeneration,
  };
}
