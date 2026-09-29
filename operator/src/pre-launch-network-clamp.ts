/**
 * Pre-launch mainnet clamp. Mainnet is disabled until `JINN_ENABLE_MAINNET=1`,
 * so a config written for mainnet boots on testnet defaults instead.
 *
 * Rewrites BOTH `rpcUrl` (the head, consumed by the Safe SDK and the display
 * helpers, which take exactly one URL) and `rpcUrls` (the resolved #592
 * fallback chain, consumed by every viem client). Rewriting only the head left
 * the chain on mainnet, and the daemon's own clients already read the chain —
 * so the clamp was already partially bypassed before this.
 *
 * Extracted from `main.ts` so it is testable: that file executes on import.
 * Same shape as `resolveMainEntryEffectiveMode` in
 * `daemon/daemon-startup-info.ts`.
 */

export const PRE_LAUNCH_TESTNET_RPC_URL = 'https://base-sepolia-rpc.publicnode.com';

export interface PreLaunchClampTarget {
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  rpcUrls: readonly string[];
}

/** @returns true when the config was clamped, so the caller can warn once. */
export function applyPreLaunchMainnetClamp(
  config: PreLaunchClampTarget,
  env: NodeJS.ProcessEnv,
): boolean {
  if (config.network !== 'mainnet' || env['JINN_ENABLE_MAINNET'] === '1') return false;
  config.network = 'testnet';
  config.rpcUrl = PRE_LAUNCH_TESTNET_RPC_URL;
  config.rpcUrls = [PRE_LAUNCH_TESTNET_RPC_URL];
  return true;
}
