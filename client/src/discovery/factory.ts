/**
 * createDiscoveryAPI factory — builds a DiscoveryAPI from the daemon config.
 *
 * Selects the primary implementation per config.discovery.mode, always builds
 * an OnchainDiscoveryAPI floor, and returns a withFallback composition when
 * fallbackToOnchain is true (the default).
 *
 * Spec: spec/2026-05-11-discovery-api-and-shared-indexer.md §9.1–9.2.
 */

import type { DiscoveryAPI } from './types.js';
import { withFallback } from './with-fallback.js';
import { createOnchainDiscoveryAPI } from './onchain.js';
import { createHttpDiscoveryAPI } from './http.js';

// ── Deps bag ──────────────────────────────────────────────────────────────────

/**
 * Runtime deps required by the implementations. The factory extracts what it
 * needs per mode — unknown fields are silently ignored.
 */
export interface DiscoveryFactoryDeps {
  /** RPC endpoint URL for the on-chain floor. */
  rpcUrl?: string;
  /** Chain ID (8453 = Base mainnet, 84532 = Base Sepolia). */
  chainId: number;
  /** JinnRouter proxy address — required by the on-chain floor for findClaimableTasks. */
  routerAddress?: `0x${string}`;
  /** IdentityRegistry address — required by the on-chain floor for SolverNet / envelope queries. */
  identityRegistryAddress?: `0x${string}`;
  /** Operator Safe multisig address — required by the on-chain floor for canClaimTask simulation. */
  safeAddress?: `0x${string}`;
  /** Operator mech contract address — required by the on-chain floor for canClaimTask simulation. */
  mechAddress?: `0x${string}`;
  /** Lower bound block for on-chain scans. */
  taskDiscoveryFromBlock?: bigint | number;
  /** Fetch implementation (for testability). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

// ── Discovery config type (mirrors config.ts) ─────────────────────────────────

export interface DiscoveryConfig {
  mode?: 'http' | 'embedded' | 'onchain';
  url?: string;
  fallbackToOnchain?: boolean;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build a DiscoveryAPI from the daemon's discovery config block.
 *
 * Modes:
 *   - 'onchain'   → returns the floor alone (no fallback needed)
 *   - 'http'      → HttpDiscoveryAPI backed by a Ponder GraphQL endpoint (280n.4)
 *   - 'embedded'  → not yet shipped (280n.5); throws at boot
 *
 * When `fallbackToOnchain` is true (default), the primary is wrapped in
 * withFallback(primary, floor). When false, the primary is returned directly.
 */
export function createDiscoveryAPI(
  config: DiscoveryConfig,
  deps: DiscoveryFactoryDeps,
): DiscoveryAPI {
  const mode = config.mode ?? 'onchain';
  const fallbackToOnchain = config.fallbackToOnchain ?? true;

  // Always build the on-chain floor — it's the always-live fallback.
  const floor = createOnchainDiscoveryAPI({
    rpcUrl: deps.rpcUrl,
    chainId: deps.chainId,
    routerAddress: deps.routerAddress,
    identityRegistryAddress: deps.identityRegistryAddress,
    safeAddress: deps.safeAddress,
    mechAddress: deps.mechAddress,
    taskDiscoveryFromBlock: deps.taskDiscoveryFromBlock,
  });

  if (mode === 'onchain') {
    // For the floor-only mode, return directly — withFallback(floor, floor)
    // would be pointless overhead.
    return floor;
  }

  if (mode === 'http') {
    if (!config.url) {
      // Misconfiguration, not a transient discovery failure — use Error so
      // withFallback does not engage the floor for a boot-time problem.
      // TODO: set a default URL once the maintainer's VPS is live (jinn-mono-280n.4 deployment).
      throw new Error(
        'discovery.mode="http" requires discovery.url to be set. ' +
        'Configure a Ponder indexer URL, e.g. https://indexer.example.com/graphql',
      );
    }

    const primary = createHttpDiscoveryAPI({
      url: config.url,
      fetchImpl: deps.fetchImpl,
    });

    if (!fallbackToOnchain) {
      return primary;
    }

    return withFallback(primary, floor);
  }

  // mode === 'embedded'
  // TODO(280n.5): instantiate EmbeddedPonderDiscoveryAPI once it ships.
  throw new Error(
    'discovery.mode="embedded" is not yet available. ' +
    'EmbeddedPonderDiscoveryAPI ships in jinn-mono-280n.5. ' +
    'Use mode="http" or mode="onchain" instead.',
  );
}
