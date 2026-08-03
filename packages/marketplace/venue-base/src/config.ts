// SPDX-License-Identifier: MIT

// The host-supplied configuration `createBaseVenue` (Task 17) composes against. Every port takes
// an injected viem `WalletClient` (signer-injection only, program §6 contract 11) and every
// persistent artefact lives under the one host-supplied `stateDbPath` (never a home directory or
// environment-derived default).
import type { Address, PublicClient, WalletClient } from "viem";
import type { SafeBroadcastOptions } from "./broadcast/safe-broadcaster.js";
import type { IpfsPinPort, MarketplaceChainConfig, SettlementPorts } from "@jinn-network/marketplace-binding";
import type { ProtocolObservation } from "@jinn-network/task-execution-protocol";

// Empty extension points: Tasks 7-14 declare the real shape of each of these alongside the
// component they configure (the chain log source, the Safe broadcaster, the finality waiter and
// the delivery waiter respectively) and wire it in here.
export interface ChainLogSourceOptions {}
export interface FinalityWaiterOptions {}
export interface DeliveryWaiterOptions {}

export interface BaseVenueConfig {
  readonly chain: MarketplaceChainConfig;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly safeAddress: Address;
  readonly stateDbPath: string;
  readonly priorityMech: Address;
  readonly pin: IpfsPinPort["pin"];
  readonly verifySettlementGrade: SettlementPorts["verifySettlementGrade"];
  readonly isAuthorizedMechOrigin: (address: Address) => boolean;
  /** The host's projector-fed observation source (every observation ever projected). */
  readonly observations: () => Promise<readonly ProtocolObservation[]>;
  readonly logSource?: ChainLogSourceOptions;
  readonly broadcast?: SafeBroadcastOptions;
  readonly finality?: FinalityWaiterOptions;
  readonly deliveryWait?: DeliveryWaiterOptions;
}
