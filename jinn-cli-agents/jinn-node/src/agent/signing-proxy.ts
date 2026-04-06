/**
 * Signing Proxy
 *
 * Local HTTP server that mediates all private key operations for the agent subprocess.
 * Runs in the worker process on 127.0.0.1 with a random port and bearer token.
 * The agent never has direct access to the private key.
 *
 * Endpoints:
 * - GET  /address          — Derive and return the agent's address
 * - POST /sign             — EIP-191 personal_sign
 * - POST /sign-raw         — EIP-191 sign raw bytes (0x-prefixed hex)
 * - POST /sign-typed-data  — EIP-712 typed data sign
 * - POST /dispatch         — Marketplace dispatch via Safe execTransaction
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { getServicePrivateKey, getMechAddress, getServiceSafeAddress } from '../env/operate-profile.js';
import { get_mech_config } from '@jinn-network/mech-client-ts/dist/config.js';
import { getMechChainConfig } from '../env/operate-profile.js';
import { dispatchViaSafe } from '../worker/safe-dispatch.js';
import { config, secrets } from '../config/index.js';

const READ_BODY_TIMEOUT_MS = 5_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(Object.assign(new Error('Request body read timeout'), { statusCode: 408 }));
    }, READ_BODY_TIMEOUT_MS);

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON in request body'), { statusCode: 400 });
  }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function loadPrivateKey(): string {
  const key = getServicePrivateKey();
  if (!key) {
    throw new Error('Service private key not available');
  }
  return key;
}

let cachedAddress: string | null = null;

async function getAddress(): Promise<string> {
  if (cachedAddress) return cachedAddress;
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(loadPrivateKey() as `0x${string}`);
  cachedAddress = account.address.toLowerCase();
  return cachedAddress;
}

async function handleAddress(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const address = await getAddress();
  json(res, 200, { address });
}

async function handleSign(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body.message || typeof body.message !== 'string') {
    json(res, 400, { error: 'Missing or invalid "message" field', code: 'BAD_REQUEST' });
    return;
  }

  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(loadPrivateKey() as `0x${string}`);
  const signature = await account.signMessage({ message: body.message });

  json(res, 200, {
    signature,
    address: account.address.toLowerCase(),
  });
}

async function handleSignRaw(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body.message || typeof body.message !== 'string' || !/^0x[0-9a-fA-F]*$/.test(body.message) || body.message.length % 2 !== 0) {
    json(res, 400, { error: 'Missing or invalid "message" field (expected 0x-prefixed even-length hex)', code: 'BAD_REQUEST' });
    return;
  }

  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(loadPrivateKey() as `0x${string}`);
  const signature = await account.signMessage({ message: { raw: body.message as `0x${string}` } });

  json(res, 200, {
    signature,
    address: account.address.toLowerCase(),
  });
}

async function handleSignTypedData(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody(req);
  const { domain, types, primaryType, message } = body;

  if (!domain || !types || !primaryType || !message) {
    json(res, 400, { error: 'Missing required EIP-712 fields: domain, types, primaryType, message', code: 'BAD_REQUEST' });
    return;
  }

  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(loadPrivateKey() as `0x${string}`);
  const signature = await account.signTypedData({ domain, types, primaryType, message });

  json(res, 200, {
    signature,
    address: account.address.toLowerCase(),
  });
}

async function handleDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody(req);
  const { prompts, tools, ipfsJsonContents, postOnly, responseTimeout } = body;

  if (!prompts || !ipfsJsonContents) {
    json(res, 400, { error: 'Missing required dispatch fields: prompts, ipfsJsonContents', code: 'BAD_REQUEST' });
    return;
  }

  const privateKey = loadPrivateKey();
  const mechAddress = body.priorityMech || getMechAddress();
  const safeAddress = getServiceSafeAddress();
  const rpcUrl = secrets.rpcUrl;

  if (!mechAddress) {
    json(res, 500, { error: 'Service mech address not configured', code: 'CONFIG_ERROR' });
    return;
  }

  if (!safeAddress) {
    json(res, 500, { error: 'Service Safe address not configured. Check JINN_SERVICE_SAFE_ADDRESS or service config.', code: 'CONFIG_ERROR' });
    return;
  }

  // Resolve marketplace address from chain config
  const chainConfig = getMechChainConfig();
  const mechConfig = get_mech_config(chainConfig);
  const mechMarketplaceAddress = mechConfig.mech_marketplace_contract;

  if (!mechMarketplaceAddress || mechMarketplaceAddress === '0x0000000000000000000000000000000000000000') {
    json(res, 500, { error: 'Mech Marketplace contract address not configured for this chain', code: 'CONFIG_ERROR' });
    return;
  }

  if (!rpcUrl) {
    json(res, 500, { error: 'RPC URL not configured. Set RPC_URL in .env.', code: 'CONFIG_ERROR' });
    return;
  }

  const result = await dispatchViaSafe({
    serviceSafeAddress: safeAddress,
    agentEoaPrivateKey: privateKey,
    priorityMech: mechAddress,
    mechMarketplaceAddress,
    rpcUrl,
    ipfsJsonContents,
    responseTimeout: responseTimeout || 120,
  });

  json(res, 200, result);
}

/**
 * Reset the cached address so the next proxy derives it fresh from the
 * current active service key. Called automatically by startSigningProxy()
 * and exported for explicit invalidation on service rotation.
 */
export function resetCachedAddress(): void {
  cachedAddress = null;
}

export async function startSigningProxy(): Promise<{
  url: string;
  secret: string;
  close: () => Promise<void>;
}> {
  // Clear stale address from previous service — the new proxy must derive
  // the address from the current active key to stay in sync with signing.
  cachedAddress = null;

  const secret = randomBytes(32).toString('hex');

  const server = createServer(async (req, res) => {
    // Auth check
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${secret}`) {
      json(res, 401, { error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const url = req.url || '';
    const method = req.method || '';

    try {
      if (method === 'GET' && url === '/address') {
        await handleAddress(req, res);
      } else if (method === 'POST' && url === '/sign') {
        await handleSign(req, res);
      } else if (method === 'POST' && url === '/sign-raw') {
        await handleSignRaw(req, res);
      } else if (method === 'POST' && url === '/sign-typed-data') {
        await handleSignTypedData(req, res);
      } else if (method === 'POST' && url === '/dispatch') {
        await handleDispatch(req, res);
      } else {
        json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
      }
    } catch (err: any) {
      // Never leak the private key in error messages
      const status = err?.statusCode || 500;
      const message = err?.message || 'Internal server error';
      const safeMessage = message.replace(/0x[a-fA-F0-9]{64}/g, '[REDACTED]');
      json(res, status, { error: safeMessage, code: status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR' });
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        secret,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}
