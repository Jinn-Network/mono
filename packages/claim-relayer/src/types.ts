import type { Address, Hex } from 'viem';

export interface ClaimSnapshot {
  claimId: bigint;
  serviceId: bigint;
  taskCreationWeight: bigint;
  solutionDeliveryWeight: bigint;
  verdictDeliveryWeight: bigint;
  multisig: Address;
  claimer: Address;
  l2BlockNumber: bigint;
  l2LogIndex: number;
  l2TxHash: Hex;
}

export interface MessengerFixture {
  serviceId: bigint;
  taskCreationWeight: bigint;
  solutionDeliveryWeight: bigint;
  verdictDeliveryWeight: bigint;
  multisig: Address;
}

export interface RelayerStats {
  scannedTickets: number;
  claimedTickets: number;
  skippedTickets: number;
  failedTickets: number;
  lastError: string | null;
  startedAt: string;
  ready: boolean;
  consecutivePollsWithoutProgress: number;
  staleCheckpoint: boolean;
}
