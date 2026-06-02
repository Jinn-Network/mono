#!/usr/bin/env node
// Zero-dependency Node 22 probe for the Jinn Ponder indexer.
//
// Provenance: root-cause of the 2026-05-20→23 substrate cascade — the indexer
// crashed at boot when its Tenderly gateway key hit a Free-plan quota
// (eth_chainId → -32004) and stayed down three days with no alert. This probe
// is the active liveness/freshness check that closes that gap. See
// docs/superpowers/specs/2026-06-01-548-indexer-monitoring-design.md.
//
// Two modes:
//   --mode=indexer : GET / 2xx → POST /graphql { _meta { status } } freshness →
//                    eth_blockNumber chain-head delta (fail if lag > 50 blocks).
//   --mode=rpc     : eth_chainId to the gateway, fail on the -32004 / quota signature.
//
// Pure logic (parseMetaEnvelope, computeLag, isStale, detectRpcQuotaError,
// parseBlockNumberHex) is exported and never throws / never calls process.exit,
// so the test suite imports it offline. The CLI entry is guarded so `import`
// is side-effect-free.

import { pathToFileURL } from 'node:url';

export const STALE_THRESHOLD_BLOCKS = 50;

const DEFAULT_INDEXER_BASE_URL = 'https://jinn-indexer-production.up.railway.app';
const DEFAULT_BASE_SEPOLIA_RPC_URL = 'https://sepolia.base.org';

// --- pure logic (no I/O, never throws) --------------------------------------

/**
 * Read the indexed Base Sepolia block from a Ponder `_meta { status }` envelope.
 * Field path verified live 2026-06-01 against jinn-indexer-production:
 *   data._meta.status.baseSepolia.block.number  (Ponder 0.16.x per-chain status map).
 * @returns {{ indexedBlock: number } | { error: string }}
 */
export function parseMetaEnvelope(json) {
  const status = json?.data?._meta?.status;
  if (status == null || typeof status !== 'object') {
    return { error: '_meta.status absent or null — indexer not reporting status' };
  }
  const baseSepolia = status.baseSepolia;
  if (baseSepolia == null) {
    return { error: '_meta.status.baseSepolia missing — indexer not indexing Base Sepolia' };
  }
  const number = baseSepolia?.block?.number;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    return { error: '_meta.status.baseSepolia.block.number absent — no indexed block' };
  }
  return { indexedBlock: number };
}

/** @returns {number} chainHead - indexedBlock */
export function computeLag(chainHead, indexedBlock) {
  return chainHead - indexedBlock;
}

/** @returns {boolean} true when lag exceeds the staleness threshold */
export function isStale(lag, threshold = STALE_THRESHOLD_BLOCKS) {
  return lag > threshold;
}

/** Detect the JSON-RPC quota signature (the exact 2026-05-20 failure mode). */
export function detectRpcQuotaError(json) {
  const err = json?.error;
  if (err == null) return false;
  if (err.code === -32004) return true;
  if (typeof err.message === 'string' && /quota|rate.?limit|exceeded/i.test(err.message)) {
    return true;
  }
  return false;
}

/** Parse an eth_blockNumber `"0x..."` result to a number. */
export function parseBlockNumberHex(hexString) {
  return Number.parseInt(hexString, 16);
}

// --- I/O shell (fetch injected; default global fetch) -----------------------

/**
 * POST a JSON body and parse the response. The `label` prefixes both the
 * non-2xx and network-error reason strings (load-bearing for the alert).
 * @returns {{ json: any } | { error: string }}
 */
async function postJson(url, body, fetchImpl, label) {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { error: `${label} returned ${res.status} (not 2xx)` };
    }
    return { json: await res.json() };
  } catch (e) {
    return { error: `${label} network error: ${e?.message ?? e}` };
  }
}

/** GET baseUrl/ — returns { ok, reason }. */
async function checkRoot(baseUrl, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/`, { method: 'GET', signal: AbortSignal.timeout(10000) });
  } catch (e) {
    return { ok: false, reason: `root GET ${baseUrl}/ network error: ${e?.message ?? e}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `root GET ${baseUrl}/ returned ${res.status} (not 2xx)` };
  }
  return { ok: true, reason: '' };
}

/** POST baseUrl/graphql { _meta { status } } → indexedBlock or error. */
async function fetchIndexedBlock(baseUrl, fetchImpl) {
  const res = await postJson(`${baseUrl}/graphql`, { query: 'query { _meta { status } }' }, fetchImpl, 'graphql POST');
  if (res.error) return { error: res.error };
  return parseMetaEnvelope(res.json);
}

/** POST rpcUrl eth_blockNumber → chain head number. */
async function fetchChainHead(rpcUrl, fetchImpl) {
  const res = await postJson(rpcUrl, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, fetchImpl, 'eth_blockNumber');
  if (res.error) return { error: res.error };
  const json = res.json;
  if (detectRpcQuotaError(json)) {
    return { error: 'eth_blockNumber hit RPC quota/rate-limit (gateway quota signature)' };
  }
  const head = parseBlockNumberHex(json?.result);
  if (!Number.isFinite(head)) {
    return { error: `eth_blockNumber returned unparseable result: ${JSON.stringify(json?.result)}` };
  }
  return { chainHead: head };
}

/** POST rpcUrl eth_chainId → { ok, reason } (quota-signature aware). */
async function checkRpcQuota(rpcUrl, fetchImpl) {
  const res = await postJson(rpcUrl, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, fetchImpl, 'eth_chainId');
  if (res.error) return { ok: false, reason: res.error };
  const json = res.json;
  if (detectRpcQuotaError(json)) {
    return {
      ok: false,
      reason: `gateway quota exhausted: ${JSON.stringify(json.error)} — rotate PONDER_RPC_URL_84532`,
    };
  }
  if (typeof json?.result !== 'string') {
    return { ok: false, reason: `eth_chainId returned no result: ${JSON.stringify(json)}` };
  }
  return { ok: true, reason: `gateway healthy (chainId=${json.result})` };
}

/**
 * Indexer freshness mode: root liveness → _meta freshness → chain-head delta.
 * Fail-fast in order. Returns { ok, reason }.
 */
export async function runIndexerMode({ baseUrl, rpcUrl, fetch: fetchImpl = globalThis.fetch }) {
  const root = await checkRoot(baseUrl, fetchImpl);
  if (!root.ok) return root;

  const indexed = await fetchIndexedBlock(baseUrl, fetchImpl);
  if (indexed.error) return { ok: false, reason: indexed.error };

  const head = await fetchChainHead(rpcUrl, fetchImpl);
  if (head.error) return { ok: false, reason: head.error };

  const lag = computeLag(head.chainHead, indexed.indexedBlock);
  if (isStale(lag)) {
    return {
      ok: false,
      reason: `indexer stale: head=${head.chainHead} indexed=${indexed.indexedBlock} lag=${lag} (>${STALE_THRESHOLD_BLOCKS})`,
    };
  }
  return {
    ok: true,
    reason: `indexer healthy: head=${head.chainHead} indexed=${indexed.indexedBlock} lag=${lag} (<=${STALE_THRESHOLD_BLOCKS})`,
  };
}

/** RPC key-health mode: eth_chainId, fail on the quota signature. */
export async function runRpcMode({ rpcUrl, fetch: fetchImpl = globalThis.fetch }) {
  return checkRpcQuota(rpcUrl, fetchImpl);
}

// --- CLI entry (guarded so `import` is side-effect-free) ---------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = (process.argv.find((a) => a.startsWith('--mode=')) ?? '--mode=indexer').slice('--mode='.length);
  const baseUrl = process.env.INDEXER_BASE_URL ?? DEFAULT_INDEXER_BASE_URL;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? DEFAULT_BASE_SEPOLIA_RPC_URL;

  let result;
  if (mode === 'rpc') {
    result = await runRpcMode({ rpcUrl });
  } else if (mode === 'indexer') {
    result = await runIndexerMode({ baseUrl, rpcUrl });
  } else {
    console.log(`unknown --mode=${mode} (expected indexer|rpc)`);
    process.exit(2);
  }

  console.log(result.ok ? `OK: ${result.reason}` : `FAIL: ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}
