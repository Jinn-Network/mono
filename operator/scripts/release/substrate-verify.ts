import { createPublicClient, parseAbi, type Address, type Chain } from 'viem';
import { buildFallbackTransport } from '../../src/rpc/transport.js';
import { base, baseSepolia } from 'viem/chains';
import { loadManifestSafe, serializeVerifyResult, type Manifest, type VerifyResult } from './types';
import { goldPath } from './substrate-paths';

const MIN_MASTER_ETH_WEI = 2_000_000_000_000_000n;   // 0.002 ETH
const IDENTITY_REGISTRY_ABI = parseAbi([
  'function getAgentWallet(uint256 agentId) view returns (address)',
]);
// OLAS token address — currently identical on both supported networks
// (base and base-sepolia). Split into a per-network map if that ever diverges.
const OLAS_TOKEN_ADDRESS: Address = '0x54330d28ca3357F294334BDC454a032e7f353416';
const OLAS_TOKEN_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
]);

/** Map a manifest network value to its viem chain definition. */
export function chainForNetwork(network: Manifest['network']): Chain {
  switch (network) {
    case 'base':
      return base;
    case 'base-sepolia':
      return baseSepolia;
  }
}

export interface VerifyOptions {
  substrateRoot?: string;
  skipOnChain?: boolean;
}

export async function verifySubstrate(opName: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const failures: string[] = [];
  const warnings: string[] = [];

  const opDir = goldPath(opName, opts.substrateRoot);

  // 1-3. Manifest exists, parses, and validates against the schema
  const loaded = await loadManifestSafe(opDir);
  if (!loaded.ok) {
    failures.push(loaded.error);
    return { opName, ok: false, failures, warnings, onChain: null };
  }
  const manifest = loaded.manifest;

  // 4. Name in manifest matches the op being verified
  if (manifest.name !== opName) {
    failures.push(`manifest.name=${manifest.name} does not match expected opName=${opName}`);
  }

  // 5. On-chain check (skip for now if requested)
  if (opts.skipOnChain) {
    return { opName, ok: failures.length === 0, failures, warnings, onChain: null };
  }

  // config.rpcUrl is string OR a multi-provider chain (#592) — build a fallback
  // transport either way (matches the daemon; http() alone rejects an array).
  const rpcUrls = Array.isArray(manifest.config.rpcUrl) ? manifest.config.rpcUrl : [manifest.config.rpcUrl];
  const client = createPublicClient({
    chain: chainForNetwork(manifest.network),
    transport: buildFallbackTransport(rpcUrls),
  });
  const onChain = {
    boundSafeAddress: null as string | null,
    ethBalanceWei: 0n,
    olasBalanceWei: null as bigint | null,
  };

  // Master ETH balance
  try {
    onChain.ethBalanceWei = await client.getBalance({ address: manifest.operator.masterAddress as Address });
    if (onChain.ethBalanceWei < MIN_MASTER_ETH_WEI) {
      failures.push(`master ETH balance ${onChain.ethBalanceWei} below minimum ${MIN_MASTER_ETH_WEI}`);
    }
  } catch (err) {
    failures.push(`failed to read master ETH balance: ${(err as Error).message}`);
  }

  // AgentId binding (skip if pre-fleet shape)
  if (manifest.shape === 'current' && manifest.operator.fleetAgentId !== null && manifest.operator.fleetSafeAddress !== null) {
    try {
      const bound = await client.readContract({
        address: manifest.operator.identityRegistry as Address,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'getAgentWallet',
        args: [BigInt(manifest.operator.fleetAgentId)],
      });
      onChain.boundSafeAddress = bound;
      if (bound.toLowerCase() !== manifest.operator.fleetSafeAddress.toLowerCase()) {
        failures.push(`identityRegistry.getAgentWallet(${manifest.operator.fleetAgentId})=${bound} does not match manifest.fleetSafeAddress=${manifest.operator.fleetSafeAddress}`);
      }
    } catch (err) {
      failures.push(`failed to read identityRegistry.getAgentWallet: ${(err as Error).message}`);
    }
  }

  // OLAS balance on Safe (informational; staked balance is locked so we just check)
  try {
    onChain.olasBalanceWei = await client.readContract({
      address: OLAS_TOKEN_ADDRESS,
      abi: OLAS_TOKEN_ABI,
      functionName: 'balanceOf',
      args: [manifest.operator.safeAddress as Address],
    });
  } catch {
    // Non-blocking; legacy ops or future schema may not have OLAS readable
  }

  return { opName, ok: failures.length === 0, failures, warnings, onChain };
}

async function cliMain(): Promise<void> {
  const opName = process.argv[2];
  if (!opName) {
    console.error('usage: substrate-verify <op-name> [--skip-on-chain]');
    process.exit(2);
  }
  const skipOnChain = process.argv.includes('--skip-on-chain');
  const result = await verifySubstrate(opName, { skipOnChain });
  console.log(JSON.stringify(serializeVerifyResult(result), null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
