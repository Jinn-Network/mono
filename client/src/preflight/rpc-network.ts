import { createPublicClient, http, HttpRequestError } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { JinnConfig } from '../config.js';
import { describeFallbackChain, maskRpcHost } from '../rpc/transport.js';

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

// ── probeFallbackChain — boot-time per-slot eth_blockNumber probe ────────────

/** Layer label for log lines and AC7 summary formatting. */
export type ProbeLayer = 'L1' | 'L2';

export type ProbeOk = {
  ok: true;
  host: string;
  latencyMs: number;
};

export type ProbeFail = {
  ok: false;
  host: string;
  /** HTTP status when applicable (4xx / 5xx). */
  code?: number;
  /** Failure shape when no HTTP status is available. */
  reason?: 'unreachable' | 'unknown';
  message: string;
};

export type ProbeResult = ProbeOk | ProbeFail;

export interface ProbeFallbackChainOptions {
  /** Logger for per-slot lines. Defaults to `console.error`. */
  log?: (message: string) => void;
}

function classifyProbeError(host: string, err: unknown): ProbeFail {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof HttpRequestError && typeof err.status === 'number') {
    return { ok: false, host, code: err.status, message };
  }
  // viem wraps HTTP errors inside other shapes; walk the cause chain.
  let cur: unknown = (err as { cause?: unknown } | undefined)?.cause;
  while (cur) {
    if (cur instanceof HttpRequestError && typeof cur.status === 'number') {
      return { ok: false, host, code: cur.status, message };
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return { ok: false, host, reason: 'unreachable', message };
}

/**
 * Probe each URL in a fallback chain with a per-slot `eth_blockNumber` call.
 * Records ok/latency or a structured failure (HTTP status / unreachable).
 *
 * The probe is **log-only** — it never throws on per-slot failures. Startup
 * gating remains the job of {@link checkRpcNetwork}, which fails loud on
 * chain-id mismatch.
 *
 * Per AC9 (issue #592): emits one log line per slot
 *   `[rpc] <layer> <host> ok latency=Nms`
 *   `[rpc] <layer> <host> warn 429`
 *   `[rpc] <layer> <host> warn 5xx`
 *   `[rpc] <layer> <host> warn unreachable: <message>`
 */
export async function probeFallbackChain(
  urls: readonly string[],
  network: ExpectedRpcNetwork,
  layer: ProbeLayer,
  options: ProbeFallbackChainOptions = {},
): Promise<ProbeResult[]> {
  const log = options.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  // Pick a chain only for typing; eth_blockNumber doesn't depend on chain
  // identity, and the L1/L2 distinction here is informational.
  const chain = layer === 'L2'
    ? (network === 'testnet' ? baseSepolia : base)
    : (network === 'testnet' ? baseSepolia : base);

  const results: ProbeResult[] = [];
  for (const url of urls) {
    const host = maskRpcHost(url);
    const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) });
    const t0 = performance.now();
    try {
      await client.getBlockNumber();
      const latencyMs = Math.max(0, Math.round(performance.now() - t0));
      log(`[rpc] ${layer} ${host} ok latency=${latencyMs}ms`);
      results.push({ ok: true, host, latencyMs });
    } catch (err) {
      const failure = classifyProbeError(host, err);
      if (failure.code === 429) {
        log(`[rpc] ${layer} ${host} warn 429`);
      } else if (failure.code !== undefined && failure.code >= 500) {
        log(`[rpc] ${layer} ${host} warn ${failure.code}`);
      } else if (failure.code !== undefined) {
        log(`[rpc] ${layer} ${host} warn ${failure.code}`);
      } else {
        log(`[rpc] ${layer} ${host} warn unreachable: ${failure.message.split('\n')[0]}`);
      }
      results.push(failure);
    }
  }
  return results;
}

/**
 * Boot-log summary line for a fallback chain, formatted per AC7:
 *   `[rpc] L2 transport: fallback chain (N providers) — primary=<host>`
 */
export function summarizeFallbackChain(layer: ProbeLayer, urls: readonly string[]): string {
  return `[rpc] ${layer} transport: ${describeFallbackChain(urls)}`;
}
