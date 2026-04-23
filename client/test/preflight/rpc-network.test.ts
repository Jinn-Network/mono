import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRpcNetwork,
  evmLocalDevOverrideAcceptable,
  isLoopbackRpcUrl,
  rpcHostForDisplay,
} from '../../src/preflight/rpc-network.js';

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
