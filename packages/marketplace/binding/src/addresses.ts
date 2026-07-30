// SPDX-License-Identifier: MIT

import type { ContractGeneration } from "./generation.js";

/**
 * The chain config every generation-aware leg reads. Both today-mode and revised-mode configs
 * share this shape; only the addresses (and eventually the ABI set behind them) differ.
 */
export interface MarketplaceChainConfig {
  readonly chainId: number;
  readonly taskCoordinator: `0x${string}`;
  readonly jinnRouter: `0x${string}`;
  readonly mechMarketplace: `0x${string}`;
  readonly activityChecker: `0x${string}`;
  readonly generation: ContractGeneration;
}

/**
 * The deployed today-mode addresses on Base Sepolia (Preflight-confirmed against
 * `contracts/deployment-task-coordinator-router-v3-baseSepolia.json`). Pinned as constants
 * rather than read from the file at runtime -- the binding never depends on a filesystem read to
 * know which contracts it targets.
 */
export const BASE_SEPOLIA_TODAY: MarketplaceChainConfig = {
  chainId: 84532,
  taskCoordinator: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
  jinnRouter: "0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247",
  mechMarketplace: "0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7",
  activityChecker: "0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70",
  generation: "today",
};
