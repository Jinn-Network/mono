import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { ClaimRelayerConfig } from '../src/config.js';
import { ClaimRelayerStore } from '../src/db.js';
import { buildStatusPayload, createStatusServer } from '../src/http.js';
import { ClaimRelayer } from '../src/relayer.js';

const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538d0e9dae1f177b4dd056dbd8e1a6d69690' as const;
const SIGNER = privateKeyToAccount(PRIVATE_KEY).address;

let stores: ClaimRelayerStore[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function makeStore(): ClaimRelayerStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'jinn-claim-relayer-http-'));
  const store = new ClaimRelayerStore(path.join(dir, 'relayer.sqlite'));
  stores.push(store);
  return store;
}

function makeConfig(): ClaimRelayerConfig {
  const l1Url = 'https://l1-secret.example/rpc?token=super-secret';
  const l2Url = 'https://l2-secret.example/rpc?token=super-secret';
  return {
    privateKey: PRIVATE_KEY,
    signerAddress: SIGNER,
    l1RpcUrl: l1Url,
    l1RpcUrls: [l1Url],
    l2RpcUrl: l2Url,
    l2RpcUrls: [l2Url],
    l1Chain: { network: 'sepolia', chainId: 11155111 },
    l2Chain: { network: 'base-sepolia', chainId: 84532 },
    startBlock: 10n,
    dbPath: ':memory:',
    port: 0,
    pollIntervalMs: 60_000,
    batchBlocks: 5000n,
    artifacts: {
      l1ArtifactPath: '/tmp/l1.json',
      l2ArtifactPath: '/tmp/l2.json',
      distributor: '0x2222222222222222222222222222222222222222',
      messenger: '0x3333333333333333333333333333333333333333',
      claimEmitter: '0x4444444444444444444444444444444444444444',
    },
  };
}

function makeRelayer(config: ClaimRelayerConfig, store: ClaimRelayerStore): ClaimRelayer {
  const clients = {
    l1Public: {
      readContract: async ({ functionName }: any) => {
        if (functionName === 'owner') return SIGNER;
        if (functionName === 'messenger') return config.artifacts.messenger;
        throw new Error(`unexpected ${functionName}`);
      },
      getBlockNumber: async () => 10n,
      getLogs: async () => [],
    },
    l2Public: {
      readContract: async () => '0x',
      getBlockNumber: async () => 10n,
      getLogs: async () => [],
    },
    l1Wallet: {
      account: { address: SIGNER },
      writeContract: async () => '0x1' as const,
    },
  };
  return new ClaimRelayer(config, store, clients);
}

describe('claim-relayer HTTP status', () => {
  it('redacts secrets and RPC URLs from status payload', async () => {
    const config = makeConfig();
    const store = makeStore();
    const relayer = makeRelayer(config, store);
    await relayer.startupCheck();

    const payload = buildStatusPayload({
      config,
      store,
      relayer,
      startedAtMs: Date.now(),
    });
    const json = JSON.stringify(payload);

    expect(payload.ready).toBe(true);
    expect(json).not.toContain(config.privateKey);
    expect(json).not.toContain('super-secret');
    expect(json).not.toContain(config.l1RpcUrl);
    expect(json).not.toContain(config.l2RpcUrl);
    // Per #592 AC3: redacted payload exposes provider count + primary host
    // (non-secret hostname only — paths and api-key query strings stay
    // masked) instead of an opaque `[redacted]` blob.
    expect(String(payload.config.l1RpcUrl)).toMatch(/fallback chain \(1 providers\): primary host=l1-secret\.example/);
    expect(String(payload.config.l2RpcUrl)).toMatch(/fallback chain \(1 providers\): primary host=l2-secret\.example/);
  });

  it('serves /health, /ready, and /status', async () => {
    const config = makeConfig();
    const store = makeStore();
    const relayer = makeRelayer(config, store);
    await relayer.startupCheck();
    const server = createStatusServer({ config, store, relayer });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await expect(fetch(`${baseUrl}/health`).then((r) => r.json())).resolves.toEqual({ ok: true });
      await expect(fetch(`${baseUrl}/ready`).then(async (r) => ({ status: r.status, body: await r.json() }))).resolves.toEqual({
        status: 200,
        body: { ok: true, ready: true },
      });
      const status = await fetch(`${baseUrl}/status`).then((r) => r.json() as Promise<any>);
      expect(status.ready).toBe(true);
      expect(JSON.stringify(status)).not.toContain('super-secret');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
