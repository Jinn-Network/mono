import { describe, expect, it, vi } from 'vitest';
import { keccak256, toBytes } from 'viem';
import {
  manifestDigestForCid,
  queryClaimableTaskCandidates,
} from '../../../src/adapters/mech/task-subgraph.js';

const OPERATOR = '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC';
const TASK_DIGEST = `0x${'11'.repeat(32)}` as const;
const MANIFEST_CID = 'bafyfixturecid';

function mockFetch(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  });
}

describe('task subgraph discovery', () => {
  it('derives the same manifest digest used by task posting', () => {
    expect(manifestDigestForCid(MANIFEST_CID)).toBe(keccak256(toBytes(MANIFEST_CID)));
  });

  it('queries active tasks and filters rows this operator already attempted', async () => {
    const fetchImpl = mockFetch({
      data: {
        tasks: [
          {
            id: '15',
            taskId: '15',
            taskCidDigest: TASK_DIGEST,
            manifestDigest: manifestDigestForCid(MANIFEST_CID),
            maxClaims: 50,
            claimWindowEnd: '1778843131',
            createdAtBlock: '41200001',
            createdAtTx: `0x${'22'.repeat(32)}`,
            attempts: [],
            operatorAttempts: [],
          },
          {
            id: '16',
            taskId: '16',
            taskCidDigest: `0x${'33'.repeat(32)}`,
            manifestDigest: manifestDigestForCid(MANIFEST_CID),
            maxClaims: 50,
            attempts: [{ id: '16-0' }],
            operatorAttempts: [{ id: '16-0' }],
          },
        ],
      },
    });

    const candidates = await queryClaimableTaskCandidates({
      url: 'https://subgraph.example/graphql',
      solverNetManifestCids: [MANIFEST_CID],
      operatorAddress: OPERATOR,
      nowSeconds: 1_778_000_000,
      fetchImpl,
    });

    expect(candidates).toEqual([{
      taskId: '15',
      taskCidDigest: TASK_DIGEST,
      manifestDigest: manifestDigestForCid(MANIFEST_CID),
      createdAtBlock: 41200001,
      createdAtTx: `0x${'22'.repeat(32)}`,
      claimWindowEnd: 1778843131,
      maxClaims: 50,
      attemptCount: 0,
      operatorAttemptCount: 0,
    }]);

    const request = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as {
      variables: Record<string, unknown>;
    };
    expect(request.variables).toMatchObject({
      manifestDigest: manifestDigestForCid(MANIFEST_CID).toLowerCase(),
      operator: OPERATOR.toLowerCase(),
      first: 100,
      skip: 0,
      now: '1778000000',
    });
  });

  it('drops maxed-out and malformed rows from the candidate list', async () => {
    const fetchImpl = mockFetch({
      data: {
        tasks: [
          {
            id: '20',
            taskId: '20',
            taskCidDigest: `0x${'44'.repeat(32)}`,
            manifestDigest: manifestDigestForCid(MANIFEST_CID),
            maxClaims: 1,
            attempts: [{ id: '20-0' }],
            operatorAttempts: [],
          },
          {
            id: '21',
            taskId: '21',
            taskCidDigest: '0x1234',
            manifestDigest: manifestDigestForCid(MANIFEST_CID),
            maxClaims: 50,
            attempts: [],
            operatorAttempts: [],
          },
        ],
      },
    });

    await expect(queryClaimableTaskCandidates({
      url: 'https://subgraph.example/graphql',
      solverNetManifestCids: [MANIFEST_CID],
      operatorAddress: OPERATOR,
      fetchImpl,
    })).resolves.toEqual([]);
  });
});
