/**
 * Ponder configuration for the Jinn protocol indexer.
 *
 * Chains: Base Sepolia (84532).
 *
 *   Base mainnet (8453) is intentionally NOT indexed yet. The public
 *   mainnet.base.org endpoint cannot sustain the ~5M-block historical sync
 *   (429-storms), so mainnet indexing waits on a real RPC (Alchemy / QuickNode
 *   / HyperSync-backed URL). When that's available, add a `base` entry to
 *   `chains` and a `base` entry to each contract's `chain` block using the
 *   mainnet addresses in the comment below, and set PONDER_RPC_URL_8453.
 *   Tracked in jinn-mono-280n.4.
 *
 * Contracts: JinnRouter, IdentityRegistry.
 *
 * Environment variables:
 *   PONDER_RPC_URL_84532          — RPC URL for Base Sepolia (defaults to the public
 *                                   endpoint; set a Tenderly/Alchemy/etc. URL in
 *                                   production for headroom).
 *   JINN_INDEXER_ENRICH_ENVELOPES — dual meaning since #779. EXECUTION-envelope
 *                                   enrichment (attemptEnvelopeMeta + manifest +
 *                                   checkpoint) defaults ENABLED; set false/0 to
 *                                   skip (harness/mode/plugin/model facets + freeze
 *                                   integrity won't populate). The EVALUATION
 *                                   (verdict) path defaults OFF in-handler and is
 *                                   owned by the standalone enrichment worker
 *                                   (packages/indexer-enrichment); set true/1 to
 *                                   restore in-handler verdict enrichment (rollback).
 *   JINN_IPFS_GATEWAY_URL         — IPFS gateway for envelope enrichment (shared
 *                                   with the enrichment worker).
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
 *   JinnRouter testnet:     0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247  (Base Sepolia — tokenless-OLAS trimmed router)
 *   JinnRouter mainnet:     0xfFa7118A3D820cd4E820010837D65FAfF463181B  (Base mainnet — not yet indexed)
 *   IdentityRegistry 84532: 0x8004A818BFB912233c491871b3d84c89A494BD9e
 *   IdentityRegistry 8453:  0x8004A169FB4a3325136EB29fA0ceB6D2e539a432   (not yet indexed)
 *
 * Start blocks:
 *   JinnRouter testnet:       43_523_445 (0x6f47… deploy block, Base Sepolia)
 *   JinnRouter mainnet:       25_000_000 (conservative; tighten when first events observed)
 *   IdentityRegistry 84532:   41_100_000 (per DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK)
 *   IdentityRegistry 8453:    25_000_000
 */
import { createConfig } from 'ponder';
import { JINN_ROUTER_ABI } from './abis/JinnRouter.js';
import { IDENTITY_REGISTRY_ABI } from './abis/IdentityRegistry.js';
import { EXTERNAL_STAKING_DISTRIBUTOR_ABI } from './abis/ExternalStakingDistributor.js';
import { STOLAS_STAKING_PROXY_ABI } from './abis/StolasStakingProxy.js';
import {
  BASE_SEPOLIA_IDENTITY_REGISTRY_ADDRESS,
  BASE_SEPOLIA_IDENTITY_REGISTRY_START_BLOCK,
  BASE_SEPOLIA_JINN_ROUTER_ADDRESS,
  BASE_SEPOLIA_JINN_ROUTER_START_BLOCK,
} from './src/chain-config.js';
import { buildIndexerFallback, parseBaseSepoliaRpcChain, parseRpcChain } from './src/rpc-config.js';

const baseSepoliaUrls = parseBaseSepoliaRpcChain();

/**
 * Hermetic snapshot mode (the hermetic snapshot indexer round-trip test,
 * operator/test/hermetic/indexer-roundtrip.test.ts, spec §3.1 / #341).
 *
 * When `JINN_INDEXER_SNAPSHOT_ROUTER` is set, the indexer targets a single,
 * locally-loaded Anvil snapshot chain instead of the live testnet: it indexes
 * ONLY the snapshot's JinnRouter (address + start block + chain id from env),
 * with its RPC from `PONDER_RPC_URL_<chainId>`. IdentityRegistry is still
 * DECLARED (so its handler registration in src/index.ts resolves) but pointed
 * at a dead address so it indexes nothing — this keeps the config a single
 * chain with a single live RPC, fully deterministic with no network.
 */
const SNAPSHOT_ROUTER = process.env['JINN_INDEXER_SNAPSHOT_ROUTER'];
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

function buildSnapshotConfig(): ReturnType<typeof createConfig> {
  const chainId = Number(process.env['JINN_INDEXER_SNAPSHOT_CHAIN_ID'] ?? '8453');
  const startBlock = Number(process.env['JINN_INDEXER_SNAPSHOT_START_BLOCK'] ?? '0');
  const rpc = parseRpcChain(process.env[`PONDER_RPC_URL_${chainId}`], 'http://127.0.0.1:8545');
  return createConfig({
    chains: {
      snapshot: { id: chainId, rpc: buildIndexerFallback(rpc), ethGetLogsBlockRange: 2000 },
    },
    contracts: {
      JinnRouter: {
        abi: JINN_ROUTER_ABI,
        chain: { snapshot: { address: SNAPSHOT_ROUTER as `0x${string}`, startBlock } },
      },
      IdentityRegistry: {
        abi: IDENTITY_REGISTRY_ABI,
        chain: { snapshot: { address: DEAD_ADDRESS, startBlock } },
      },
      ExternalStakingDistributor: {
        abi: EXTERNAL_STAKING_DISTRIBUTOR_ABI,
        chain: { snapshot: { address: DEAD_ADDRESS, startBlock } },
      },
      StolasStakingProxy: {
        abi: STOLAS_STAKING_PROXY_ABI,
        chain: { snapshot: { address: DEAD_ADDRESS, startBlock } },
      },
    },
  });
}

const testnetConfig = createConfig({
  chains: {
    baseSepolia: {
      id: 84532,
      rpc: buildIndexerFallback(baseSepoliaUrls),
      // Block-range cap for eth_getLogs: 2000 (issue #592, AC4). Bounds the
      // chunk size so the slowest fallback in the chain (sepolia.base.org at
      // its 2k-block cap) doesn't blow up under chunking. Set per chain so
      // the same code path works regardless of which slot in the fallback
      // chain actually serves the request.
      ethGetLogsBlockRange: 2000,
    },
  },
  contracts: {
    JinnRouter: {
      abi: JINN_ROUTER_ABI,
      chain: {
        baseSepolia: {
          // Tokenless-OLAS pivot (DR-2026-06-30): the final trimmed JinnRouterV3
          // the @canary client posts to. Deployed at block 43_523_445 (2026-06-30).
          // Supersedes the earlier trimmed router 0xdC9BCcEB… (iteration 1).
          address: BASE_SEPOLIA_JINN_ROUTER_ADDRESS,
          startBlock: BASE_SEPOLIA_JINN_ROUTER_START_BLOCK,
        },
      },
    },
    IdentityRegistry: {
      abi: IDENTITY_REGISTRY_ABI,
      chain: {
        baseSepolia: {
          address: BASE_SEPOLIA_IDENTITY_REGISTRY_ADDRESS,
          startBlock: BASE_SEPOLIA_IDENTITY_REGISTRY_START_BLOCK,
        },
      },
    },
    ExternalStakingDistributor: {
      abi: EXTERNAL_STAKING_DISTRIBUTOR_ABI,
      chain: {
        baseSepolia: {
          address: '0x20951FBDb4F9cB1f051ef416BCB11A9Cfe3CEf81',
          startBlock: 41_000_000,
        },
      },
    },
    StolasStakingProxy: {
      abi: STOLAS_STAKING_PROXY_ABI,
      chain: {
        baseSepolia: {
          address: '0x4DB0Fcb877CCd92B6AeEdAaD561DaccB0CCc7E39',
          startBlock: 41_000_000,
        },
      },
    },
  },
});

// The runtime value is the snapshot config when env-gated, otherwise the live
// testnet config. The static type is pinned to `typeof testnetConfig` so Ponder
// codegen resolves a single concrete contract/event set: a ternary union of two
// `createConfig` shapes (snapshot declares the chain key `snapshot`; testnet
// declares `baseSepolia`) collapses the virtual `ponder:registry`
// event names to `never`. Both branches declare the same JinnRouter /
// IdentityRegistry contracts, so the testnet type is a sound
// description of either runtime value for handler registration.
export default (SNAPSHOT_ROUTER ? buildSnapshotConfig() : testnetConfig) as typeof testnetConfig;
