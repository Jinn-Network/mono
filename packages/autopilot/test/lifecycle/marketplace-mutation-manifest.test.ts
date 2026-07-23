import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AutopilotAdoptionReceiptSchema,
  type AutopilotAdoptionReceipt,
} from '../../../sdk/src/autopilot-session.js';
import {
  decodeAttemptManifest,
  readAttemptManifest,
  type AttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  recordMarketplaceMutationAdoptionReceipt,
} from '../../src/lifecycle/marketplace-mutation-manifest.js';

const CLAIM = '1'.repeat(40);
const EXPECTED = '2'.repeat(40);
const RESULTING = '3'.repeat(40);
const REVIEW_REF = '4'.repeat(40);
const ATTEMPT = '123e4567-e89b-42d3-a456-426614174000';
const GENERATION = '123e4567-e89b-42d3-a456-426614174001';
const REVIEW_ATTEMPT = '123e4567-e89b-42d3-a456-426614174002';
const CREATED = '2026-07-24T12:00:00.000Z';
const CREATION_TX = `0x${'b'.repeat(64)}`;
const directories: string[] = [];

const taskProvenance = {
  creationTransactionHash: CREATION_TX,
  creationBlockNumber: 812_345,
  solverNetManifestCid: 'bafybeisolvernetmanifest',
} as const;

function manifest(root: string): AttemptManifest {
  return decodeAttemptManifest({
    version: 2,
    attemptId: ATTEMPT,
    runnerId: 'runner-1',
    host: 'host-1',
    phase: 'implement',
    subject: 'issue-501',
    issueNumber: 501,
    prNumber: 2101,
    branch: 'autopilot/issue-501',
    targetBase: 'next',
    expectedHead: EXPECTED,
    claimOid: CLAIM,
    selectedLogin: 'jinn-autopilot',
    repository: {
      root,
      gitCommonDir: join(root, '.git'),
      remoteName: 'origin',
      remoteUrlHash: 'a'.repeat(64),
    },
    execution: {
      backend: 'marketplace',
      taskId: 'task-501',
      taskCid: 'bafybeitask',
      deadline: '2026-07-24T13:00:00.000Z',
      requestFile: join(root, 'request.json'),
      attemptIndex: 0,
      requestId: 'request-abc',
      deliveryTx: `0x${'a'.repeat(64)}`,
      deliveryEnvelopeCid: 'bafybeimutation',
    },
    processState: 'running',
    pid: null,
    paths: {
      attemptDir: root,
      worktree: join(root, 'worktree'),
      manifest: join(root, 'manifest.json'),
      log: join(root, 'session.log'),
      ghConfigDir: join(root, 'gh-config'),
      askpass: join(root, 'askpass.sh'),
      tokenFile: join(root, 'gh-token'),
    },
    timestamps: {
      createdAt: CREATED,
      updatedAt: CREATED,
      childStartedAt: CREATED,
    },
  });
}

function acceptedReceipt(): AutopilotAdoptionReceipt {
  return {
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
    disposition: 'accepted',
    role: 'solution',
    operation: 'implementation-complete',
    taskId: 'task-501',
    attemptIndex: 0,
    requestId: 'request-abc',
    deliveryEnvelopeCid: 'bafybeimutation',
    v2AttemptId: ATTEMPT,
    claimOid: CLAIM,
    prNumber: 2101,
    expectedHead: EXPECTED,
    resultingHead: RESULTING,
    reviewGeneration: GENERATION,
    reviewRefOid: REVIEW_REF,
    recordedAt: '2026-07-24T12:05:00.000Z',
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('marketplace mutation adoption manifest state', () => {
  it('keeps pre-adoption attempt manifests backward compatible', () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-adoption-manifest-'));
    directories.push(root);

    expect(manifest(root).execution).not.toHaveProperty('adoptionReceiptState');
  });

  it('decodes an additive exact receipt state', () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-adoption-manifest-'));
    directories.push(root);
    const current = manifest(root);

    const decoded = decodeAttemptManifest({
      ...current,
      execution: {
        ...current.execution,
        ...taskProvenance,
        adoptionReceipt: JSON.stringify(
          AutopilotAdoptionReceiptSchema.parse(acceptedReceipt()),
        ),
        adoptionReceiptState: {
          schemaVersion: 'jinn-autopilot-marketplace-adoption-state.v1',
          role: 'solution',
          taskId: 'task-501',
          attemptIndex: 0,
          requestId: 'request-abc',
          deliveryEnvelopeCid: 'bafybeimutation',
          disposition: 'accepted',
          commentId: 9001,
          resultingHead: RESULTING,
          reviewAttemptId: REVIEW_ATTEMPT,
          reviewManifestPath: join(root, 'review-manifest.json'),
          reviewGeneration: GENERATION,
          reviewRefOid: REVIEW_REF,
          ...taskProvenance,
          recordedAt: '2026-07-24T12:05:01.000Z',
        },
      },
    });

    expect(decoded.execution).toMatchObject({
      backend: 'marketplace',
      adoptionReceiptState: {
        disposition: 'accepted',
        commentId: 9001,
        resultingHead: RESULTING,
        reviewAttemptId: REVIEW_ATTEMPT,
        reviewManifestPath: join(root, 'review-manifest.json'),
        reviewGeneration: GENERATION,
        reviewRefOid: REVIEW_REF,
        ...taskProvenance,
      },
    });
  });

  it('persists the canonical receipt and exact state idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-adoption-manifest-'));
    directories.push(root);
    const initial = manifest(root);
    writeFileSync(initial.paths.manifest, `${JSON.stringify(initial, null, 2)}\n`, {
      mode: 0o600,
    });

    const first = recordMarketplaceMutationAdoptionReceipt({
      manifestPath: initial.paths.manifest,
      receipt: acceptedReceipt(),
      commentId: 9001,
      taskProvenance,
      reviewClaim: {
        attemptId: REVIEW_ATTEMPT,
        manifestPath: join(root, 'review-manifest.json'),
        head: RESULTING,
        generation: GENERATION,
        refOid: REVIEW_REF,
      },
      now: () => new Date('2026-07-24T12:05:01.000Z'),
    });
    const second = recordMarketplaceMutationAdoptionReceipt({
      manifestPath: initial.paths.manifest,
      receipt: acceptedReceipt(),
      commentId: 9001,
      taskProvenance,
      reviewClaim: {
        attemptId: REVIEW_ATTEMPT,
        manifestPath: join(root, 'review-manifest.json'),
        head: RESULTING,
        generation: GENERATION,
        refOid: REVIEW_REF,
      },
      now: () => new Date('2026-07-24T12:06:00.000Z'),
    });

    expect(second).toEqual(first);
    expect(readAttemptManifest(initial.paths.manifest)).toEqual(first);
    expect(JSON.parse(readFileSync(initial.paths.manifest, 'utf8'))).toMatchObject({
      execution: {
        ...taskProvenance,
        adoptionReceipt: JSON.stringify(
          AutopilotAdoptionReceiptSchema.parse(acceptedReceipt()),
        ),
        adoptionReceiptState: {
          disposition: 'accepted',
          commentId: 9001,
          ...taskProvenance,
        },
      },
    });
  });

  it('rejects a receipt that does not match the attempt delivery', () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-adoption-manifest-'));
    directories.push(root);
    const initial = manifest(root);
    writeFileSync(initial.paths.manifest, `${JSON.stringify(initial)}\n`, {
      mode: 0o600,
    });

    expect(() => recordMarketplaceMutationAdoptionReceipt({
      manifestPath: initial.paths.manifest,
      receipt: { ...acceptedReceipt(), requestId: 'wrong-request' },
      commentId: 9001,
      taskProvenance,
      reviewClaim: {
        attemptId: REVIEW_ATTEMPT,
        manifestPath: join(root, 'review-manifest.json'),
        head: RESULTING,
        generation: GENERATION,
        refOid: REVIEW_REF,
      },
    })).toThrow('Receipt does not match the marketplace attempt');
  });

  it('rejects a different durable receipt instead of overwriting it', () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-adoption-manifest-'));
    directories.push(root);
    const initial = manifest(root);
    writeFileSync(initial.paths.manifest, `${JSON.stringify(initial)}\n`, {
      mode: 0o600,
    });
    recordMarketplaceMutationAdoptionReceipt({
      manifestPath: initial.paths.manifest,
      receipt: acceptedReceipt(),
      commentId: 9001,
      taskProvenance,
      reviewClaim: {
        attemptId: REVIEW_ATTEMPT,
        manifestPath: join(root, 'review-manifest.json'),
        head: RESULTING,
        generation: GENERATION,
        refOid: REVIEW_REF,
      },
    });

    expect(() => recordMarketplaceMutationAdoptionReceipt({
      manifestPath: initial.paths.manifest,
      receipt: { ...acceptedReceipt(), recordedAt: '2026-07-24T12:07:00.000Z' },
      commentId: 9002,
      taskProvenance,
      reviewClaim: {
        attemptId: REVIEW_ATTEMPT,
        manifestPath: join(root, 'review-manifest.json'),
        head: RESULTING,
        generation: GENERATION,
        refOid: REVIEW_REF,
      },
    })).toThrow('Attempt manifest already records a different adoption receipt');
  });
});
