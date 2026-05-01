/**
 * Phase A.1 cross-operator e2e validation.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §8.
 *
 * Spins up an Anvil fork of Base, two operator daemons (A produces, B reads),
 * runs A through one restoration cycle, then drives B's corpus library to
 * fetch + verify the manifest's artifact via x402 + cache.
 *
 * Asserts:
 *   1. Bytes are non-empty
 *   2. network_artifacts row exists on B
 *   3. Second read uses the cache (no extra acquireFn call)
 *   4. Operator A's USDC balance increased by the price (when priceUsdc > 0)
 *
 * Usage:
 *   yarn corpus:e2e
 *
 * Status (Phase 4): the full Anvil-based fixture is out-of-band from this
 * phase; the integration test suite at `client/test/corpus/integration.test.ts`
 * covers the full pipeline (subgraph -> manifest fetch -> x402 -> hash-verify
 * -> cache hit) via mocks. This script is the placeholder entry point for the
 * subsequent phase that wires up the real two-daemon fixture; today it
 * exercises the corpus library end-to-end against in-memory stubs to confirm
 * the public API surface is wired correctly.
 */

import { createHash } from 'node:crypto';
import { Store } from '../src/store/store.js';
import { createCorpus } from '../src/corpus/index.js';
import type { SignedEnvelope } from '../src/types/envelope.js';

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function buildEnvelope(opts: {
  sha256: string;
  endpoint: string;
  priceUsdc: string;
  participantSafe: string;
}): SignedEnvelope {
  return {
    schemaVersion: 'jinn.execution.v1',
    kind: 'prediction.v0',
    role: 'restoration',
    generatedAt: Math.floor(Date.now() / 1000),
    intent: {
      cid: 'bafyIntent',
      onchainCreationTx: '0x' + 'a'.repeat(64),
      onchainCreationBlock: 1,
      requestId: '0x' + 'b'.repeat(64),
    },
    participant: { safeAddress: opts.participantSafe, agentEoa: '0x' + '2'.repeat(40) },
    window: { startTs: 0, endTs: 1000 },
    executor: {
      implName: 'corpus-e2e',
      implVersion: '0.1.0',
      clientGitSha: 'abc',
      codeDigest: 'sha256:' + 'c'.repeat(64),
      signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [
      {
        artifactType: 'output.prediction.v0',
        sha256: opts.sha256,
        access: { endpoint: opts.endpoint, priceUsdc: opts.priceUsdc },
      },
    ],
    payload: {},
    signature: {
      algo: 'secp256k1',
      signer: '0x' + '2'.repeat(40),
      hash: '0x' + 'e'.repeat(64),
      sig: '0x' + 'f'.repeat(130),
    },
  };
}

async function main() {
  console.log('[corpus-e2e] starting cross-operator validation');

  // Operator A's served bytes.
  const operatorA = '0x' + 'a'.repeat(40);
  const operatorB = '0x' + 'b'.repeat(40);
  const realBytes = Buffer.from(`corpus-e2e payload @ ${Date.now()}`, 'utf-8');
  const realSha = sha256Hex(realBytes);
  const endpoint = 'https://operator-a.example.com';

  // Operator B's local store.
  const store = new Store(':memory:');

  let acquireCalls = 0;
  const fakeFetch = async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        data: {
          executions: [
            {
              id: '1-0xabc',
              manifestCid: 'bafyManifest',
              manifestHash: '0x' + 'a'.repeat(64),
              tier: 'COMMITTED',
              publishedAt: String(Math.floor(Date.now() / 1000)),
              operator: { id: '1', agentId: '1', owner: operatorA, agentWallet: operatorA },
            },
          ],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const fakeFetchFromIpfs = async (_g: string, _cid: string) =>
    buildEnvelope({
      sha256: realSha,
      endpoint,
      priceUsdc: '0.001',
      participantSafe: operatorA,
    });

  const fakeAcquire = async (_endpoint: string, sha: string) => {
    acquireCalls += 1;
    if (sha === realSha) return realBytes;
    return null;
  };

  const corpus = createCorpus(
    {
      subgraphUrl: 'https://subgraph.test/graphql',
      ipfsGatewayUrl: 'https://gateway.test',
      store,
      signer: { privateKey: TEST_KEY },
      selfSafeAddress: operatorB,
    },
    { fetch: fakeFetch as typeof globalThis.fetch, fetchFromIpfs: fakeFetchFromIpfs, acquireFn: fakeAcquire },
  );

  // First read — should hit origin.
  const first = await corpus.read({ query: { kind: 'prediction.v0', limit: 5 } });
  if (first.length !== 1) throw new Error(`expected 1 envelope, got ${first.length}`);
  const ac = first[0].artifactContents.get(realSha);
  if (!ac) throw new Error('artifact content missing');
  if (!ac.bytes.equals(realBytes)) throw new Error('bytes mismatch');
  if (ac.source !== 'origin') throw new Error(`expected source=origin, got ${ac.source}`);
  if (acquireCalls !== 1) throw new Error(`expected 1 acquire call, got ${acquireCalls}`);

  // Verify network_artifacts row exists.
  const row = store.getNetworkArtifact(realSha);
  if (!row) throw new Error('network_artifacts row missing on B');
  if (row.source !== 'origin') throw new Error(`row.source expected origin, got ${row.source}`);

  // Second read — should hit cache.
  const second = await corpus.read({ query: { kind: 'prediction.v0', limit: 5 } });
  const ac2 = second[0].artifactContents.get(realSha);
  if (!ac2) throw new Error('cache artifact content missing');
  if (ac2.source !== 'cache') throw new Error(`expected source=cache on second read, got ${ac2.source}`);
  if (acquireCalls !== 1) throw new Error(`expected 1 total acquire call after cache hit, got ${acquireCalls}`);

  store.close();
  console.log('[corpus-e2e] OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('[corpus-e2e] FAILED:', err);
  process.exit(1);
});
