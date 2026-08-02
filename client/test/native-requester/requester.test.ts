import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DSSE_ENVELOPE_MEDIA_TYPE,
  dssePreAuthEncoding,
  recordDigest,
  sealDsseEnvelope,
} from '@jinn-network/trust-core';
import {
  SUBMISSION_MEDIA_TYPE,
  TASK_MEDIA_TYPE,
} from '@jinn-network/task-execution-protocol';
import { EVALUATION_SPEC_MEDIA_TYPE } from '@jinn-network/task-execution-profiles';
import { archivePagePath, WELL_KNOWN_PATH } from '@jinn-network/record-discovery-protocol';
import { coldSync, createVerifyDriver, fetchHead, type SyncedEntry } from '@jinn-network/record-discovery-client';
import { createHttpTransport } from '@jinn-network/record-discovery-transport-http';
import { createInMemoryPostingIntentStore } from '@jinn-network/marketplace-binding';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeRequester,
  createNativeRequesterPostTask,
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
const REQUESTER_AGENT = 'urn:jinn:requester:test';

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
  readonly checkpoints?: (name: string) => Promise<void>;
}) {
  const post = input.post ?? vi.fn(async () => ({ taskId: 17n, txHash: TX_HASH }));
  const readChain = input.readChain ?? vi.fn(async () => CHAIN);
  const loadRoles = input.loadRoles ?? vi.fn(async () => roles());
  return {
    requester: createNativeRequester({
      stateDir: input.stateDir,
      requesterAgent: REQUESTER_AGENT,
      publicBaseUrl: 'https://requester.test',
      readChain,
      loadRoles,
      creatorSafe: CREATOR,
      posting: {
        post,
        recover: input.recover ?? (async () => null),
        canonicalTaskCreated: async (expected) => ({
          canonical: true as const,
          chainId: expected.chainId,
          coordinator: expected.coordinator,
          creator: expected.creator,
          taskId: expected.taskId,
          taskDigest: expected.taskDigest,
          txHash: expected.txHash,
        }),
      },
      now: () => new Date('2026-08-02T12:00:00.000Z'),
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
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'run-1',
    })).rejects.toThrow(/Base Sepolia.*84532|mainnet/i);
    expect(loadRoles).not.toHaveBeenCalled();
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
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'run-one',
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
      'source-announced',
    ]);
    expect(post).toHaveBeenCalledOnce();
    const postInput = post.mock.calls[0]![0];
    expect(recordDigest(postInput.taskBytes)).toBe(
      'sha256:40ae3efd61b75951ad68a868fdd020de931e3d27eb1b448f341997bf4917a598',
    );
    expect(recordDigest(postInput.evaluationSpecBytes)).toBe(
      'sha256:4e9b938d24e7752630f0fb27c2295781a7b5ecfcb130daa28d320bbedd96e962',
    );
    expect(result.association.taskId).toBe(17n);
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
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'recover-me',
    })).rejects.toThrow(/simulated process death/i);
    expect(post).toHaveBeenCalledOnce();

    const restarted = fixture({ stateDir, post }).requester;
    const recovered = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'recover-me',
    });
    const replayed = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'recover-me',
    });

    expect(post).toHaveBeenCalledOnce();
    expect(replayed.association).toEqual(recovered.association);
    await rm(stateDir, { recursive: true, force: true });
  });

  it('recovers wallet-return uncertainty before any rebroadcast and announces the same sealed bundle once', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-native-requester-wallet-uncertain-'));
    const identities = roles();
    let invoked = false;
    const post = vi.fn(async () => {
      invoked = true;
      throw new Error('wallet result lost after invocation');
    });
    const recover = vi.fn(async () => invoked ? ({ taskId: 17n, txHash: TX_HASH }) : null);
    const first = fixture({
      stateDir,
      post,
      recover,
      loadRoles: async () => identities,
    }).requester;

    await expect(first.request({
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'wallet-uncertain',
    })).rejects.toThrow(/wallet result lost/u);
    const restarted = fixture({
      stateDir,
      post,
      recover,
      loadRoles: async () => identities,
    }).requester;
    const recovered = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'wallet-uncertain',
    });
    const replay = await restarted.request({
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'wallet-uncertain',
    });

    expect(post).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(recovered.reused).toBe(true);
    expect(replay.association).toEqual(recovered.association);
    expect(recovered.association.publication).toMatchObject({
      state: 'published',
      sequence: '0000000000000001',
    });
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
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'trusted-association',
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
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'native-post-task-adapter',
    });
    const postInput = post.mock.calls[0]![0];
    const pinned: Uint8Array[] = [];
    const broadcast = vi.fn(async () => ({ taskId: 18n, txHash: `0x${'cd'.repeat(32)}` as const }));
    const nativePost = createNativeRequesterPostTask({
      terms: {
        solutionMaxDeliveryRateWei: 2n,
        verdictMaxDeliveryRateWei: 3n,
        responseTimeoutSeconds: 60n,
        allowSolverSelfEvaluation: false,
      },
      ports: {
        ipfs: { pin: async (bytes) => { pinned.push(bytes); } },
        intents: createInMemoryPostingIntentStore(),
        safe: { broadcastCreateTask: broadcast },
      },
    });

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
      network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: 'discovery-client-verifies',
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
    await rm(stateDir, { recursive: true, force: true });
  });
});
