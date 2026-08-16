/**
 * Smoke test for the boot-time RPC fallback-chain probe + summary-line
 * formatting (the integration that main.ts performs right after
 * checkRpcNetwork).
 *
 * AC7 (issue #592): the daemon must log `[rpc] L2 transport: fallback chain
 * (N providers) — primary=<host>` once at boot. AC9: per-slot probe lines.
 *
 * Testing main.ts directly is impractical — it's the daemon entry point and
 * touches the filesystem, keystore, anvil, the dashboard SPA, etc. This test
 * exercises the same call sequence main.ts performs in isolation:
 *
 *   await probeFallbackChain(rpcUrls, network, 'L2', { log });
 *   log(summarizeFallbackChain('L2', rpcUrls));
 *
 * If a future refactor inlines the call differently, this test fails fast
 * pointing at the canonical format.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  probeFallbackChain,
  summarizeFallbackChain,
} from '../../src/preflight/rpc-network.js';

const servers: Server[] = [];

function startBlockNumberServer(): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id?: number; method?: string };
        const result = parsed.method === 'eth_chainId' ? '0x14a34' : '0x100';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('missing address');
      resolve({ url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('rpc boot probe + summary integration (AC7 + AC9)', () => {
  it('emits per-slot lines followed by the summary line for a 3-URL chain', async () => {
    const a = await startBlockNumberServer();
    const b = await startBlockNumberServer();
    const c = await startBlockNumberServer();
    const rpcUrls = [a.url, b.url, c.url];

    const log = vi.fn();
    await probeFallbackChain(rpcUrls, 'testnet', 'L2', { log });
    log(summarizeFallbackChain('L2', rpcUrls));

    const messages = log.mock.calls.map((call) => call[0] as string);
    // Three per-slot probe lines (one per URL).
    const probeLines = messages.filter((m) => /^\[rpc\] L2 .* ok latency=/.test(m));
    expect(probeLines.length).toBe(3);
    // Exactly one summary line in the canonical AC7 format.
    const summaryLines = messages.filter((m) => /^\[rpc\] L2 transport: fallback chain \(3 providers\) — primary=/.test(m));
    expect(summaryLines.length).toBe(1);
  });
});
