/**
 * Credential Client
 *
 * Agent-side client for the Credential Bridge. Delegates all signing to
 * the signing proxy running in the worker process.
 *
 * Environment variables:
 * - X402_GATEWAY_URL: URL of the x402-gateway (e.g., https://gateway.example.com)
 * - AGENT_SIGNING_PROXY_URL: Signing proxy base URL
 * - AGENT_SIGNING_PROXY_TOKEN: Signing proxy bearer token
 */

import { proxySignTypedData, proxyGetAddress, createProxyHttpSigner } from './signing-proxy-client.js';
import { resolveChainId, signRequestWithErc8128, type Erc8128Signer } from '../../http/erc8128.js';

export interface CredentialBundle {
  access_token: string;
  expires_in: number;
  provider: string;
  config: Record<string, string>;
}

interface CredentialError {
  error: string;
  code: string;
}

interface BridgeCredentialRequest {
  requestId?: string;
}

// In-memory cache: provider → { bundle, expiresAt }
const bundleCache = new Map<string, { bundle: CredentialBundle; expiresAt: number }>();

// USDC contract addresses (6 decimals) — must match x402-verify.ts
const USDC_ADDRESSES: Record<string, string> = {
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

let bridgeSignerPromise: Promise<Erc8128Signer> | null = null;

async function getBridgeSigner(): Promise<Erc8128Signer> {
  if (!bridgeSignerPromise) {
    const chainId = resolveChainId(process.env.CHAIN_ID || process.env.CHAIN_CONFIG || 'base');
    bridgeSignerPromise = createProxyHttpSigner(chainId);
  }
  return bridgeSignerPromise;
}

async function signedBridgePost(
  url: string,
  body: BridgeCredentialRequest,
  headers: Record<string, string> = {},
): Promise<Response> {
  const signer = await getBridgeSigner();
  // Deterministic idempotency key from provider + requestId.
  // Gateway validates: /^[a-zA-Z0-9_-]{1,64}$/ — no colons or dots allowed.
  const provider = url.split('/credentials/').pop() || 'unknown';
  const requestSlug = (body.requestId || 'no-request').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const idempotencyKey = `cred-${provider}-${requestSlug}`;

  const request = await signRequestWithErc8128({
    signer,
    input: url,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    signOptions: {
      label: 'eth',
      binding: 'request-bound',
      replay: 'non-replayable',
      ttlSeconds: 60,
    },
  });
  return fetch(request);
}

/**
 * Build an x402 payment header by signing a USDC transferWithAuthorization
 * via the signing proxy (EIP-712 typed data).
 */
async function createPaymentHeader(opts: {
  amount: string;
  payTo: string;
  network: string;
}): Promise<string> {
  const usdcAddress = USDC_ADDRESSES[opts.network] || USDC_ADDRESSES['base'];
  const nonce = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const validBefore = String(Math.floor(Date.now() / 1000) + 3600);
  const from = await proxyGetAddress();

  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: opts.network === 'base-sepolia' ? 84532 : 8453,
    verifyingContract: usdcAddress,
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const message = {
    from,
    to: opts.payTo,
    value: opts.amount,
    validAfter: '0',
    validBefore,
    nonce,
  };

  const { signature } = await proxySignTypedData({
    domain,
    types,
    primaryType: 'TransferWithAuthorization',
    message,
  });

  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: opts.network,
    payload: {
      signature,
      authorization: {
        from,
        to: opts.payTo,
        value: opts.amount,
        validAfter: '0',
        validBefore,
        nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function parseCredentialBundle(data: unknown, provider: string): CredentialBundle {
  if (!data || typeof data !== 'object') {
    throw new Error(`Credential bridge response for ${provider} must be a JSON object`);
  }
  const payload = data as Partial<CredentialBundle>;
  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error(`Credential bridge response for ${provider} is missing access_token`);
  }
  if (typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new Error(`Credential bridge response for ${provider} has invalid expires_in`);
  }
  if (payload.provider !== provider) {
    throw new Error(`Credential bridge response provider mismatch: expected ${provider}, got ${payload.provider ?? 'unknown'}`);
  }
  if (!payload.config || typeof payload.config !== 'object' || Array.isArray(payload.config)) {
    throw new Error(`Credential bridge response for ${provider} is missing config`);
  }
  const configEntries = Object.entries(payload.config);
  for (const [key, value] of configEntries) {
    if (typeof value !== 'string') {
      throw new Error(`Credential bridge config for ${provider} has non-string value at key ${key}`);
    }
  }

  return {
    access_token: payload.access_token,
    expires_in: payload.expires_in,
    provider: payload.provider,
    config: Object.fromEntries(configEntries),
  };
}

/**
 * Get a fresh credential bundle (token + provider config) from the bridge.
 */
export async function getCredentialBundle(provider: string): Promise<CredentialBundle> {
  // Check cache (with 10-minute buffer to avoid mid-request expiry)
  const cached = bundleCache.get(provider);
  if (cached && cached.expiresAt > Date.now() + 10 * 60 * 1000) {
    return cached.bundle;
  }

  const bridgeUrl = process.env.X402_GATEWAY_URL;
  if (!bridgeUrl) {
    throw new Error('X402_GATEWAY_URL environment variable is required');
  }

  // Include requestId for job-bound credentials when available
  const requestId = process.env.JINN_CTX_REQUEST_ID || process.env.JINN_CTX_JOB_ID;
  const body: BridgeCredentialRequest = requestId ? { requestId } : {};

  const credentialUrl = `${bridgeUrl.replace(/\/$/, '')}/credentials/${provider}`;
  let response = await signedBridgePost(credentialUrl, body);

  // Handle x402 payment required
  if (response.status === 402) {
    const errorData = await response.json().catch(() => ({})) as Record<string, string>;
    const amount = errorData.error?.match(/(\d+)/)?.[1];
    const network = process.env.X402_NETWORK || 'base';
    const payTo = process.env.GATEWAY_PAYMENT_ADDRESS;

    if (amount && payTo) {
      const paymentHeader = await createPaymentHeader({ amount, payTo, network });
      response = await signedBridgePost(credentialUrl, body, {
        'X-Payment': paymentHeader,
      });
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error', code: 'UNKNOWN' })) as CredentialError;
    throw new Error(`Credential bridge error (${response.status}): ${error.error} [${error.code}]`);
  }

  const bundle = parseCredentialBundle(await response.json(), provider);

  // Cache the bundle (evict oldest if at capacity)
  if (bundleCache.size >= 100) {
    const oldestKey = bundleCache.keys().next().value;
    if (oldestKey !== undefined) bundleCache.delete(oldestKey);
  }
  bundleCache.set(provider, {
    bundle,
    expiresAt: Date.now() + bundle.expires_in * 1000,
  });

  return bundle;
}

/**
 * Get credential token for a provider.
 */
export async function getCredential(provider: string): Promise<string> {
  const bundle = await getCredentialBundle(provider);
  return bundle.access_token;
}

/**
 * Get static configuration returned by the bridge for a provider.
 */
export async function getCredentialConfig(provider: string): Promise<Record<string, string>> {
  const bundle = await getCredentialBundle(provider);
  return bundle.config;
}

/**
 * Clear cached bundle for a provider (useful after token rejection).
 */
export function clearCredentialCache(provider?: string): void {
  if (provider) {
    bundleCache.delete(provider);
  } else {
    bundleCache.clear();
  }
}
