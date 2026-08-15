import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Store } from '../../src/store/store.js';
import { createCorpus } from '../../src/corpus/index.js';
import type { SignedEnvelope } from '../../src/types/envelope.js';
import type { CorpusDiscoveryPort } from '@jinn-network/core/corpus-read';
import { DiscoveryUnavailableError } from '../../src/discovery-client/types.js';
import type { EnvelopeRef } from '../../src/corpus/types.js';

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function sha256(buf: Buffer): string { return createHash('sha256').update(buf).digest('hex'); }

function fakeEnvelope(opts: { sha256: string; endpoint: string; priceUsdc: string; participantSafe: string }): SignedEnvelope {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'prediction.v0',
    role: 'solution',
    generatedAt: 1745978400,
    task: { cid: 'bafyIntent', onchainCreationTx: '0x' + 'a'.repeat(64), onchainCreationBlock: 1, requestId: '0x' + 'b'.repeat(64) },
    participant: { safeAddress: opts.participantSafe, agentEoa: '0x' + '2'.repeat(40) },
    window: { startTs: 0, endTs: 1000 },
    executor: { implName: 'test', implVersion: '0.1.0', clientGitSha: 'abc', codeDigest: 'sha256:' + 'c'.repeat(64), runtimeBundleDigest: 'sha256:' + 'd'.repeat(64), plugins: [], signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) } },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [{
      artifactType: 'output.prediction.v0',
      sha256: opts.sha256,
      access: { endpoint: opts.endpoint, priceUsdc: opts.priceUsdc },
    }],
    payload: {},
    signature: { algo: 'secp256k1', signer: '0x' + '2'.repeat(40), hash: '0x' + 'e'.repeat(64), sig: '0x' + 'f'.repeat(130) },
  };
}

function fakeEnvelopeRef(opts: { manifestCid: string; opSafe: string }): EnvelopeRef {
  return {
    manifestCid: opts.manifestCid,
    manifestHash: '0x' + 'a'.repeat(64),
    operator: { agentId: '1', safeAddress: opts.opSafe },
    evidenceTier: 'committed',
    publishedAt: 1745978400,
  };
}

function stubDiscovery(envelopeRefs: EnvelopeRef[] = []): CorpusDiscoveryPort {
  return {
    queryEnvelopes: vi.fn().mockResolvedValue(envelopeRefs),
  };
}

describe('createCorpus.read (integration)', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => store.close());

  it('runs the full pipeline and returns hash-verified envelopes', async () => {
    const realBytes = Buffer.from('integration test bytes', 'utf-8');
    const realSha = sha256(realBytes);
    const opSafe = '0x' + 'a'.repeat(40);

    const discovery = stubDiscovery([fakeEnvelopeRef({ manifestCid: 'bafyM', opSafe })]);

    const fetchFromIpfs = vi.fn(async (_g: string, cid: string) => {
      if (cid === 'bafyM') return fakeEnvelope({ sha256: realSha, endpoint: 'https://op.example.com', priceUsdc: '0', participantSafe: opSafe });
      throw new Error('unknown CID');
    });

    const acquireFn = vi.fn(async (_endpoint: string, sha: string) => {
      if (sha === realSha) return realBytes;
      return null;
    });

    const corpus = createCorpus({
      discovery,
      ipfsGatewayUrl: 'https://gateway.test',
      store,
      signer: { privateKey: TEST_KEY },
      selfSafeAddress: '0x' + 'b'.repeat(40),
    }, { fetchFromIpfs, acquireFn });

    const envelopes = await corpus.read({ query: { solverType: 'prediction.v0', limit: 5 } });
    expect(envelopes).toHaveLength(1);
    const ac = envelopes[0].artifactContents.get(realSha);
    expect(ac).toBeDefined();
    expect(ac!.bytes.equals(realBytes)).toBe(true);
    expect(ac!.source).toBe('origin');
    expect(ac!.paidAmountUsdc).toBe('0');
  });

  it('cache hit on second read', async () => {
    const realBytes = Buffer.from('cache test', 'utf-8');
    const realSha = sha256(realBytes);
    const opSafe = '0x' + 'a'.repeat(40);

    const discovery = stubDiscovery([fakeEnvelopeRef({ manifestCid: 'bafyM', opSafe })]);
    const fetchFromIpfs = vi.fn(async () => fakeEnvelope({ sha256: realSha, endpoint: 'https://op.example.com', priceUsdc: '0.001', participantSafe: opSafe }));
    const acquireFn = vi.fn(async () => realBytes);

    const corpus = createCorpus({
      discovery,
      ipfsGatewayUrl: 'https://gateway.test',
      store,
      signer: { privateKey: TEST_KEY },
      selfSafeAddress: '0x' + 'b'.repeat(40),
    }, { fetchFromIpfs, acquireFn });

    await corpus.read({ query: { solverType: 'prediction.v0', limit: 5 } });
    await corpus.read({ query: { solverType: 'prediction.v0', limit: 5 } });

    expect(acquireFn).toHaveBeenCalledTimes(1); // second read served from cache
  });

  it('surfaces DiscoveryUnavailableError from the corpus discovery port', async () => {
    const discovery: CorpusDiscoveryPort = {
      queryEnvelopes: vi.fn().mockRejectedValue(new DiscoveryUnavailableError('indexer HTTP 429')),
    };

    const corpus = createCorpus({
      discovery,
      ipfsGatewayUrl: 'https://gateway.test',
      store,
      signer: { privateKey: TEST_KEY },
      selfSafeAddress: '0x' + 'b'.repeat(40),
    });

    await expect(corpus.query({ limit: 5 })).rejects.toThrow(/indexer HTTP 429/);
    expect(discovery.queryEnvelopes).toHaveBeenCalled();
  });

  it('surfaces an actionable error when all configured corpus indexes fail', async () => {
    // discovery throws a non-transient error — corpus re-throws it.
    const discovery: CorpusDiscoveryPort = {
      queryEnvelopes: vi.fn().mockRejectedValue(new Error('rpc unavailable')),
    };

    const corpus = createCorpus({
      discovery,
      ipfsGatewayUrl: 'https://gateway.test',
      store,
      signer: { privateKey: TEST_KEY },
      selfSafeAddress: '0x' + 'b'.repeat(40),
    });

    await expect(corpus.query({ limit: 5 })).rejects.toThrow(
      /corpus query failed.*rpc unavailable/,
    );
  });
});
