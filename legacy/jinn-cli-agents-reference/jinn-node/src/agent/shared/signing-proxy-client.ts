/**
 * Signing Proxy Client
 *
 * Agent-side client for the signing proxy running in the worker process.
 * All private key operations are delegated to the proxy over localhost HTTP.
 *
 * Environment variables:
 * - AGENT_SIGNING_PROXY_URL: Proxy base URL (e.g., http://127.0.0.1:12345)
 * - AGENT_SIGNING_PROXY_TOKEN: Bearer token for auth
 */

import type { EthHttpSigner, Hex } from '@slicekit/erc8128';

function getConfig(): { url: string; secret: string } {
  const url = process.env.AGENT_SIGNING_PROXY_URL;
  const secret = process.env.AGENT_SIGNING_PROXY_TOKEN;
  if (!url || !secret) {
    throw new Error('Signing proxy not configured (AGENT_SIGNING_PROXY_URL / AGENT_SIGNING_PROXY_TOKEN)');
  }
  return { url, secret };
}

const PROXY_TIMEOUT_MS = 10_000;
const PROXY_DISPATCH_TIMEOUT_MS = 60_000; // Safe dispatch involves ~6 sequential RPC calls + tx confirmation
const PROXY_RETRIES = 2;
const PROXY_RETRY_DELAY_MS = 500;

async function proxyRequest<T>(method: string, path: string, body?: unknown, timeoutMs = PROXY_TIMEOUT_MS): Promise<T> {
  const { url, secret } = getConfig();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${secret}`,
  };

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= PROXY_RETRIES; attempt++) {
    try {
      const init: RequestInit = {
        method,
        headers: { ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      };

      if (body !== undefined) {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      const response = await fetch(`${url}${path}`, init);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown proxy error', code: 'UNKNOWN' }));
        const err = new Error(`Signing proxy error (${response.status}): ${(error as any).error} [${(error as any).code}]`);
        // Don't retry client errors (4xx)
        if (response.status >= 400 && response.status < 500) throw err;
        lastError = err;
      } else {
        return response.json() as Promise<T>;
      }
    } catch (err: any) {
      lastError = err;
      // Don't retry client errors
      if (err?.message?.includes('(4')) throw err;
    }

    if (attempt < PROXY_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, PROXY_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError!;
}

/**
 * Get the agent's address derived from the service private key.
 */
export async function proxyGetAddress(): Promise<string> {
  const result = await proxyRequest<{ address: string }>('GET', '/address');
  return result.address;
}

/**
 * Sign a message with EIP-191 personal_sign via the signing proxy.
 */
export async function proxySign(message: string): Promise<{ signature: string; address: string }> {
  return proxyRequest<{ signature: string; address: string }>('POST', '/sign', { message });
}

function bytesToHex(input: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(input).toString('hex')}` as `0x${string}`;
}

/**
 * Sign raw bytes (as EIP-191 raw message) via signing proxy.
 */
export async function proxySignRaw(message: Uint8Array | `0x${string}`): Promise<{ signature: string; address: string }> {
  const hexMessage = typeof message === 'string' ? message : bytesToHex(message);
  return proxyRequest<{ signature: string; address: string }>('POST', '/sign-raw', { message: hexMessage });
}

/**
 * Sign EIP-712 typed data via the signing proxy.
 */
export async function proxySignTypedData(params: {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}): Promise<{ signature: string; address: string }> {
  return proxyRequest<{ signature: string; address: string }>('POST', '/sign-typed-data', params);
}

export interface DispatchParams {
  prompts: string[];
  priorityMech?: string;
  tools?: string[];
  ipfsJsonContents: unknown[];
  chainConfig?: string;
  postOnly?: boolean;
  responseTimeout?: number;
}

export interface DispatchResult {
  request_ids?: string[];
  [key: string]: unknown;
}

/**
 * Dispatch a marketplace request via the signing proxy.
 * The proxy dispatches through the Safe (execTransaction) to ensure
 * mapRequestCounts[multisig] increments for staking.
 *
 * Uses a longer timeout (60s) since Safe dispatch involves multiple
 * sequential RPC calls and transaction confirmation.
 */
export async function proxyDispatch(params: DispatchParams): Promise<DispatchResult> {
  return proxyRequest<DispatchResult>('POST', '/dispatch', params, PROXY_DISPATCH_TIMEOUT_MS);
}

/**
 * Build an ERC-8128 signer backed by the signing proxy.
 * Keeps private key usage in the worker-owned proxy process.
 */
export async function createProxyHttpSigner(chainId: number): Promise<EthHttpSigner> {
  const address = (await proxyGetAddress()).toLowerCase() as `0x${string}`;
  return {
    address,
    chainId,
    signMessage: async (message: Uint8Array) => {
      const { signature } = await proxySignRaw(message);
      return signature as Hex;
    },
  };
}
