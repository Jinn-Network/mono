// node --test suite for indexer-probe.mjs — zero-dependency, offline.
//
// All network is injected via a fake `fetch`, so the suite never touches the
// real indexer. Run: `cd .github/scripts && node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMetaEnvelope,
  computeLag,
  isStale,
  detectRpcQuotaError,
  parseBlockNumberHex,
  runIndexerMode,
  runRpcMode,
  STALE_THRESHOLD_BLOCKS,
} from './indexer-probe.mjs';

// --- fake fetch helpers -----------------------------------------------------

/** Build a fake Response-like object. */
function fakeResponse({ ok = true, status = 200, body = {} } = {}) {
  return { ok, status, json: async () => body };
}

/**
 * Build a fake `fetch` that routes by a matcher list. Each matcher is
 * { match: (url, init) => bool, response: fakeResponse(...) | (url,init)=>resp }.
 * Records calls on `.calls` for fail-fast assertions.
 */
function makeFetch(routes) {
  const fn = async (url, init) => {
    fn.calls.push({ url, init });
    for (const r of routes) {
      if (r.match(url, init)) {
        return typeof r.response === 'function' ? r.response(url, init) : r.response;
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
  fn.calls = [];
  return fn;
}

const isGraphql = (url) => String(url).includes('/graphql');
const isRoot = (url, baseUrl) => String(url) === `${baseUrl}/` || String(url) === baseUrl;
const bodyMethod = (init) => {
  try {
    return JSON.parse(init?.body ?? '{}').method;
  } catch {
    return undefined;
  }
};

const BASE_URL = 'https://indexer.example';
const RPC_URL = 'https://rpc.example';

const healthyMeta = {
  data: { _meta: { status: { baseSepolia: { id: 84532, block: { number: 42281754, timestamp: 1780331796 } } } } },
};

// --- parseMetaEnvelope ------------------------------------------------------

test('parseMetaEnvelope: healthy envelope returns indexedBlock', () => {
  const out = parseMetaEnvelope(healthyMeta);
  assert.deepEqual(out, { indexedBlock: 42281754 });
});

test('parseMetaEnvelope: missing baseSepolia returns error, does not throw', () => {
  const out = parseMetaEnvelope({ data: { _meta: { status: {} } } });
  assert.ok(out.error, 'expected an error object');
  assert.match(out.error, /baseSepolia/i);
});

test('parseMetaEnvelope: null _meta returns error', () => {
  const out = parseMetaEnvelope({ data: { _meta: null } });
  assert.ok(out.error);
});

test('parseMetaEnvelope: absent data returns error', () => {
  const out = parseMetaEnvelope({});
  assert.ok(out.error);
});

test('parseMetaEnvelope: absent status returns error', () => {
  const out = parseMetaEnvelope({ data: { _meta: {} } });
  assert.ok(out.error);
});

// --- computeLag / isStale ---------------------------------------------------

test('computeLag subtracts indexed from head', () => {
  assert.equal(computeLag(41893600, 41892900), 700);
});

test('isStale: lag exactly at threshold (50) is not stale', () => {
  assert.equal(isStale(50), false);
});

test('isStale: lag above threshold (51) is stale', () => {
  assert.equal(isStale(51), true);
});

test('STALE_THRESHOLD_BLOCKS is 50', () => {
  assert.equal(STALE_THRESHOLD_BLOCKS, 50);
});

// --- parseBlockNumberHex ----------------------------------------------------

test('parseBlockNumberHex parses 0x hex to number', () => {
  assert.equal(parseBlockNumberHex('0x27f3ee0'), 41893600);
});

// --- detectRpcQuotaError ----------------------------------------------------

test('detectRpcQuotaError: -32004 code detected', () => {
  assert.equal(detectRpcQuotaError({ error: { code: -32004, message: 'over quota' } }), true);
});

test('detectRpcQuotaError: message matching quota/rate-limit/exceeded detected', () => {
  assert.equal(detectRpcQuotaError({ error: { code: -32000, message: 'rate limit reached' } }), true);
  assert.equal(detectRpcQuotaError({ error: { message: 'monthly quota exceeded' } }), true);
});

test('detectRpcQuotaError: healthy body not detected', () => {
  assert.equal(detectRpcQuotaError({ result: '0x14a34' }), false);
});

// --- runIndexerMode ---------------------------------------------------------

test('runIndexerMode: healthy root + healthy _meta + head within 50 → ok', async () => {
  const fetchImpl = makeFetch([
    { match: (u) => isRoot(u, BASE_URL), response: fakeResponse({ ok: true, status: 200, body: {} }) },
    { match: (u) => isGraphql(u), response: fakeResponse({ ok: true, status: 200, body: healthyMeta }) },
    {
      match: (u, init) => bodyMethod(init) === 'eth_blockNumber',
      // head = indexed + 10 → lag 10, not stale
      response: fakeResponse({ body: { result: '0x' + (42281754 + 10).toString(16) } }),
    },
  ]);
  const out = await runIndexerMode({ baseUrl: BASE_URL, rpcUrl: RPC_URL, fetch: fetchImpl });
  assert.equal(out.ok, true, out.reason);
});

test('runIndexerMode: stale (lag 700) → fail with head/indexed/lag in reason', async () => {
  const head = 42281754 + 700;
  const fetchImpl = makeFetch([
    { match: (u) => isRoot(u, BASE_URL), response: fakeResponse({ ok: true, status: 200, body: {} }) },
    { match: (u) => isGraphql(u), response: fakeResponse({ ok: true, status: 200, body: healthyMeta }) },
    {
      match: (u, init) => bodyMethod(init) === 'eth_blockNumber',
      response: fakeResponse({ body: { result: '0x' + head.toString(16) } }),
    },
  ]);
  const out = await runIndexerMode({ baseUrl: BASE_URL, rpcUrl: RPC_URL, fetch: fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.reason, /head=/);
  assert.match(out.reason, /indexed=/);
  assert.match(out.reason, /lag=/);
});

test('runIndexerMode: non-2xx root → fail-fast, graphql never called', async () => {
  const fetchImpl = makeFetch([
    { match: (u) => isRoot(u, BASE_URL), response: fakeResponse({ ok: false, status: 503, body: {} }) },
    { match: (u) => isGraphql(u), response: fakeResponse({ ok: true, status: 200, body: healthyMeta }) },
  ]);
  const out = await runIndexerMode({ baseUrl: BASE_URL, rpcUrl: RPC_URL, fetch: fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.reason, /503|root/i);
  // fail-fast: no graphql call was made
  assert.ok(!fetchImpl.calls.some((c) => isGraphql(c.url)), 'graphql should not be called after root fails');
});

test('runIndexerMode: missing baseSepolia in _meta → fail', async () => {
  const fetchImpl = makeFetch([
    { match: (u) => isRoot(u, BASE_URL), response: fakeResponse({ ok: true, status: 200, body: {} }) },
    {
      match: (u) => isGraphql(u),
      response: fakeResponse({ ok: true, status: 200, body: { data: { _meta: { status: {} } } } }),
    },
  ]);
  const out = await runIndexerMode({ baseUrl: BASE_URL, rpcUrl: RPC_URL, fetch: fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.reason, /baseSepolia/i);
});

// --- runRpcMode -------------------------------------------------------------

test('runRpcMode: -32004 quota error → fail', async () => {
  const fetchImpl = makeFetch([
    {
      match: (u, init) => bodyMethod(init) === 'eth_chainId',
      response: fakeResponse({ body: { error: { code: -32004, message: 'over quota' } } }),
    },
  ]);
  const out = await runRpcMode({ rpcUrl: RPC_URL, fetch: fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.reason, /quota|-32004/i);
});

test('runRpcMode: healthy eth_chainId → ok', async () => {
  const fetchImpl = makeFetch([
    {
      match: (u, init) => bodyMethod(init) === 'eth_chainId',
      response: fakeResponse({ body: { result: '0x14a34' } }),
    },
  ]);
  const out = await runRpcMode({ rpcUrl: RPC_URL, fetch: fetchImpl });
  assert.equal(out.ok, true, out.reason);
});

test('runRpcMode: non-2xx → fail', async () => {
  const fetchImpl = makeFetch([
    {
      match: (u, init) => bodyMethod(init) === 'eth_chainId',
      response: fakeResponse({ ok: false, status: 500, body: {} }),
    },
  ]);
  const out = await runRpcMode({ rpcUrl: RPC_URL, fetch: fetchImpl });
  assert.equal(out.ok, false);
});
