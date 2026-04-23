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
  /**
   * True when the RPC reports an Anvil/Hardhat default chain id that does not
   * match the configured network, but the endpoint is on loopback — we only
   * allow this for local dev to avoid misreading a remote 313/1337 as healthy.
   */
  localDev?: true;
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

/**
 * Anvil / Hardhat default chain IDs. Fork workflows point `rpcUrl` at a local
 * node without reconfiguring the chain; `eth_chainId` then reports these
 * values instead of Base (8453 / 84532). We treat them as valid for preflight
 * only for loopback RPCs so a misconfigured public URL cannot silently pass.
 */
const LOCAL_EVM_DEV_CHAIN_IDS = new Set([31337, 1337]);

/**
 * True when the RPC host is a loopback address. Remote endpoints that return
 * Anvil/Hardhat chain ids are still treated as a mismatch.
 */
export function isLoopbackRpcUrl(rpcUrl: string): boolean {
  try {
    const h = new URL(rpcUrl).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Used by tests: whether checkRpcNetwork would take the Anvil/Hardhat override path.
 * Not used by production code beyond the equivalent inline check in {@link checkRpcNetwork}.
 */
export function evmLocalDevOverrideAcceptable(
  expectedChainId: number,
  actualChainId: number,
  rpcUrl: string,
): boolean {
  return (
    actualChainId !== expectedChainId &&
    LOCAL_EVM_DEV_CHAIN_IDS.has(actualChainId) &&
    isLoopbackRpcUrl(rpcUrl)
  );
}

/**
 * When {@link checkRpcNetwork} returns ok with `localDev: true`, log a single stderr line
 * (also surfaced in `jinn doctor` detail) so run/bootstrap are not silent about the mismatch.
 */
export function logRpcLocalDevToStderr(
  r: RpcNetworkPreflightOk,
  write: (m: string) => void = (m) => {
    process.stderr.write(m.endsWith('\n') ? m : `${m}\n`);
  },
): void {
  if (!r.localDev) return;
  write(
    `[jinn] Local dev: ${r.rpcHost} has chainId ${r.actualChainId} (config expects Base ${r.network} id ` +
      `${r.expectedChainId} from a live or forked-with-matching-id RPC). Continuing.\n`,
  );
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
    if (evmLocalDevOverrideAcceptable(expectedChainId, actualChainId, config.rpcUrl)) {
      return {
        ok: true,
        network: config.network,
        expectedChainId,
        actualChainId,
        rpcHost,
        localDev: true,
      };
    }
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
