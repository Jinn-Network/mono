/**
 * Ponder configuration for the Jinn protocol indexer.
 *
 * Chains: Base Sepolia (84532) only, for now.
 *
 *   Base mainnet (8453) is intentionally NOT indexed yet. The public
 *   mainnet.base.org endpoint cannot sustain the ~5M-block historical sync
 *   (429-storms), so mainnet indexing waits on a real RPC (Alchemy / QuickNode
 *   / HyperSync-backed URL). When that's available, add a `base` entry to
 *   `chains` and a `base` entry to each contract's `chain` block using the
 *   mainnet addresses in the comment below, and set PONDER_RPC_URL_8453.
 *   Tracked in jinn-mono-280n.4.
 *
 * Contracts: JinnRouter and IdentityRegistry.
 *
 * Environment variables:
 *   PONDER_RPC_URL_84532   — RPC URL for Base Sepolia (defaults to the public
 *                            endpoint; set a Tenderly/Alchemy/etc. URL in
 *                            production for headroom).
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
 *
 * Start blocks:
 *   JinnRouter testnet:     41_153_291 (from client/src/adapters/mech/adapter.ts)
 *   JinnRouter mainnet:     25_000_000 (conservative; tighten when first events observed)
 *   IdentityRegistry 84532: 41_100_000 (per DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK)
 *   IdentityRegistry 8453:  25_000_000
 */
import { createConfig } from 'ponder';
import { JINN_ROUTER_ABI } from './abis/JinnRouter.js';
import { IDENTITY_REGISTRY_ABI } from './abis/IdentityRegistry.js';

export default createConfig({
  chains: {
    baseSepolia: {
      id: 84532,
      rpc: process.env['PONDER_RPC_URL_84532'] ?? 'https://sepolia.base.org',
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
  },
});
