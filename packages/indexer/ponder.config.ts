/**
 * Ponder configuration for the Jinn protocol indexer.
 *
 * Chains: Base Sepolia (84532) + Sepolia L1 (11155111).
 *
 *   Base mainnet (8453) is intentionally NOT indexed yet. The public
 *   mainnet.base.org endpoint cannot sustain the ~5M-block historical sync
 *   (429-storms), so mainnet indexing waits on a real RPC (Alchemy / QuickNode
 *   / HyperSync-backed URL). When that's available, add a `base` entry to
 *   `chains` and a `base` entry to each contract's `chain` block using the
 *   mainnet addresses in the comment below, and set PONDER_RPC_URL_8453.
 *   Tracked in jinn-mono-280n.4.
 *
 *   JinnDistributor is on Sepolia L1 (chain 11155111), NOT Base. It distributes
 *   JINN tokens from the L1 DAO. The per-channel split
 *   (wCreation/wRestorationDelivery/wEvaluationDelivery) is reconstructed from
 *   JinnRouter activity counts, not from the Claimed event.
 *
 * Contracts: JinnRouter, IdentityRegistry, JinnDistributor.
 *
 * Environment variables:
 *   PONDER_RPC_URL_84532          — RPC URL for Base Sepolia (defaults to the public
 *                                   endpoint; set a Tenderly/Alchemy/etc. URL in
 *                                   production for headroom).
 *   PONDER_RPC_URL_11155111       — RPC URL for Sepolia L1 (for JinnDistributor;
 *                                   defaults to a public endpoint, set a real RPC in
 *                                   production).
 *   JINN_INDEXER_ENRICH_ENVELOPES — set false/0 to skip per-envelope IPFS fetch;
 *                                   the explorer's harness/mode/plugin/model facets
 *                                   and freeze integrity won't populate. Default: enabled.
 *   JINN_IPFS_GATEWAY_URL         — IPFS gateway for envelope enrichment.
 *                                   Default: https://gateway.autonolas.tech.
 *
 * Database:
 *   No DATABASE_URL        — uses PGlite (embedded Postgres) for local dev; data in .ponder/
 *   DATABASE_URL=postgres://... — uses external Postgres for production (Railway etc.)
 *   DATABASE_SCHEMA        — per-deployment schema for rolling deploys (views pattern).
 *
 * HyperSync:
 *   Ponder 0.16.x has no first-class HyperSync transport. Use a HyperSync-backed
 *   RPC URL (e.g. from Envio) in PONDER_RPC_URL_* — Ponder treats it as a normal
 *   JSON-RPC endpoint.
 *
 * Addresses:
 *   JinnRouter testnet:     0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9  (Base Sepolia)
 *   JinnRouter mainnet:     0xfFa7118A3D820cd4E820010837D65FAfF463181B  (Base mainnet — not yet indexed)
 *   IdentityRegistry 84532: 0x8004A818BFB912233c491871b3d84c89A494BD9e
 *   IdentityRegistry 8453:  0x8004A169FB4a3325136EB29fA0ceB6D2e539a432   (not yet indexed)
 *   JinnDistributor 11155111: 0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6  (Sepolia L1 — NOT Base)
 *
 * Start blocks:
 *   JinnRouter testnet:       41_153_291 (from client/src/adapters/mech/adapter.ts)
 *   JinnRouter mainnet:       25_000_000 (conservative; tighten when first events observed)
 *   IdentityRegistry 84532:   41_100_000 (per DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK)
 *   IdentityRegistry 8453:    25_000_000
 *   JinnDistributor 11155111:  8_000_000 (conservative; deployed 2026-04-29 — source:
 *                             client/deployments/deployment-jinn-mvi-l1-sepolia.json)
 *                             // TODO(ebu7.2): tighten to the JinnDistributor deploy block
 */
import { createConfig } from 'ponder';
import { JINN_ROUTER_ABI } from './abis/JinnRouter.js';
import { IDENTITY_REGISTRY_ABI } from './abis/IdentityRegistry.js';
import { JINN_DISTRIBUTOR_ABI } from './abis/JinnDistributor.js';

export default createConfig({
  chains: {
    baseSepolia: {
      id: 84532,
      rpc: process.env['PONDER_RPC_URL_84532'] ?? 'https://sepolia.base.org',
    },
    sepolia: {
      id: 11155111,
      rpc: process.env['PONDER_RPC_URL_11155111'] ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    },
  },
  contracts: {
    JinnRouter: {
      abi: JINN_ROUTER_ABI,
      chain: {
        baseSepolia: {
          address: '0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9',
          startBlock: 41_153_291,
        },
      },
    },
    IdentityRegistry: {
      abi: IDENTITY_REGISTRY_ABI,
      chain: {
        baseSepolia: {
          address: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
          startBlock: 41_100_000,
        },
      },
    },
    JinnDistributor: {
      abi: JINN_DISTRIBUTOR_ABI,
      chain: {
        sepolia: {
          address: '0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6', // Sepolia L1 — client/deployments/deployment-jinn-mvi-l1-sepolia.json
          // First on-chain Claimed event is at Sepolia block 10_756_427 (from the live cast logs scan
          // 2026-05-13). Starting a few hundred blocks earlier to be conservative and not miss any
          // earlier events. Cuts historical sync from ~2.85M blocks (when this was 8_000_000) to ~100K
          // — minutes vs hours on the Alchemy RPC. Resync requires a DATABASE_SCHEMA bump.
          startBlock: 10_756_000,
        },
      },
    },
  },
});
