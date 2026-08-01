import { describe, expect, it } from 'vitest';
import {
  documentDigest,
  sealSubmission,
  sealTask,
} from '@jinn-network/task-execution-protocol';
import {
  buildRepositoryWorkProfile,
  REPOSITORY_WORK_PROFILE_URI,
  sealTaskProfile,
} from '@jinn-network/task-execution-profiles';
import type { SignedTaskV1 } from '../../src/types/task-document.js';
import { synthesizeLegacyExecutionDocuments } from '../../src/daemon/bridge-legacy-delivery.js';

const CREATOR = '0x5555555555555555555555555555555555555555' as const;
const DEADLINE_TS = Math.floor(Date.parse('2099-01-01T00:00:00Z') / 1000);

function legacySignedTaskV1(overrides: Partial<SignedTaskV1> = {}): SignedTaskV1 {
  return {
    schemaVersion: 'task.v1',
    id: 'legacy-task-1',
    solverType: 'prediction.v1',
    solverNetManifestCid: 'bafySolverNetManifest',
    contractId: 'prediction',
    contractVersion: 'v1',
    role: 'restoration',
    description: 'Predict the market outcome from the posted consensus snapshot.',
    window: { startTs: DEADLINE_TS - 3600, endTs: DEADLINE_TS },
    spec: {
      consensusSnapshot: {
        sampledAt: '2098-12-31T23:00:00.000Z',
        probabilityYes: '0.75',
        method: 'best-bid-ask-midpoint',
        source: 'polymarket-clob',
      },
      source: {
        type: 'prediction-market',
        venue: 'polymarket',
        url: 'https://polymarket.com/event/fixture',
      },
    },
    eligibility: {},
    claimPolicy: { maxClaims: 2 },
    creator: { safeAddress: CREATOR, agentEoa: CREATOR },
    createdAt: DEADLINE_TS - 3600,
    signature: {
      algo: 'secp256k1',
      signer: CREATOR,
      hash: `0x${'a'.repeat(64)}`,
      sig: `0x${'b'.repeat(130)}`,
    },
    ...overrides,
  };
}

describe('synthesizeLegacyExecutionDocuments (E41 bridge-era execution documents)', () => {
  const sealedProfile = sealTaskProfile(buildRepositoryWorkProfile());
  const profile = { uri: REPOSITORY_WORK_PROFILE_URI, digest: sealedProfile.digest };

  it('produces sealed TEP bytes that re-seal identically', () => {
    const signed = legacySignedTaskV1();
    const signedBytes = new TextEncoder().encode(JSON.stringify(signed));
    const submissionUri = 'urn:uuid:11111111-2222-3333-4444-555555555555' as const;

    const { taskBytes, submissionBytes } = synthesizeLegacyExecutionDocuments({
      task: signed,
      taskBytes: signedBytes,
      submissionUri,
      nonce: `0x${'c'.repeat(64)}`,
      profile,
    });

    const reparsedTask = JSON.parse(new TextDecoder().decode(taskBytes));
    const reparsedSubmission = JSON.parse(new TextDecoder().decode(submissionBytes));
    expect(sealTask(reparsedTask)).toEqual(taskBytes);
    expect(sealSubmission(reparsedSubmission)).toEqual(submissionBytes);
  });

  it('embeds the exact SignedTaskV1 JSON as a task input artifact for prediction-v1-baseline', () => {
    const signed = legacySignedTaskV1();
    const signedBytes = new TextEncoder().encode(JSON.stringify(signed));

    const { taskBytes } = synthesizeLegacyExecutionDocuments({
      task: signed,
      taskBytes: signedBytes,
      submissionUri: 'urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
      nonce: 'nonce-1',
      profile,
    });

    const task = JSON.parse(new TextDecoder().decode(taskBytes));
    expect(task.inputs).toHaveLength(1);
    const input = task.inputs[0];
    expect(input.name).toBe('legacy-signed-task-v1.json');
    const embedded = JSON.parse(Buffer.from(input.content, 'base64').toString('utf8'));
    expect(embedded).toEqual(signed);
    expect(input.digest.sha256).toBe(documentDigest(signedBytes).slice('sha256:'.length));
  });

  it('diverges from the legacy SignedTaskV1 digest (expected and pinned)', () => {
    const signed = legacySignedTaskV1();
    const signedBytes = new TextEncoder().encode(JSON.stringify(signed));

    const { taskBytes } = synthesizeLegacyExecutionDocuments({
      task: signed,
      taskBytes: signedBytes,
      submissionUri: 'urn:uuid:bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb',
      nonce: 'nonce-2',
      profile,
    });

    expect(documentDigest(taskBytes)).not.toBe(documentDigest(signedBytes));
  });

  it('binds the submission to the synthesized task digest and reuses the card nonce', () => {
    const signed = legacySignedTaskV1();
    const signedBytes = new TextEncoder().encode(JSON.stringify(signed));
    const submissionUri = 'urn:uuid:cccccccc-cccc-5ccc-8ccc-cccccccccccc' as const;
    const nonce = `0x${'d'.repeat(64)}`;

    const { taskBytes, submissionBytes } = synthesizeLegacyExecutionDocuments({
      task: signed,
      taskBytes: signedBytes,
      submissionUri,
      nonce,
      profile,
    });

    const submission = JSON.parse(new TextDecoder().decode(submissionBytes));
    expect(submission.submission).toBe(submissionUri);
    expect(submission.nonce).toBe(nonce);
    expect(submission.task.digest.sha256).toBe(documentDigest(taskBytes).slice('sha256:'.length));
  });

  it('accepts the daemon-harness e2e SignedTaskV1 window shape (millisecond timestamps)', () => {
    const now = Date.now();
    const signed = legacySignedTaskV1({
      id: 'daemon-harness-e2e-task-4',
      window: { startTs: now - 5_000, endTs: now + 600_000 },
      spec: {
        consensusSnapshot: {
          sampledAt: new Date(now - 10_000).toISOString(),
          probabilityYes: '0.75',
          method: 'best-bid-ask-midpoint',
          source: 'polymarket-clob',
        },
      },
      claimPolicy: {
        mode: 'parallel',
        maxClaims: 10,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
        claimWindowStartTs: Math.floor(now / 1000) - 5,
        claimWindowEndTs: Math.floor(now / 1000) + 300,
        submissionDeadlineTs: Math.floor(now / 1000) + 900,
      },
      createdAt: now,
    });
    const signedBytes = new TextEncoder().encode(JSON.stringify(signed));

    let thrown: unknown;
    try {
      synthesizeLegacyExecutionDocuments({
        task: signed,
        taskBytes: signedBytes,
        submissionUri: 'urn:uuid:cf05af68-1c77-137b-6c7e-155cc5bfa9b8',
        nonce: '0xcf05af681c77137b6c7e155cc5bfa9b8489490f4fb78f36d3ad9e9e07b49f160',
        profile,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
  });
});
