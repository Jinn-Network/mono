/**
 * Stub indexer smoke test (r83r Task 7).
 *
 * Asserts: emit a MetadataSet event via a direct on-chain call to the stub
 * IdentityRegistryStub → the stub indexer translates it into a PluginPublication
 * row → GET /v1/discovery/plugin-publications returns the row within 5 s.
 *
 * Runs via `yarn e2e:cold-start-builder` (acceptance tier). Requires `anvil` in PATH.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  encodeAbiParameters,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startAnvil, FOUNDRY_ACCOUNTS, type AnvilHandle } from './anvil.js';
import {
  deployIdentityRegistry,
  IDENTITY_REGISTRY_STUB_ABI,
  type IdentityRegistryHandle,
} from './identity-registry-deploy.js';
import { startStubIpfs, type StubIpfsHandle } from './stub-ipfs.js';
import { startStubIndexer, type StubIndexerHandle } from './stub-indexer.js';
import { PLUGIN_PAYLOAD_TUPLE } from '../../../src/erc8004/abis.js';

describe('stub-indexer smoke (r83r)', () => {
  let anvil: AnvilHandle;
  let registry: IdentityRegistryHandle;
  let ipfs: StubIpfsHandle;
  let indexer: StubIndexerHandle;

  beforeAll(async () => {
    anvil = await startAnvil();
    registry = await deployIdentityRegistry({ rpcUrl: anvil.rpcUrl });
    ipfs = await startStubIpfs();
    indexer = await startStubIndexer({
      rpcUrl: anvil.rpcUrl,
      identityRegistryAddress: registry.address,
    });
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([indexer.stop(), ipfs.stop(), anvil.stop()]);
  });

  it('stubs IPFS: POST /api/v0/add returns a deterministic CID', async () => {
    const body = new FormData();
    body.append('file', new Blob([Buffer.from('hello world')], { type: 'application/octet-stream' }), 'test.bin');

    const resp = await fetch(`${ipfs.registryUrl}/api/v0/add?pin=true&cid-version=1`, {
      method: 'POST',
      body,
    });
    expect(resp.ok).toBe(true);
    const json = await resp.json() as { Hash: string };
    expect(json.Hash).toMatch(/^f01551220[0-9a-f]{64}$/);

    // Same bytes → same CID.
    const body2 = new FormData();
    body2.append('file', new Blob([Buffer.from('hello world')], { type: 'application/octet-stream' }), 'test.bin');
    const resp2 = await fetch(`${ipfs.registryUrl}/api/v0/add?pin=true&cid-version=1`, {
      method: 'POST',
      body: body2,
    });
    const json2 = await resp2.json() as { Hash: string };
    expect(json2.Hash).toBe(json.Hash);
  });

  it('MetadataSet event → PluginPublication row appears within 5 s', async () => {
    const chain = defineChain({
      id: 31337,
      name: 'anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [anvil.rpcUrl] } },
    });

    const account = privateKeyToAccount(FOUNDRY_ACCOUNTS[0]!.privateKey);
    const walletClient = createWalletClient({ account, chain, transport: http(anvil.rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(anvil.rpcUrl) });

    // Register the account as an agent so we have a valid agentId.
    const registerHash = await walletClient.writeContract({
      address: registry.address,
      abi: IDENTITY_REGISTRY_STUB_ABI,
      functionName: 'register',
      args: [account.address],
      account,
      chain,
    });
    const registerReceipt = await publicClient.waitForTransactionReceipt({ hash: registerHash });
    expect(registerReceipt.status).toBe('success');

    // Get agentId.
    const agentId = await publicClient.readContract({
      address: registry.address,
      abi: IDENTITY_REGISTRY_STUB_ABI,
      functionName: 'agentIdByOwner',
      args: [account.address],
    });
    expect(agentId).toBeGreaterThan(0n);

    // Encode a plugin payload.
    const testCid = `f01551220${'aa'.repeat(32)}`;
    const metadataKey = `plugin:${testCid}`;
    const sha256Bytes = toHex(new Uint8Array(32).fill(0xab));
    const metadataValue = encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, [
      1,
      'test-plugin',
      '0.1.0',
      sha256Bytes as `0x${string}`,
      ['swe-rebench-v2.v1'],
      BigInt(Math.floor(Date.now() / 1000)),
    ]);

    // Emit the MetadataSet event via setMetadata.
    const metadataHash = await walletClient.writeContract({
      address: registry.address,
      abi: IDENTITY_REGISTRY_STUB_ABI,
      functionName: 'setMetadata',
      args: [agentId, metadataKey, metadataValue as `0x${string}`],
      account,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: metadataHash });

    // Wait for the indexer to ingest the event (up to 5 s).
    const deadline = Date.now() + 5_000;
    let row: ReturnType<typeof indexer.getRows>[number] | undefined;
    while (Date.now() < deadline) {
      row = indexer.getRows().find((r) => r.cid === testCid);
      if (row) break;
      await new Promise<void>((r) => setTimeout(r, 100));
    }

    expect(row, 'indexer row should appear within 5 s').toBeDefined();
    expect(row!.name).toBe('test-plugin');
    expect(row!.version).toBe('0.1.0');
    expect(row!.supports).toContain('swe-rebench-v2.v1');
    expect(row!.builderAgentId).toBe(String(agentId));

    // Also verify via the HTTP API.
    const apiResp = await fetch(
      `${indexer.url}/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1`,
    ).then((r) => r.json() as Promise<{ publications: unknown[] }>);
    expect(apiResp.publications.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('recordRunForTest appears in GET /v1/discovery/plugin-scores', async () => {
    const testCid = `f01551220${'cc'.repeat(32)}`;
    await indexer.recordRunForTest({
      pluginCid: testCid,
      taskId: '0xabc',
      operatorAgentId: '42',
      verdict: 'Pass',
      score: 100,
    });

    const resp = await fetch(
      `${indexer.url}/v1/discovery/plugin-scores?pluginCid=${testCid}`,
    ).then((r) => r.json() as Promise<{ scores: unknown[] }>);
    expect(resp.scores).toHaveLength(1);
    expect((resp.scores[0] as { verdict: string }).verdict).toBe('Pass');
  });
});
