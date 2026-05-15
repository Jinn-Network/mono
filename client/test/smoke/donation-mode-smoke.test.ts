import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { TaskEngine, type TaskEngineOptions } from '../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../src/harnesses/engine/state.js';
import { createCorpus } from '../../src/corpus/index.js';
import type { SignedEnvelope } from '../../src/types/envelope.js';
import type { DiscoveryAPI } from '../../src/discovery/types.js';

const {
  ipfsStore,
  uploadToIpfsMock,
} = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  let seq = 0;
  return {
    ipfsStore: store,
    uploadToIpfsMock: vi.fn(async (_url: string, payload: unknown) => {
      seq += 1;
      const schemaVersion =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? String((payload as Record<string, unknown>)['schemaVersion'] ?? 'payload')
          : 'payload';
      const cid = `bafy-${schemaVersion.replace(/[^a-z0-9]+/gi, '-')}-${seq}`;
      store.set(cid, payload);
      return cid;
    }),
  };
});

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: uploadToIpfsMock,
  cidToDigestHex: vi.fn(),
  fetchFromIpfs: vi.fn(async (_gatewayUrl: string, cid: string) => {
    const payload = ipfsStore.get(cid);
    if (payload === undefined) throw new Error(`fake IPFS CID not found: ${cid}`);
    return payload;
  }),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SOLVER_SAFE = '0x1111111111111111111111111111111111111111' as const;
const READER_SAFE = '0x2222222222222222222222222222222222222222' as const;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mkTmp(): string {
  const dir = join(tmpdir(), `jinn-donation-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTaskRun(requestId: string): PersistedTaskRunInput {
  const now = Date.now() - 1000;
  return {
    requestId,
    taskCid: 'bafy-donation-smoke-task',
    onchainCreationTx: '0x' + 'a'.repeat(64),
    onchainCreationBlock: 123,
    solverType: 'portfolio.v0',
    taskRole: 'restoration',
    windowStartTs: now,
    windowEndTs: now + 60_000,
    task: {
      id: 'donation-smoke-task',
      description: 'Donation mode smoke task',
      solverType: 'portfolio.v0',
      role: 'restoration',
      window: { startTs: now, endTs: now + 60_000 },
    },
  };
}

function makeEngineOptions(store: Store, tmp: string): TaskEngineOptions {
  return {
    store,
    paths: {
      workingDirRoot: join(tmp, 'work'),
      implStateDirRoot: join(tmp, 'impl-state'),
    },
    packagingDeps: {
      store,
      operatorEndpoint: 'https://operator.example.com',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
      donation: {
        enabled: true,
        ipfsRegistryUrl: 'fake-ipfs://registry',
        scrub: {
          identity: { username: 'adriano', hostname: 'devbox' },
          path: { home: '/Users/adriano' },
        },
      },
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'fake-ipfs://registry',
      agentEoaPrivateKey: TEST_PRIVATE_KEY,
      safeAddress: SOLVER_SAFE,
    },
    operatorConfig: {
      publicEndpoint: 'https://operator.example.com',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
      donation: { enabled: true },
    },
  };
}

class SmokeEngine extends TaskEngine {
  get testPersistence(): TaskRunPersistence {
    return this.persistence;
  }

  seedRuntimeDigest(requestId: string): void {
    const internals = this as unknown as {
      codeDigestsByRequest: Map<string, string>;
      modesByRequest: Map<string, 'train' | 'frozen'>;
    };
    internals.codeDigestsByRequest.set(requestId, 'sha256:' + '1'.repeat(64));
    internals.modesByRequest.set(requestId, 'train');
  }
}

describe('testnet donation mode e2e smoke', () => {
  let tmp: string;
  let producerStore: Store;
  let readerStore: Store;

  beforeEach(() => {
    tmp = mkTmp();
    producerStore = new Store(':memory:');
    readerStore = new Store(':memory:');
    ipfsStore.clear();
    uploadToIpfsMock.mockClear();
  });

  afterEach(() => {
    producerStore.close();
    readerStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('packages scrubbed artifacts to IPFS sources and reacquires them through corpus without x402', async () => {
    const requestId = '0x' + 'c'.repeat(64);
    const workingDir = join(tmp, 'work', requestId);
    mkdirSync(join(workingDir, 'sessions'), { recursive: true });
    mkdirSync(join(workingDir, 'env'), { recursive: true });
    writeFileSync(join(workingDir, 'env', 'API_TOKEN'), 'must-not-be-packaged');
    writeFileSync(
      join(workingDir, 'answer.json'),
      JSON.stringify({
        message: 'built by adriano on devbox',
        path: '/Users/adriano/project/output.json',
        token: 'secret-value',
      }),
    );
    writeFileSync(
      join(workingDir, 'OUTPUTS.json'),
      JSON.stringify({
        outputs: [{ path: 'answer.json', artifactType: 'output.portfolio.v0' }],
      }),
    );

    const engine = new SmokeEngine(makeEngineOptions(producerStore, tmp));
    await engine.observe(makeTaskRun(requestId));
    engine.seedRuntimeDigest(requestId);
    const p = engine.testPersistence;
    p.transition(requestId, TaskRunState.CLAIMED);
    p.transition(requestId, TaskRunState.WAITING);
    p.transition(requestId, TaskRunState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impl-state', 'portfolio-v0'),
      preSnapshotCapturedAt: 1,
      preSnapshotPayload: { capturedAt: 1, hlTime: 1, payload: {} },
    });
    p.transition(requestId, TaskRunState.RUNNING);
    p.transition(requestId, TaskRunState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: 2,
      postSnapshotPayload: { capturedAt: 2, hlTime: 2, payload: {} },
      fillsPayload: [],
      gatingClaim: {
        equityReturnPct: '0.05',
        maxDrawdownPct: '0.01',
        closedTradesCount: 25,
        tradedNotionalMultiple: '5.1',
      },
    });
    p.transition(requestId, TaskRunState.PACKAGING);

    await engine.process(requestId);
    const packed = p.getByRequestId(requestId);
    expect(packed?.state).toBe(TaskRunState.DELIVERING);
    expect(packed?.manifestCid).toBeTruthy();

    const envelope = ipfsStore.get(packed!.manifestCid!) as SignedEnvelope | undefined;
    expect(envelope?.schemaVersion).toBe('jinn.execution.v1');
    const donatedArtifact = envelope!.artifacts.find((artifact) => artifact.artifactType === 'output.portfolio.v0');
    expect(donatedArtifact?.sources?.[0]?.kind).toBe('ipfs');
    expect(donatedArtifact?.sources?.[0]?.encoding).toBe('jinn.artifact.donation.v1');

    const source = donatedArtifact!.sources![0]!;
    const wrapper = ipfsStore.get(source.cid) as Record<string, unknown>;
    expect(wrapper.schemaVersion).toBe('jinn.artifact.donation.v1');
    const donatedBytes = Buffer.from(wrapper.data as string, 'base64');
    const donatedJson = JSON.parse(donatedBytes.toString('utf8')) as Record<string, unknown>;
    expect(donatedJson.message).toBe('built by <USER> on <HOST>');
    expect(donatedJson.path).toBe('/users/anon/project/output.json');
    expect(donatedJson.token).toBe('<REDACTED>');
    expect(donatedBytes.toString('utf8')).not.toContain('secret-value');
    expect(source.sha256).toBe(sha256Hex(donatedBytes));
    expect(donatedArtifact!.sha256).toBe(source.sha256);

    const served = producerStore.getServedArtifact(donatedArtifact!.sha256);
    expect(served?.content.equals(donatedBytes)).toBe(true);

    const x402Acquire = vi.fn();
    const discovery: DiscoveryAPI = {
      findClaimableTasks: vi.fn().mockResolvedValue([]),
      listLaunchedSolverNets: vi.fn().mockResolvedValue([]),
      getLifecycleStatus: vi.fn().mockResolvedValue(undefined),
      queryEnvelopes: vi.fn().mockResolvedValue([{
        manifestCid: packed!.manifestCid,
        manifestHash: envelope!.signature.hash,
        operator: { agentId: '1', safeAddress: SOLVER_SAFE },
        evidenceTier: 'self-signed' as const,
        publishedAt: Math.floor(Date.now() / 1000),
      }]),
    };
    const corpus = createCorpus(
      {
        discovery,
        ipfsGatewayUrl: 'fake-ipfs://gateway',
        store: readerStore,
        signer: { privateKey: TEST_PRIVATE_KEY },
        selfSafeAddress: READER_SAFE,
      },
      {
        fetchFromIpfs: async (_gatewayUrl: string, cid: string) => {
          const payload = ipfsStore.get(cid);
          if (payload === undefined) throw new Error(`fake IPFS CID not found: ${cid}`);
          return payload;
        },
        acquireFn: x402Acquire,
      },
    );

    const [readEnvelope] = await corpus.read({ query: { solverType: 'portfolio.v0', limit: 1 } });
    expect(readEnvelope?.envelope.artifacts.find((artifact) => artifact.sha256 === donatedArtifact!.sha256)).toBeTruthy();
    const acquired = readEnvelope!.artifactContents.get(donatedArtifact!.sha256);
    expect(acquired?.source).toBe('ipfs');
    expect(acquired?.paidAmountUsdc).toBe('0');
    expect(acquired?.bytes.equals(donatedBytes)).toBe(true);
    expect(x402Acquire).not.toHaveBeenCalled();
    expect(readerStore.getNetworkArtifact(donatedArtifact!.sha256)?.content.equals(donatedBytes)).toBe(true);
  });
});
