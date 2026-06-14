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
import { fallback, http } from 'viem';
import { JINN_ROUTER_ABI } from './abis/JinnRouter.js';
import { IDENTITY_REGISTRY_ABI } from './abis/IdentityRegistry.js';
import { JINN_DISTRIBUTOR_ABI } from './abis/JinnDistributor.js';

/**
 * Hard cap on the number of providers in a single fallback chain (issue #592).
 * Four covers the indexer's intended shape: Envio HyperSync (slot 0) +
 * publicnode (slot 1) + sepolia.base.org (slot 2) + optional Tenderly
 * fallback slot. Beyond that the boot probe gets long and slot 5+ is almost
 * always copy-paste noise.
 */
const MAX_RPC_CHAIN_LENGTH = 4;

function parseRpcChain(value: string | undefined, fallbackUrl: string): string[] {
  const raw = (value ?? fallbackUrl).split(',').map((u) => u.trim()).filter(Boolean);
  if (raw.length === 0) return [fallbackUrl];
  if (raw.length > MAX_RPC_CHAIN_LENGTH) {
    // eslint-disable-next-line no-console
    console.error(
      `[ponder] capped fallback chain to ${MAX_RPC_CHAIN_LENGTH} providers ` +
        `(dropped ${raw.length - MAX_RPC_CHAIN_LENGTH} extra slots)`,
    );
    return raw.slice(0, MAX_RPC_CHAIN_LENGTH);
  }
  return raw;
}

function buildIndexerFallback(urls: readonly string[]) {
  // `rank: false` preserves operator-supplied slot order. Per the issue
  // addendum the intended ordering is paid > free-public > free-public-backup
  // (Envio HyperSync free-tier in slot 0 when set; publicnode + sepolia.base.org
  // as the no-account-needed backstops).
  return fallback(urls.map((u) => http(u)), { rank: false });
}

const baseSepoliaUrls = parseRpcChain(process.env['PONDER_RPC_URL_84532'], 'https://sepolia.base.org');
const sepoliaUrls = parseRpcChain(process.env['PONDER_RPC_URL_11155111'], 'https://ethereum-sepolia-rpc.publicnode.com');

/**
 * Hermetic snapshot mode (the hermetic snapshot indexer round-trip test,
 * client/test/hermetic/indexer-roundtrip.test.ts, spec §3.1 / #341).
 *
 * When `JINN_INDEXER_SNAPSHOT_ROUTER` is set, the indexer targets a single,
 * locally-loaded Anvil snapshot chain instead of the live testnet: it indexes
 * ONLY the snapshot's JinnRouter (address + start block + chain id from env),
 * with its RPC from `PONDER_RPC_URL_<chainId>`. IdentityRegistry/JinnDistributor
 * are still DECLARED (so their handler registrations in src/index.ts resolve)
 * but pointed at a dead address so they index nothing — this keeps the config a
 * single chain with a single live RPC, fully deterministic with no network.
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
      JinnDistributor: {
        abi: JINN_DISTRIBUTOR_ABI,
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
    sepolia: {
      id: 11155111,
      rpc: buildIndexerFallback(sepoliaUrls),
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

// The runtime value is the snapshot config when env-gated, otherwise the live
// testnet config. The static type is pinned to `typeof testnetConfig` so Ponder
// codegen resolves a single concrete contract/event set: a ternary union of two
// `createConfig` shapes (snapshot declares the chain key `snapshot`; testnet
// declares `baseSepolia`/`sepolia`) collapses the virtual `ponder:registry`
// event names to `never`. Both branches declare the same JinnRouter /
// IdentityRegistry / JinnDistributor contracts, so the testnet type is a sound
// description of either runtime value for handler registration.
export default (SNAPSHOT_ROUTER ? buildSnapshotConfig() : testnetConfig) as typeof testnetConfig;
