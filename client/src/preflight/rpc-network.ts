import { createPublicClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { JinnConfig } from '../config.js';

export type ExpectedRpcNetwork = 'mainnet' | 'testnet';

export interface RpcNetworkPreflightOk {
  ok: true;
  network: ExpectedRpcNetwork;
  expectedChainId: number;
  actualChainId: number;
  rpcHost: string;
}

export interface RpcNetworkPreflightFail {
  ok: false;
  network: ExpectedRpcNetwork;
  expectedChainId: number;
  actualChainId?: number;
  rpcHost: string;
  reason: 'chain_mismatch' | 'unreachable';
  message: string;
}

export type RpcNetworkPreflightResult = RpcNetworkPreflightOk | RpcNetworkPreflightFail;

export function expectedChainIdForNetwork(network: ExpectedRpcNetwork): number {
  return network === 'testnet' ? 84532 : 8453;
}

export function rpcHostForDisplay(rpcUrl: string): string {
  try {
    const parsed = new URL(rpcUrl);
    return parsed.host || parsed.hostname || '(unknown host)';
  } catch {
    return '(invalid rpc url)';
  }
}

function expectedChainForNetwork(network: ExpectedRpcNetwork) {
  return network === 'testnet' ? baseSepolia : base;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}

export async function checkRpcNetwork(
  config: Pick<JinnConfig, 'network' | 'rpcUrl'>,
): Promise<RpcNetworkPreflightResult> {
  const expectedChainId = expectedChainIdForNetwork(config.network);
  const rpcHost = rpcHostForDisplay(config.rpcUrl);
  const client = createPublicClient({
    chain: expectedChainForNetwork(config.network),
    transport: http(config.rpcUrl),
  });

  let actualChainId: number;
  try {
    actualChainId = await client.getChainId();
  } catch (error) {
    return {
      ok: false,
      network: config.network,
      expectedChainId,
      rpcHost,
      reason: 'unreachable',
      message: `RPC preflight failed for ${config.network} via ${rpcHost}: ${errorMessage(error)}`,
    };
  }

  if (actualChainId !== expectedChainId) {
    return {
      ok: false,
      network: config.network,
      expectedChainId,
      actualChainId,
      rpcHost,
      reason: 'chain_mismatch',
      message:
        `RPC chain mismatch for ${config.network}: expected chain ${expectedChainId}, ` +
        `got ${actualChainId} from ${rpcHost}.`,
    };
  }

  return {
    ok: true,
    network: config.network,
    expectedChainId,
    actualChainId,
    rpcHost,
  };
}

export function rpcNetworkFailureHint(result: RpcNetworkPreflightFail): string {
  if (result.network === 'testnet') {
    return 'Set rpcUrl to a Base Sepolia endpoint such as https://sepolia.base.org, or set BASE_SEPOLIA_RPC_URL.';
  }
  return 'Set rpcUrl to a Base mainnet endpoint such as https://mainnet.base.org, or set BASE_RPC_URL.';
}
