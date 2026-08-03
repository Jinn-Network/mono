import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DSSE_ENVELOPE_MEDIA_TYPE,
  dssePreAuthEncoding,
  parseDsseEnvelope,
  recordDigest,
  sealDsseEnvelope,
} from '@jinn-network/trust-core';
import {
  SUBMISSION_MEDIA_TYPE,
  TASK_MEDIA_TYPE,
  SubmissionRecordSchema,
} from '@jinn-network/task-execution-protocol';
import { EVALUATION_SPEC_MEDIA_TYPE } from '@jinn-network/task-execution-profiles';
import {
  archivePagePath,
  headPath,
  sealJson,
  WELL_KNOWN_PATH,
  type AvailableAnnouncement,
} from '@jinn-network/record-discovery-protocol';
import { coldSync, createVerifyDriver, fetchHead, type SyncedEntry } from '@jinn-network/record-discovery-client';
import { createHttpTransport } from '@jinn-network/record-discovery-transport-http';
import {
  createInMemoryMarketplaceObserveStore,
  createInMemoryPostingIntentStore,
  makeMarketplaceBackend,
} from '@jinn-network/marketplace-binding';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeRequester,
  createNativeRequesterPostTask,
  decodeNativeRequesterAnnouncement,
  NATIVE_REQUESTER_ASSOCIATION_FACT,
  type NativeRequesterRoles,
  type NativeRequesterSubmissionVerifier,
  createNativeRequesterSubmissionResolver,
  verifyNativeRequesterSubmissionEnvelope,
} from '../../src/native-requester/requester.js';

const CHAIN = {
  chainId: 84532,
  taskCoordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98',
  jinnRouter: '0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247',
  mechMarketplace: '0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7',
  activityChecker: '0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70',
  generation: 'today' as const,
};
const CREATOR = '0x1111111111111111111111111111111111111111' as const;
const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const AUTHORITY_TIME = {
  chainId: 84532 as const,
  blockNumber: '100',
  blockHash: `0x${'cd'.repeat(32)}` as const,
  timestamp: '2026-08-02T11:59:00.000Z',
  finalized: true as const,
};
const REQUESTER_AGENT = 'urn:jinn:requester:test';
const TERMS = {
  solutionMaxDeliveryRateWei: 2n,
  verdictMaxDeliveryRateWei: 3n,
  responseTimeoutSeconds: 60n,
  allowSolverSelfEvaluation: false,
} as const;

function roles(): NativeRequesterRoles & {
  readonly requesterSubmission: NativeRequesterSubmissionVerifier;
  readonly requesterDiscovery: NativeRequesterSubmissionVerifier;
} {
  const byRole = new Map();
  for (const role of ['requester-submission', 'admission', 'requester-discovery'] as const) {
    const pair = generateKeyPairSync('ed25519');
    byRole.set(role, {
      keyId: `did:key:${role}`,
      publicKey: pair.publicKey,
      sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, pair.privateKey)),
    });
  }
  const requesterSubmission = byRole.get('requester-submission');
  const requesterDiscovery = byRole.get('requester-discovery');
  if (requesterSubmission === undefined || requesterDiscovery === undefined) throw new Error('test requester identity missing');
  return {
    get(role) {
      const identity = byRole.get(role);
      if (identity === undefined) throw new Error(`missing test role ${role}`);
      return identity;
    },
    requesterSubmission: {
      keyId: requesterSubmission.keyId,
      publicKey: requesterSubmission.publicKey,
    },
    requesterDiscovery: {
      keyId: requesterDiscovery.keyId,
      publicKey: requesterDiscovery.publicKey,
    },
  };
}

function fixture(input: {
  readonly stateDir: string;
  readonly loadRoles?: () => Promise<NativeRequesterRoles>;
  readonly readChain?: () => Promise<typeof CHAIN>;
  readonly post?: ReturnType<typeof vi.fn>;
  readonly recover?: ReturnType<typeof vi.fn>;
  readonly recoverPosting?: ReturnType<typeof vi.fn>;
  readonly terms?: typeof TERMS;
  readonly checkpoints?: (name: string) => Promise<void>;
  readonly now?: () => Date;
}) {
  const post = input.post ?? vi.fn(async () => ({ taskId: 17n, txHash: TX_HASH }));
  const readChain = input.readChain ?? vi.fn(async () => CHAIN);
  const loadRoles = input.loadRoles ?? vi.fn(async () => roles());
  return {
    requester: createNativeRequester({
      stateDir: input.stateDir,
      requesterAgent: REQUESTER_AGENT,
      admissionAgent: 'urn:jinn:admission:test',
      publicBaseUrl: 'https://requester.test',
      readChain,
      authorityTime: async () => AUTHORITY_TIME,
      loadRoles,
      creatorSafe: CREATOR,
      posting: {
        terms: input.terms ?? TERMS,
        post,
        recoverPosting: input.recoverPosting ?? (async () => ({
          resolvedScopes: [], uncertainScopes: [], retryableScopes: [], conflicts: [],
        })),
        recover: input.recover ?? (async () => null),
        canonicalTaskCreated: async (expected) => ({
          canonical: true as const,
          chainId: expected.chainId,
          coordinator: expected.coordinator,
          creator: expected.creator,
          taskId: expected.taskId,
          taskDigest: expected.taskDigest,
          txHash: expected.txHash,
          terms: expected.terms,
          maxClaims: expected.maxClaims,
        }),
      },
      now: input.now ?? (() => new Date('2026-08-02T12:00:00.000Z')),
      ...(input.checkpoints === undefined ? {} : { checkpoints: input.checkpoints }),
    }),
    post,
    readChain,
    loadRoles,
  };
}

describe('native requester', () => {
  it('refuses mainnet before loading native role keys or constructing a post', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-refusal-'));
    const loadRoles = vi.fn(async () => roles());
    const post = vi.fn();
    const { requester } = fixture({
      stateDir,
      loadRoles,
      post,
      readChain: async () => ({ ...CHAIN, chainId: 8453 }),
    });

    await expect(requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'run-1',
    })).rejects.toThrow(/Base Sepolia.*84532|mainnet/i);
    expect(loadRoles).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('fails closed on uncertain requester-backend recovery before loading product keys or posting', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-recovery-gate-'));
    const loadRoles = vi.fn(async () => roles());
    const post = vi.fn();
    const recoverPosting = vi.fn(async () => ({
      resolvedScopes: [],
      uncertainScopes: ['urn:uuid:11111111-1111-1111-1111-111111111111'] as const,
      retryableScopes: [],
      conflicts: [],
    }));
    const requester = fixture({ stateDir, loadRoles, post, recoverPosting }).requester;

    await expect(requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'blocked-uncertain',
    })).rejects.toThrow(/posting recovery is not closed.*uncertain/u);
    expect(recoverPosting).toHaveBeenCalledOnce();
    expect(loadRoles).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('does not admit unrelated new work while a retryable requester scope remains after local reconciliation', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-retryable-gate-'));
    const post = vi.fn();
    const recoverPosting = vi.fn(async () => ({
      resolvedScopes: [],
      uncertainScopes: [],
      retryableScopes: ['urn:uuid:22222222-2222-2222-2222-222222222222'] as const,
      conflicts: [],
    }));
    const requester = fixture({ stateDir, post, recoverPosting }).requester;

    await expect(requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'blocked-retryable',
    })).rejects.toThrow(/posting recovery is not closed.*retryable/u);
    expect(recoverPosting).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('uses B1 as a Task/EvaluationSpec template but seals run-specific receipt, Submission, and requester DSSE in order before a canonical post', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-order-'));
    const order: string[] = [];
    const { requester, post } = fixture({
      stateDir,
      checkpoints: async (name) => { order.push(name); },
    });

    const result = await requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'run-one',
    });

    expect(order).toEqual([
      'evaluation-spec-sealed',
      'task-sealed',
      'admission-receipt-sealed',
      'submission-sealed',
      'requester-envelope-sealed',
      'draft-durable',
      'before-broadcast',
      'after-broadcast',
      'canonical-associated',
      'source-intent-durable',
      'source-announced',
    ]);
    expect(post).toHaveBeenCalledOnce();
    const postInput = post.mock.calls[0]![0];
    expect(postInput.terms).toEqual(TERMS);
    expect(SubmissionRecordSchema.parse(JSON.parse(new TextDecoder().decode(postInput.submissionBytes))).requester)
      .toBe(REQUESTER_AGENT);
    const admissionPayload = JSON.parse(new TextDecoder().decode(
      parseDsseEnvelope(postInput.admissionReceiptBytes).payloadBytes,
    )) as { predicate?: { issuer?: string } };
    expect(admissionPayload.predicate?.issuer).toBe('urn:jinn:admission:test');
    expect(admissionPayload.predicate?.issuer).not.toContain('run-one');
    expect(recordDigest(postInput.taskBytes)).toBe(
      'sha256:40ae3efd61b75951ad68a868fdd020de931e3d27eb1b448f341997bf4917a598',
    );
    expect(recordDigest(postInput.evaluationSpecBytes)).toBe(
      'sha256:4e9b938d24e7752630f0fb27c2295781a7b5ecfcb130daa28d320bbedd96e962',
    );
    expect(result.association.taskId).toBe(17n);
    expect(result.association.postingTerms).toEqual({
      solutionMaxDeliveryRateWei: '2',
      verdictMaxDeliveryRateWei: '3',
      responseTimeoutSeconds: '60',
      allowSolverSelfEvaluation: false,
    });
    expect(result.association.intendedSpendWei).toBe('5');
    expect(result.association.submissionUri).toMatch(/^urn:uuid:/u);
    expect(result.association.nonce).toMatch(/^[a-f0-9]{32}$/u);
    expect(result.association.submissionDigest).not.toBe(
      'sha256:5514ad79452da75e10978092ae46c2e90eaaa69b239fc459b70712e2f8aeaed',
    );
    expect(result.association.requesterEnvelopeDigest).not.toBe(
      'sha256:2dd3370dc1fe48d555f665c39d96ce24e4fffcc703edfbec4163d72115e7d4fc',
    );

    const record = await requester.handleDiscoveryRequest(new Request(
      `https://requester.test${result.association.submission.path}`,
    ));
    expect(record.status).toBe(200);
    expect(record.headers.get('cache-control')).toContain('immutable');
    expect(record.headers.get('content-type')).toBe(SUBMISSION_MEDIA_TYPE);
    expect(recordDigest(new Uint8Array(await record.arrayBuffer()))).toBe(result.association.submissionDigest);

    const contentTypes = await Promise.all([
      [result.association.task.path, TASK_MEDIA_TYPE],
      [result.association.evaluationSpec.path, EVALUATION_SPEC_MEDIA_TYPE],
      [result.association.admissionReceipt.path, DSSE_ENVELOPE_MEDIA_TYPE],
      [result.association.requesterEnvelope.path, DSSE_ENVELOPE_MEDIA_TYPE],
    ].map(async ([path, expected]) => {
      const response = await requester.handleDiscoveryRequest(new Request(`https://requester.test${path}`));
      return [response.status, response.headers.get('content-type'), expected];
    }));
    expect(contentTypes).toEqual([
      [200, TASK_MEDIA_TYPE, TASK_MEDIA_TYPE],
      [200, EVALUATION_SPEC_MEDIA_TYPE, EVALUATION_SPEC_MEDIA_TYPE],
      [200, DSSE_ENVELOPE_MEDIA_TYPE, DSSE_ENVELOPE_MEDIA_TYPE],
      [200, DSSE_ENVELOPE_MEDIA_TYPE, DSSE_ENVELOPE_MEDIA_TYPE],
    ]);

    await rm(stateDir, { recursive: true, force: true });
  });

  it('reconciles a resolved broadcast before accepting a retry and makes the same run ID idempotent', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-recovery-'));
    const post = vi.fn(async () => ({ taskId: 17n, txHash: TX_HASH }));
    const failAfterBroadcast = vi.fn(async (name: string) => {
      if (name === 'after-broadcast') throw new Error('simulated process death after broadcast');
    });
    const first = fixture({ stateDir, post, checkpoints: failAfterBroadcast }).requester;

    await expect(first.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'recover-me',
    })).rejects.toThrow(/simulated process death/i);
    expect(post).toHaveBeenCalledOnce();

    const restarted = fixture({ stateDir, post }).requester;
    const recovered = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'recover-me',
    });
    const replayed = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'recover-me',
    });

    expect(post).toHaveBeenCalledOnce();
    expect(replayed.association).toEqual(recovered.association);
    await rm(stateDir, { recursive: true, force: true });
  });

  it('recovers wallet-return uncertainty before any rebroadcast and announces the same sealed bundle once', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-wallet-uncertain-'));
    const identities = roles();
    let backendCalls = 0;
    const post = vi.fn(async () => {
      backendCalls += 1;
      if (backendCalls === 1) throw new Error('wallet result lost after invocation');
      // The shared requester backend replays its resolved WAL outcome; this second operation
      // call does not authorize a second wallet broadcast.
      return { taskId: 17n, txHash: TX_HASH };
    });
    const recover = vi.fn(async () => null);
    const first = fixture({
      stateDir,
      post,
      recover,
      loadRoles: async () => identities,
    }).requester;

    await expect(first.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'wallet-uncertain',
    })).rejects.toThrow(/wallet result lost/u);
    const restarted = fixture({
      stateDir,
      post,
      recover,
      loadRoles: async () => identities,
    }).requester;
    const recovered = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'wallet-uncertain',
    });
    const replay = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'wallet-uncertain',
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(recover).not.toHaveBeenCalled();
    expect(recovered.reused).toBe(true);
    expect(replay.association).toEqual(recovered.association);
    expect(recovered.association.publication).toMatchObject({
      state: 'published',
      sequence: '0000000000000001',
    });
    await rm(stateDir, { recursive: true, force: true });
  });

  it('adopts a pending requester v1 publication through the generic writer without changing its signed page or head', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-v1-source-'));
    const identities = roles();
    const first = fixture({ stateDir, loadRoles: async () => identities }).requester;
    const initial = await first.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'v1-source-recovery',
    });
    const pagePath = join(stateDir, 'discovery', archivePagePath('requester', initial.association.publication.page));
    const publicHeadPath = join(stateDir, 'discovery', headPath('requester'));
    const originalPage = new Uint8Array(await readFile(pagePath));
    const originalHead = new Uint8Array(await readFile(publicHeadPath));

    const associationName = (await readdir(join(stateDir, 'associations')))[0]!;
    const associationPath = join(stateDir, 'associations', associationName);
    const stored = JSON.parse(await readFile(associationPath, 'utf8')) as {
      publication: Record<string, unknown>;
    };
    stored.publication.state = 'pending';
    delete stored.publication.writerIntent;
    await writeFile(associationPath, `${JSON.stringify(stored)}\n`, 'utf8');
    await unlink(join(stateDir, 'requester-source.json'));

    const restarted = fixture({ stateDir, loadRoles: async () => identities }).requester;
    const recovered = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'v1-source-recovery',
    });
    expect(recovered.association.publication.state).toBe('published');
    expect(new Uint8Array(await readFile(pagePath))).toEqual(originalPage);
    expect(new Uint8Array(await readFile(publicHeadPath))).toEqual(originalHead);
    const source = JSON.parse(await readFile(join(stateDir, 'requester-source.json'), 'utf8')) as {
      version: number;
      last?: { sequence?: string; entryDigest?: string; page?: string };
    };
    expect(source).toMatchObject({
      version: 1,
      last: {
        sequence: initial.association.publication.sequence,
        entryDigest: initial.association.publication.entryDigest,
        page: initial.association.publication.page,
      },
    });
    expect(source).not.toHaveProperty('durable');
    await rm(stateDir, { recursive: true, force: true });
  });

  it('recovers the source-global frozen intent after restart without re-signing it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-global-intent-'));
    const identities = roles();
    const first = fixture({
      stateDir,
      loadRoles: async () => identities,
      checkpoints: async (name) => {
        if (name === 'source-intent-durable') throw new Error('simulated death after source-global intent');
      },
    }).requester;
    await expect(first.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'global-intent-restart',
    })).rejects.toThrow(/after source-global intent/u);

    const pendingState = JSON.parse(await readFile(join(stateDir, 'requester-source.json'), 'utf8')) as {
      pending?: {
        intent: {
          page: { bytesBase64: string; path: string };
          head: { bytesBase64: string; path: string };
        };
      };
    };
    expect(pendingState.pending).toBeDefined();
    const frozenPage = new Uint8Array(Buffer.from(pendingState.pending!.intent.page.bytesBase64, 'base64'));
    const frozenHead = new Uint8Array(Buffer.from(pendingState.pending!.intent.head.bytesBase64, 'base64'));

    const restarted = fixture({ stateDir, loadRoles: async () => identities }).requester;
    const recovered = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'global-intent-restart',
    });
    expect(recovered.association.publication.state).toBe('published');
    expect(new Uint8Array(await readFile(join(stateDir, 'discovery', pendingState.pending!.intent.page.path))))
      .toEqual(frozenPage);
    expect(new Uint8Array(await readFile(join(stateDir, 'discovery', pendingState.pending!.intent.head.path))))
      .toEqual(frozenHead);
    const committed = JSON.parse(await readFile(join(stateDir, 'requester-source.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(committed).sort()).toEqual(['last', 'version']);
    expect(committed).not.toHaveProperty('pending');
    await rm(stateDir, { recursive: true, force: true });
  });

  it('continues the generic source from the sole v1 requester-source position', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-source-chain-'));
    const identities = roles();
    let posted = 16n;
    let sourceTime = new Date('2026-08-02T12:00:00.000Z');
    const post = vi.fn(async () => ({ taskId: ++posted, txHash: TX_HASH }));
    const requester = fixture({
      stateDir,
      loadRoles: async () => identities,
      post,
      now: () => sourceTime,
    }).requester;
    const first = await requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'source-chain-one',
    });
    sourceTime = new Date('2026-08-02T12:01:00.000Z');
    const second = await requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'source-chain-two',
    });

    expect(first.association.publication.sequence).toBe('0000000000000001');
    expect(second.association.publication).toMatchObject({
      state: 'published',
      sequence: '0000000000000002',
      page: '0000000000000002',
    });
    expect(second.association.publication.entry.previous).toBe(first.association.publication.entryDigest);
    const source = JSON.parse(await readFile(join(stateDir, 'requester-source.json'), 'utf8')) as Record<string, unknown>;
    expect(source).toEqual({
      version: 1,
      last: {
        sequence: second.association.publication.sequence,
        entryDigest: second.association.publication.entryDigest,
        page: second.association.publication.page,
        head: second.association.publication.head,
      },
    });
    await rm(stateDir, { recursive: true, force: true });
  });

  it('linearizes concurrent announcements in one source-global slot and continues after restart', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-source-concurrent-'));
    const identities = roles();
    const outcomes = new Map<string, { taskId: bigint; txHash: typeof TX_HASH }>();
    let nextTaskId = 30n;
    const post = vi.fn(async (request: { submissionBytes: Uint8Array }) => {
      const digest = recordDigest(request.submissionBytes);
      let outcome = outcomes.get(digest);
      if (outcome === undefined) {
        outcome = { taskId: nextTaskId++, txHash: TX_HASH };
        outcomes.set(digest, outcome);
      }
      return outcome;
    });
    const shared = {
      stateDir,
      loadRoles: async () => identities,
      post,
      // The source lease must advance equal wall-clock values itself.
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    };
    const requesterA = fixture(shared).requester;
    const requesterB = fixture(shared).requester;
    const concurrent = await Promise.all([
      requesterA.request({ network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'concurrent-a' }),
      requesterB.request({ network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'concurrent-b' }),
    ]);
    const ordered = concurrent.map((result) => result.association.publication).sort((left, right) => (
      left.sequence < right.sequence ? -1 : 1
    ));
    expect(ordered.map((publication) => publication.sequence)).toEqual([
      '0000000000000001', '0000000000000002',
    ]);
    expect(ordered[1]!.entry.previous).toBe(ordered[0]!.entryDigest);

    const restarted = fixture(shared).requester;
    const third = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'concurrent-after-restart',
    });
    expect(third.association.publication.sequence).toBe('0000000000000003');
    expect(third.association.publication.entry.previous).toBe(ordered[1]!.entryDigest);
    const source = JSON.parse(await readFile(join(stateDir, 'requester-source.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(source).sort()).toEqual(['last', 'version']);
    expect(source).not.toHaveProperty('pending');
    await rm(stateDir, { recursive: true, force: true });
  });

  it('persists exact posting terms before broadcast and reuses them across recovery despite configuration drift', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-terms-recovery-'));
    const identities = roles();
    const firstTerms = TERMS;
    const changedTerms = {
      solutionMaxDeliveryRateWei: 200n,
      verdictMaxDeliveryRateWei: 300n,
      responseTimeoutSeconds: 600n,
      allowSolverSelfEvaluation: false,
    } as const;
    let backendCalls = 0;
    const post = vi.fn(async (input) => {
      expect(input.terms).toEqual(firstTerms);
      backendCalls += 1;
      if (backendCalls === 1) throw new Error('wallet result unavailable');
      return { taskId: 17n, txHash: TX_HASH };
    });
    const recover = vi.fn(async (draft) => {
      expect(draft.terms).toEqual(firstTerms);
      expect(draft.maxClaims).toBe(1);
      return { taskId: 17n, txHash: TX_HASH };
    });
    const first = fixture({
      stateDir,
      terms: firstTerms,
      post,
      recover,
      loadRoles: async () => identities,
    }).requester;

    await expect(first.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'terms-survive-restart',
    })).rejects.toThrow(/wallet result unavailable/u);

    const restarted = fixture({
      stateDir,
      terms: changedTerms,
      post,
      recover,
      loadRoles: async () => identities,
    }).requester;
    const result = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'terms-survive-restart',
    });

    expect(result.association.postingTerms).toEqual({
      solutionMaxDeliveryRateWei: '2',
      verdictMaxDeliveryRateWei: '3',
      responseTimeoutSeconds: '60',
      allowSolverSelfEvaluation: false,
    });
    expect(result.association.intendedSpendWei).toBe('5');
    expect(post).toHaveBeenCalledTimes(2);
    expect(recover).not.toHaveBeenCalled();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('resolves only an exact canonical association whose requester DSSE verifies with the B2 key', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-resolver-'));
    const identities = roles();
    const { requester, post } = fixture({
      stateDir,
      loadRoles: async () => identities,
    });
    const result = await requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'trusted-association',
    });
    const resolver = createNativeRequesterSubmissionResolver({
      stateDir,
      requesterSubmission: identities.requesterSubmission,
    });
    const submissionBytes = post.mock.calls[0]![0].submissionBytes;
    const envelopeResponse = await requester.handleDiscoveryRequest(new Request(
      `https://requester.test${result.association.requesterEnvelope.path}`,
    ));
    const envelopeBytes = new Uint8Array(await envelopeResponse.arrayBuffer());
    expect(verifyNativeRequesterSubmissionEnvelope({
      envelopeBytes,
      submissionBytes,
      requesterSubmission: identities.requesterSubmission,
    })).toBe(true);

    const requesterRole = identities.get('requester-submission');
    const wrongPayload = new TextEncoder().encode('{}');
    const wrongPayloadEnvelope = sealDsseEnvelope({
      payloadType: SUBMISSION_MEDIA_TYPE,
      payloadBytes: wrongPayload,
      signatures: [{
        keyid: requesterRole.keyId,
        signature: requesterRole.sign(dssePreAuthEncoding(SUBMISSION_MEDIA_TYPE, wrongPayload)),
      }],
    });
    expect(verifyNativeRequesterSubmissionEnvelope({
      envelopeBytes: wrongPayloadEnvelope,
      submissionBytes,
      requesterSubmission: identities.requesterSubmission,
    })).toBe(false);
    const noncanonical = new TextEncoder().encode(JSON.stringify(
      JSON.parse(new TextDecoder().decode(envelopeBytes)), null, 2,
    ));
    expect(verifyNativeRequesterSubmissionEnvelope({
      envelopeBytes: noncanonical,
      submissionBytes,
      requesterSubmission: identities.requesterSubmission,
    })).toBe(false);

    await expect(resolver({
      chainId: CHAIN.chainId,
      coordinator: CHAIN.taskCoordinator,
      taskId: result.association.taskId,
      taskDigest: result.association.taskDigest,
    })).resolves.toEqual(submissionBytes);
    await expect(resolver({
      chainId: CHAIN.chainId,
      coordinator: CHAIN.taskCoordinator,
      taskId: result.association.taskId + 1n,
      taskDigest: result.association.taskDigest,
    })).resolves.toBeUndefined();

    const impostor = generateKeyPairSync('ed25519');
    const badSignatureResolver = createNativeRequesterSubmissionResolver({
      stateDir,
      requesterSubmission: {
        keyId: identities.requesterSubmission.keyId,
        publicKey: impostor.publicKey,
      },
    });
    await expect(badSignatureResolver({
      chainId: CHAIN.chainId,
      coordinator: CHAIN.taskCoordinator,
      taskId: result.association.taskId,
      taskDigest: result.association.taskDigest,
    })).resolves.toBeUndefined();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('uses marketplace-binding native postTask through the production adapter without a live transaction', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-post-task-'));
    const { requester, post } = fixture({ stateDir });
    await requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'native-post-task-adapter',
    });
    const postInput = post.mock.calls[0]![0];
    const pinned: Uint8Array[] = [];
    const broadcast = vi.fn(async () => ({ taskId: 18n, txHash: `0x${'cd'.repeat(32)}` as const }));
    const intents = createInMemoryPostingIntentStore();
    const backend = makeMarketplaceBackend(CHAIN, {
      creatorSafe: CREATOR,
      terms: TERMS,
      posting: {
        ipfs: { pin: async (bytes) => { pinned.push(bytes); } },
        intents,
        safe: { broadcastCreateTask: broadcast },
      },
      observe: createInMemoryMarketplaceObserveStore(CHAIN, { intents }),
    });
    const nativePost = createNativeRequesterPostTask({
      terms: TERMS,
      backend,
    });

    expect(nativePost.terms).toEqual(TERMS);
    await expect(nativePost.post({
      ...postInput,
      terms: { ...TERMS, solutionMaxDeliveryRateWei: 4n },
    })).rejects.toThrow(/terms.*differ/u);
    expect(broadcast).not.toHaveBeenCalled();
    await expect(nativePost.post(postInput)).resolves.toEqual({ taskId: 18n, txHash: `0x${'cd'.repeat(32)}` });
    expect(pinned).toEqual([postInput.taskBytes, postInput.submissionBytes]);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      safeAddress: CREATOR,
      to: CHAIN.jinnRouter,
      value: 5n,
    }));
    await rm(stateDir, { recursive: true, force: true });
  });

  it('serves a signed well-known/head/archive source that a separate discovery client verifies', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-discovery-'));
    const identities = roles();
    const { requester } = fixture({ stateDir, loadRoles: async () => identities });
    const result = await requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'discovery-client-verifies',
    });
    const baseUrl = 'https://requester.test';
    const wellKnown = await requester.handleDiscoveryRequest(new Request(`${baseUrl}${WELL_KNOWN_PATH}`));
    expect(wellKnown.status).toBe(200);

    const transport = createHttpTransport(baseUrl, async (url, init) => requester.handleDiscoveryRequest(new Request(url, {
      method: init?.method ?? 'GET', headers: init?.headers ?? {},
    })));
    const endpoint = {
      agent: REQUESTER_AGENT,
      name: 'requester',
      servingRoot: baseUrl,
      archiveRootUrl: `${baseUrl}${archivePagePath('requester', result.association.publication.page)}`,
    };
    const head = await fetchHead(endpoint, transport);
    const synced: SyncedEntry[] = [];
    for await (const item of coldSync(endpoint, { transport })) synced.push(item);
    expect(synced).toHaveLength(1);
    if (head.signature === undefined || synced[0]?.signature === undefined) throw new Error('source was not signed');

    let mark: { sequence: string; entry: string; issuedAt: string } | undefined;
    const verifier = createVerifyDriver({
      trust: {
        keys: {
          resolve: async (agent: string) => agent === REQUESTER_AGENT ? [{
            keyid: identities.requesterDiscovery.keyId, publicKey: 'B2 requester discovery key', algorithm: 'Ed25519',
          }] : [],
          everBound: async (agent: string, keyId: string) => agent === REQUESTER_AGENT && keyId === identities.requesterDiscovery.keyId,
        },
        sigs: {
          verify: async (pae: Uint8Array, signature: Uint8Array) => cryptoVerify(
            null,
            pae,
            identities.requesterDiscovery.publicKey,
            signature,
          ),
        },
        fresh: { isFresh: (refreshBy: string, now: Date) => new Date(refreshBy).getTime() > now.getTime() },
      },
      hwm: { get: async () => mark, put: async (_source, next) => { mark = next; } },
      factsProfiles: { get: () => undefined },
      factsRecompute: { get: () => undefined },
      records: { fetch: async () => { throw new Error('record fetch is not part of source-chain verification'); } },
      entries: { fetch: async () => { throw new Error('entry fetch is not part of source-chain verification'); } },
      now: () => new Date('2026-08-02T12:00:01.000Z'),
    });
    await expect(verifier.verifySource({
      source: { agent: REQUESTER_AGENT, name: 'requester' },
      head: head.head,
      headSignature: head.signature,
      entries: (async function* () {
        for (const item of synced) yield { entry: item.entry, signature: item.signature! };
      })(),
      firstAdoption: true,
    })).resolves.toMatchObject({ status: 'ok' });
    expect(mark?.entry).toBe(result.association.publication.entryDigest);
    expect(synced[0]!.entry.announcements[0]!.facts?.[NATIVE_REQUESTER_ASSOCIATION_FACT]).toEqual({
      chainId: 84532,
      coordinator: CHAIN.taskCoordinator,
      creator: CREATOR,
      taskId: '17',
      taskDigest: result.association.taskDigest,
      txHash: TX_HASH,
      sealedAt: AUTHORITY_TIME.timestamp,
      authorityTime: AUTHORITY_TIME,
      submission: result.association.submissionUri,
      nonce: result.association.nonce,
      postingTerms: {
        solutionMaxDeliveryRateWei: '2',
        verdictMaxDeliveryRateWei: '3',
        responseTimeoutSeconds: '60',
        allowSolverSelfEvaluation: false,
      },
      intendedSpendWei: '5',
      admissionReceiptDigest: result.association.admissionReceiptDigest,
      requesterEnvelopeDigest: result.association.requesterEnvelopeDigest,
      runId: 'discovery-client-verifies',
    });
    await rm(stateDir, { recursive: true, force: true });
  });

  it('decodes a trust-gated requester announcement only when every exact Submission, posting-term, and canonical chain join matches', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-card-decoder-'));
    const identities = roles();
    const { requester, post } = fixture({ stateDir, loadRoles: async () => identities });
    const result = await requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'decode-exact-card',
    });
    const entry = result.association.publication.entry;
    const announcement = entry.announcements[0];
    if (announcement?.action !== 'available') throw new Error('expected available requester announcement');
    const headResponse = await requester.handleDiscoveryRequest(new Request(
      'https://requester.test/sources/requester/head',
    ));
    const headSignature = JSON.parse(await headResponse.text());
    const discovery = {
      source: entry.source,
      entry,
      entryDigest: sealJson(entry).digest,
      announcement,
      signedHighWater: {
        sequence: result.association.publication.head.sequence,
        entry: result.association.publication.head.entry,
        issuedAt: result.association.publication.head.issuedAt,
        refreshBy: result.association.publication.head.refreshBy,
        signature: headSignature,
      },
    } as const;
    const canonical = {
      canonical: true as const,
      chainId: CHAIN.chainId,
      coordinator: CHAIN.taskCoordinator,
      creator: CREATOR,
      taskId: 17n,
      taskDigest: result.association.taskDigest,
      txHash: TX_HASH,
      terms: TERMS,
      maxClaims: 1 as const,
    };
    const submissionBytes = post.mock.calls[0]![0].submissionBytes as Uint8Array;

    await expect(decodeNativeRequesterAnnouncement({ discovery, canonicalTaskCreated: canonical, submissionBytes }))
      .resolves.toMatchObject({
        record: { kind: announcement.record.kind, digest: result.association.submissionDigest },
        chain: {
          taskId: 17n,
          submission: result.association.submissionUri,
          nonce: result.association.nonce,
          intendedSpendWei: 5n,
        },
        derivationKind: 'chain',
        discovery: {
          source: entry.source,
          sequence: entry.sequence,
          entryDigest: result.association.publication.entryDigest,
        },
      });

    const withAssociation = (change: (association: Record<string, unknown>) => void) => {
      const changedEntry = structuredClone(entry);
      const changedAnnouncement = changedEntry.announcements[0] as AvailableAnnouncement;
      const facts = changedAnnouncement.facts as Record<string, unknown>;
      const association = facts[NATIVE_REQUESTER_ASSOCIATION_FACT] as Record<string, unknown>;
      change(association);
      return {
        ...discovery,
        entry: changedEntry,
        entryDigest: sealJson(changedEntry).digest,
        announcement: changedAnnouncement,
      };
    };
    const refusals = [
      withAssociation((value) => { value.taskId = '18'; }),
      withAssociation((value) => { value.coordinator = '0x2222222222222222222222222222222222222222'; }),
      withAssociation((value) => { value.taskDigest = `sha256:${'0'.repeat(64)}`; }),
      withAssociation((value) => { value.submission = 'urn:uuid:00000000-0000-4000-8000-000000000000'; }),
      withAssociation((value) => { value.nonce = 'different'; }),
      withAssociation((value) => { value.intendedSpendWei = '6'; }),
      withAssociation((value) => {
        (value.postingTerms as Record<string, unknown>).solutionMaxDeliveryRateWei = '3';
      }),
      withAssociation((value) => {
        (value.postingTerms as Record<string, unknown>).allowSolverSelfEvaluation = true;
      }),
    ];
    for (const refused of refusals) {
      await expect(decodeNativeRequesterAnnouncement({
        discovery: refused,
        canonicalTaskCreated: canonical,
        submissionBytes,
      })).rejects.toThrow(/native requester association refused/u);
    }

    for (const invalid of ['-1', '01', '1.0', '+1', `${1n << 256n}`]) {
      const malformed = withAssociation((value) => {
        (value.postingTerms as Record<string, unknown>).verdictMaxDeliveryRateWei = invalid;
      });
      await expect(decodeNativeRequesterAnnouncement({
        discovery: malformed, canonicalTaskCreated: canonical, submissionBytes,
      })).rejects.toThrow(/native requester association refused/u);
    }
    const unsafeEntry = structuredClone(entry);
    const unsafeAnnouncement = unsafeEntry.announcements[0] as AvailableAnnouncement;
    const unsafeAssociation = (unsafeAnnouncement.facts as Record<string, unknown>)[NATIVE_REQUESTER_ASSOCIATION_FACT] as Record<string, unknown>;
    (unsafeAssociation.postingTerms as Record<string, unknown>).responseTimeoutSeconds = Number.MAX_SAFE_INTEGER + 1;
    const unsafeNumber = { ...discovery, entry: unsafeEntry, announcement: unsafeAnnouncement };
    await expect(decodeNativeRequesterAnnouncement({
      discovery: unsafeNumber, canonicalTaskCreated: canonical, submissionBytes,
    })).rejects.toThrow(/native requester association refused/u);

    await expect(decodeNativeRequesterAnnouncement({
      discovery: { ...discovery, entryDigest: `sha256:${'f'.repeat(64)}` },
      canonicalTaskCreated: canonical,
      submissionBytes,
    })).rejects.toThrow(/native requester association refused/u);
    await expect(decodeNativeRequesterAnnouncement({
      discovery: {
        ...discovery,
        signedHighWater: {
          ...discovery.signedHighWater,
          signature: { ...headSignature, signatures: [] },
        },
      },
      canonicalTaskCreated: canonical,
      submissionBytes,
    })).rejects.toThrow(/native requester association refused/u);
    await expect(decodeNativeRequesterAnnouncement({
      discovery,
      canonicalTaskCreated: { ...canonical, canonical: false } as never,
      submissionBytes,
    })).rejects.toThrow(/native requester association refused/u);
    const tampered = submissionBytes.slice();
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! === 32 ? 33 : 32;
    await expect(decodeNativeRequesterAnnouncement({
      discovery, canonicalTaskCreated: canonical, submissionBytes: tampered,
    })).rejects.toThrow(/native requester association refused/u);

    await rm(stateDir, { recursive: true, force: true });
  });
});
