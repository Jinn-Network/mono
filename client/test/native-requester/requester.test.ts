import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDigest } from '@jinn-network/trust-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeRequester,
  type NativeRequesterRoles,
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

function roles(): NativeRequesterRoles {
  const byRole = new Map();
  for (const role of ['requester-submission', 'admission', 'requester-discovery'] as const) {
    const pair = generateKeyPairSync('ed25519');
    byRole.set(role, {
      keyId: `did:key:${role}`,
      sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, pair.privateKey)),
    });
  }
  return {
    get(role) {
      const identity = byRole.get(role);
      if (identity === undefined) throw new Error(`missing test role ${role}`);
      return identity;
    },
  };
}

function fixture(input: {
  readonly stateDir: string;
  readonly loadRoles?: () => Promise<NativeRequesterRoles>;
  readonly readChain?: () => Promise<typeof CHAIN>;
  readonly post?: ReturnType<typeof vi.fn>;
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
        recover: async () => null,
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
    expect(recordDigest(new Uint8Array(await record.arrayBuffer()))).toBe(result.association.submissionDigest);

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
});
