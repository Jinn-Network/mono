import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkRpcNetwork,
  evmLocalDevOverrideAcceptable,
  isLoopbackRpcUrl,
  rpcHostForDisplay,
  probeFallbackChain,
  summarizeFallbackChain,
  type ProbeResult,
} from '../../src/preflight/rpc-network.js';
import {
  DEFAULT_TESTNET_RPC_URLS,
  DEFAULT_MAINNET_RPC_URLS,
} from '../../src/config.js';

const servers: Server[] = [];

function startRpc(chainIdHex: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id?: number };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result: chainIdHex }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('missing address');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe('rpc network preflight', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('accepts expected Base Sepolia chain id', async () => {
    const rpc = await startRpc('0x14a34');
    const result = await checkRpcNetwork({ network: 'testnet', rpcUrl: rpc.url });
    expect(result).toMatchObject({
      ok: true,
      network: 'testnet',
      expectedChainId: 84532,
      actualChainId: 84532,
    });
  });

  it('rejects a mainnet chain id for testnet config', async () => {
    const rpc = await startRpc('0x2105');
    const result = await checkRpcNetwork({ network: 'testnet', rpcUrl: rpc.url });
    expect(result).toMatchObject({
      ok: false,
      network: 'testnet',
      expectedChainId: 84532,
      actualChainId: 8453,
      reason: 'chain_mismatch',
    });
    expect(result.message).toContain('expected chain 84532');
  });

  it('reports unreachable RPCs', async () => {
    const result = await checkRpcNetwork({ network: 'testnet', rpcUrl: 'http://127.0.0.1:9' });
    expect(result).toMatchObject({
      ok: false,
      network: 'testnet',
      expectedChainId: 84532,
      reason: 'unreachable',
    });
  });

  it('accepts Anvil / Hardhat local chain id (31337) for testnet config (loopback only)', async () => {
    const rpc = await startRpc('0x7a69'); // 31337
    const result = await checkRpcNetwork({ network: 'testnet', rpcUrl: rpc.url });
    expect(result).toMatchObject({
      ok: true,
      network: 'testnet',
      expectedChainId: 84532,
      actualChainId: 31337,
      localDev: true,
    });
  });

  it('accepts Anvil / Hardhat local chain id (31337) for mainnet config (loopback only)', async () => {
    const rpc = await startRpc('0x7a69');
    const result = await checkRpcNetwork({ network: 'mainnet', rpcUrl: rpc.url });
    expect(result).toMatchObject({
      ok: true,
      network: 'mainnet',
      expectedChainId: 8453,
      actualChainId: 31337,
      localDev: true,
    });
  });

  it('accepts Hardhat default chain id 1337 as local dev (loopback only)', async () => {
    const rpc = await startRpc('0x539'); // 1337
    const result = await checkRpcNetwork({ network: 'testnet', rpcUrl: rpc.url });
    expect(result).toMatchObject({
      ok: true,
      network: 'testnet',
      actualChainId: 1337,
      localDev: true,
    });
  });

  it('reports only the host for display', () => {
    expect(rpcHostForDisplay('https://user:secret@example.com/path?key=abc')).toBe('example.com');
  });

  it('isLoopbackRpcUrl accepts common local bind addresses', () => {
    expect(isLoopbackRpcUrl('http://127.0.0.1:8545/')).toBe(true);
    expect(isLoopbackRpcUrl('http://localhost:8545/')).toBe(true);
    expect(isLoopbackRpcUrl('http://[::1]:8545/')).toBe(true);
    expect(isLoopbackRpcUrl('https://sepolia.base.org')).toBe(false);
  });

  it('evmLocalDevOverrideAcceptable requires loopback, not just a 31337 id', () => {
    expect(evmLocalDevOverrideAcceptable(84532, 31337, 'http://127.0.0.1:8545')).toBe(true);
    expect(evmLocalDevOverrideAcceptable(8453, 31337, 'http://127.0.0.1:8545')).toBe(true);
    expect(evmLocalDevOverrideAcceptable(84532, 31337, 'https://sepolia.base.org')).toBe(false);
    expect(evmLocalDevOverrideAcceptable(84532, 31337, 'https://8.8.8.8:8545')).toBe(false);
    expect(evmLocalDevOverrideAcceptable(84532, 84532, 'http://127.0.0.1:8545')).toBe(false);
  });
});

// ── probeFallbackChain (AC7, AC9 — boot-time per-slot eth_blockNumber probe) ──

function startBlockNumberServer(opts: {
  status?: number;
  blockNumber?: string;
  chainId?: string;
  hangMs?: number;
}): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id?: number; method?: string };
        const reply = () => {
          if (opts.status && opts.status !== 200) {
            res.statusCode = opts.status;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'rate limited' }));
            return;
          }
          res.setHeader('content-type', 'application/json');
          const result = parsed.method === 'eth_chainId'
            ? (opts.chainId ?? '0x14a34')
            : (opts.blockNumber ?? '0x100');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
        };
        if (opts.hangMs) setTimeout(reply, opts.hangMs);
        else reply();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('missing address');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe('probeFallbackChain', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('records an ok result per URL with latency', async () => {
    const a = await startBlockNumberServer({ blockNumber: '0x101' });
    const b = await startBlockNumberServer({ blockNumber: '0x102' });
    const results = await probeFallbackChain([a.url, b.url], 'testnet', 'L2');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: true });
    expect(typeof results[0]!.latencyMs).toBe('number');
    expect(results[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('classifies a 429 response as ok:false with code 429 (does NOT throw)', async () => {
    const a = await startBlockNumberServer({ status: 429 });
    const b = await startBlockNumberServer({ blockNumber: '0x100' });
    // The probe must not gate startup — it logs warnings and continues.
    const results = await probeFallbackChain([a.url, b.url], 'testnet', 'L2');
    expect(results[0]).toMatchObject({ ok: false, code: 429 });
    expect(results[1]).toMatchObject({ ok: true });
  });

  it('marks a reachable fallback with the wrong chain id as unhealthy', async () => {
    const primary = await startBlockNumberServer({
      chainId: '0x14a34',
      blockNumber: '0x101',
    });
    const wrongChainFallback = await startBlockNumberServer({
      chainId: '0x2105',
      blockNumber: '0x102',
    });

    const results = await probeFallbackChain(
      [primary.url, wrongChainFallback.url],
      'testnet',
      'L2',
    );

    expect(results[0]).toMatchObject({ ok: true, expectedChainId: 84532, actualChainId: 84532 });
    expect(results[1]).toMatchObject({
      ok: false,
      reason: 'chain_mismatch',
      expectedChainId: 84532,
      actualChainId: 8453,
    });
  });

  it('uses the L1 expected chain id for L1 fallback probes', async () => {
    const sepolia = await startBlockNumberServer({
      chainId: '0xaa36a7',
      blockNumber: '0x103',
    });

    const results = await probeFallbackChain([sepolia.url], 'testnet', 'L1');

    expect(results[0]).toMatchObject({
      ok: true,
      expectedChainId: 11155111,
      actualChainId: 11155111,
    });
  });

  it('classifies a 5xx response as ok:false with the status code', async () => {
    const a = await startBlockNumberServer({ status: 503 });
    const results = await probeFallbackChain([a.url], 'testnet', 'L2');
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.code).toBeGreaterThanOrEqual(500);
  });

  it('classifies a network-unreachable error as ok:false reason=unreachable', async () => {
    // Closed port: nothing listening at this URL.
    const results = await probeFallbackChain(
      ['http://127.0.0.1:1/'],
      'testnet',
      'L2',
    );
    expect(results[0]).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('emits per-slot log lines via the injected logger', async () => {
    const a = await startBlockNumberServer({ blockNumber: '0x103' });
    const b = await startBlockNumberServer({ status: 429 });
    const log = vi.fn();
    await probeFallbackChain([a.url, b.url], 'testnet', 'L2', { log });
    const messages = log.mock.calls.map((call) => call[0] as string);
    expect(messages.some((m) => /^\[rpc\] L2 .* ok latency=/.test(m))).toBe(true);
    expect(messages.some((m) => /^\[rpc\] L2 .* warn 429/.test(m))).toBe(true);
  });
});

describe('summarizeFallbackChain (AC7 boot-log format)', () => {
  it('formats the canonical summary line', () => {
    const line = summarizeFallbackChain('L2', [
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
      'https://tenderly.example/x',
    ]);
    expect(line).toBe(
      '[rpc] L2 transport: fallback chain (3 providers) — primary=base-sepolia.publicnode.com',
    );
  });
});

/**
 * Issue #911 — manual live confidence pass for the default RPC provider lists.
 *
 * OFF the default `yarn test` gate by design: it makes real network calls to
 * each shipped default endpoint and asserts the returned chain-id. Run it
 * implement-time / when rotating an endpoint:
 *
 *   JINN_RPC_LIVE_PROBE=1 yarn vitest run test/preflight/rpc-network.test.ts
 *
 * A failure here means a shipped default 401/403'd, was unreachable, or
 * returned the wrong chain-id — substitute from the free pool and re-run.
 */
describe.skipIf(!process.env['JINN_RPC_LIVE_PROBE'])('default RPC lists — live chain-id probe (#911)', () => {
  const cases: ReadonlyArray<readonly [string, number, readonly string[]]> = [
    ['Base Sepolia', 84532, DEFAULT_TESTNET_RPC_URLS],
    ['Base mainnet', 8453, DEFAULT_MAINNET_RPC_URLS],
  ];

  async function liveChainId(url: string): Promise<number> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const json = (await res.json()) as { result?: string };
    if (!json.result) throw new Error(`${url} → no result`);
    return Number.parseInt(json.result, 16);
  }

  for (const [name, expectedChainId, list] of cases) {
    for (const url of list) {
      it(`${name} slot ${url} returns chain-id ${expectedChainId}`, async () => {
        expect(await liveChainId(url)).toBe(expectedChainId);
      }, 20_000);
    }
  }
});
