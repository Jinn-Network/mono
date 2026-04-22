import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRpcNetwork, rpcHostForDisplay } from '../../src/preflight/rpc-network.js';

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

  it('reports only the host for display', () => {
    expect(rpcHostForDisplay('https://user:secret@example.com/path?key=abc')).toBe('example.com');
  });
});
