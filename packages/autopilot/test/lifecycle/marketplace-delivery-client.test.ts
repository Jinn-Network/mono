import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceAttemptReviewPair,
  decodeAttemptManifest,
  readAttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  observeMarketplaceSolutionDelivery,
  observeMarketplaceVerdictDelivery,
} from '../../src/lifecycle/marketplace-delivery-client.js';
import {
  linkMarketplaceReviewAttemptToOriginTask,
  recordMarketplaceMutationAdoptionReceipt,
  recordMarketplaceSolutionDelivery,
} from '../../src/lifecycle/marketplace-mutation-manifest.js';

const directories: string[] = [];
const CREATION_TX = `0x${'a'.repeat(64)}`;
const SOLUTION_REQUEST_ID = `0x${'1'.repeat(64)}`;
const SOLUTION_ENVELOPE_CID = 'bafy-envelope-solution';
const SOLUTION_DELIVERY_TX = `0x${'d'.repeat(64)}`;
const VERDICT_REQUEST_ID = `0x${'2'.repeat(64)}`;
const VERDICT_ENVELOPE_CID = 'bafy-envelope-verdict';
const VERDICT_DELIVERY_TX = `0x${'cd'.repeat(32)}`;

function sdkFixture(name: string): unknown {
  return JSON.parse(readFileSync(
    join(
      import.meta.dirname,
      '../../../sdk/fixtures/autopilot',
      `${name}.json`,
    ),
    'utf8',
  ));
}

function observationResult(
  observation: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-24T12:05:00.000Z',
    verb: 'tasks observe-autopilot-delivery',
    observation,
    ...overrides,
  };
}

function attempt() {
  const root = mkdtempSync(join(tmpdir(), 'jinn-marketplace-observer-'));
  directories.push(root);
  const request = sdkFixture('submit-request') as {
    spec: { session: unknown };
  };
  const session = request.spec.session;
  const requestFile = join(root, 'marketplace-request.json');
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`, {
    mode: 0o600,
  });
  const manifest = decodeAttemptManifest({
    version: 2,
    attemptId: '123e4567-e89b-42d3-a456-426614174001',
    runnerId: 'runner-1',
    host: 'host-1',
    phase: 'implement',
    subject: 'issue-2001',
    issueNumber: 2001,
    prNumber: 2101,
    branch: 'codex/issue-2001',
    targetBase: 'next',
    expectedHead: '2'.repeat(40),
    claimOid: '1'.repeat(40),
    selectedLogin: 'jinn-autopilot',
    repository: {
      root,
      gitCommonDir: join(root, '.git'),
      remoteName: 'origin',
      remoteUrlHash: 'c'.repeat(64),
    },
    execution: {
      backend: 'marketplace',
      taskId: '501',
      taskCid: 'bafy-task',
      deadline: '2026-07-24T14:00:00.000Z',
      requestFile,
      creationTransactionHash: CREATION_TX,
      creationBlockNumber: 100,
      solverNetManifestCid: 'bafy-solvernet',
    },
    processState: 'running',
    pid: null,
    paths: {
      attemptDir: root,
      worktree: join(root, 'worktree'),
      manifest: manifestPath,
      log: join(root, 'session.log'),
      ghConfigDir: join(root, 'gh-config'),
      askpass: join(root, 'askpass.sh'),
      tokenFile: join(root, 'gh-token'),
    },
    timestamps: {
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
      childStartedAt: '2026-07-24T12:00:00.000Z',
    },
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { root, manifest, session };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Autopilot marketplace delivery client', () => {
  it('invokes exact observation and durably records verified Solution provenance', async () => {
    const fixture = attempt();
    const runner = vi.fn(async () => JSON.stringify(observationResult(
      sdkFixture('verified-solution'),
    )));

    const result = await observeMarketplaceSolutionDelivery(
      fixture.manifest.paths.manifest,
      {
        runner,
        environment: { JINN_CONFIG: '/operator/config.json' },
        now: () => new Date('2026-07-24T12:05:00.000Z'),
      },
    );

    expect(result).toMatchObject({
      status: 'verified',
      reference: {
        taskId: '501',
        attemptIndex: 0,
        requestId: SOLUTION_REQUEST_ID,
        deliveryEnvelopeCid: SOLUTION_ENVELOPE_CID,
      },
      delivery: {
        operator: {
          id: '42',
          address: `0x${'1'.repeat(40)}`,
        },
      },
    });
    expect(runner).toHaveBeenCalledWith('jinn', [
      'tasks',
      'observe-autopilot-delivery',
      '--expectation-file',
      join(fixture.root, 'marketplace-solution-observation.json'),
      '--json',
    ], {
      env: { JINN_CONFIG: '/operator/config.json' },
      replaceEnv: true,
    });
    expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
      .toMatchObject({
        backend: 'marketplace',
        attemptIndex: 0,
        requestId: SOLUTION_REQUEST_ID,
        deliveryTx: SOLUTION_DELIVERY_TX,
        deliveryBlockNumber: 102,
        deliveryEnvelopeCid: SOLUTION_ENVELOPE_CID,
      });
  });

  it('observes the evaluator Verdict from the originating Task and persists exact review delivery', async () => {
    const fixture = attempt();
    recordMarketplaceSolutionDelivery({
      manifestPath: fixture.manifest.paths.manifest,
      taskId: '501',
      taskCid: 'bafy-task',
      attemptIndex: 0,
      requestId: SOLUTION_REQUEST_ID,
      deliveryEnvelopeCid: SOLUTION_ENVELOPE_CID,
      deliveryTransactionHash: SOLUTION_DELIVERY_TX,
      deliveryBlockNumber: 102,
      solutionOperatorAddress: `0x${'1'.repeat(40)}`,
      solutionPublisherAgentId: '42',
      taskProvenance: {
        creationTransactionHash: CREATION_TX,
        creationBlockNumber: 100,
        solverNetManifestCid: 'bafy-solvernet',
      },
    });
    const reviewRoot = join(fixture.root, 'review');
    mkdirSync(reviewRoot, { recursive: true });
    const reviewManifestPath = join(reviewRoot, 'manifest.json');
    const review = decodeAttemptManifest({
      version: 2,
      attemptId: '123e4567-e89b-42d3-a456-426614174020',
      runnerId: 'runner-1',
      host: 'host-1',
      phase: 'review',
      subject: 'pr-2101',
      issueNumber: 2001,
      prNumber: 2101,
      branch: 'codex/issue-2001',
      targetBase: 'next',
      expectedHead: '4'.repeat(40),
      claimOid: '5'.repeat(40),
      reviewGeneration: '123e4567-e89b-42d3-a456-426614174010',
      reviewRefOid: '5'.repeat(40),
      reviewApprovalPolicy: 'approve-eligible',
      selectedLogin: 'review-bot',
      repository: fixture.manifest.repository,
      execution: { backend: 'marketplace' },
      processState: 'preparing',
      pid: null,
      paths: {
        attemptDir: reviewRoot,
        worktree: join(reviewRoot, 'worktree'),
        manifest: reviewManifestPath,
        log: join(reviewRoot, 'session.log'),
        ghConfigDir: join(reviewRoot, 'gh-config'),
        askpass: join(reviewRoot, 'askpass.sh'),
        tokenFile: join(reviewRoot, 'gh-token'),
      },
      timestamps: {
        createdAt: '2026-07-24T12:10:00.000Z',
        updatedAt: '2026-07-24T12:10:00.000Z',
      },
    });
    writeFileSync(reviewManifestPath, `${JSON.stringify(review, null, 2)}\n`, {
      mode: 0o600,
    });
    linkMarketplaceReviewAttemptToOriginTask({
      originManifestPath: fixture.manifest.paths.manifest,
      reviewManifestPath,
      reviewAttemptId: review.attemptId,
      expectedHead: review.expectedHead,
      reviewGeneration: review.reviewGeneration!,
      reviewRefOid: review.reviewRefOid!,
    });
    const acceptedSolutionReceipt = sdkFixture(
      'receipt-solution-accepted',
    ) as Record<string, unknown>;
    recordMarketplaceMutationAdoptionReceipt({
      manifestPath: fixture.manifest.paths.manifest,
      receipt: {
        ...acceptedSolutionReceipt,
        requestId: SOLUTION_REQUEST_ID,
        deliveryEnvelopeCid: SOLUTION_ENVELOPE_CID,
      } as never,
      commentId: 91,
      taskProvenance: {
        creationTransactionHash: CREATION_TX,
        creationBlockNumber: 100,
        solverNetManifestCid: 'bafy-solvernet',
      },
      reviewClaim: {
        attemptId: review.attemptId,
        manifestPath: reviewManifestPath,
        head: review.expectedHead,
        generation: review.reviewGeneration!,
        refOid: review.reviewRefOid!,
      },
    });
    const advancedReviewRef = '6'.repeat(40);
    advanceAttemptReviewPair(
      reviewManifestPath,
      review.expectedHead,
      review.reviewRefOid!,
      review.expectedHead,
      advancedReviewRef,
    );
    const runner = vi.fn(async () => JSON.stringify(observationResult(
      sdkFixture('verified-verdict'),
    )));

    const result = await observeMarketplaceVerdictDelivery(
      fixture.manifest.paths.manifest,
      reviewManifestPath,
      { runner },
    );

    expect(result).toMatchObject({
      status: 'verified',
      delivery: {
        origin: { manifestPath: fixture.manifest.paths.manifest },
        review: {
          manifestPath: reviewManifestPath,
          head: '4'.repeat(40),
          refOid: review.reviewRefOid,
        },
        solutionOperator: `0x${'1'.repeat(40)}`,
        evaluator: {
          publisherAgentId: '43',
          address: `0x${'3'.repeat(40)}`,
        },
      },
    });
    const request = JSON.parse(readFileSync(
      join(reviewRoot, 'marketplace-verdict-observation.json'),
      'utf8',
    ));
    expect(request).toMatchObject({
      role: 'verdict',
      taskId: '501',
      solutionOperator: `0x${'1'.repeat(40)}`,
      expectedCorrelation: {
        resultingHead: '4'.repeat(40),
        reviewedHead: '4'.repeat(40),
        reviewGeneration: review.reviewGeneration,
        reviewRefOid: review.reviewRefOid,
      },
    });
    expect(readAttemptManifest(reviewManifestPath).reviewRefOid)
      .toBe(advancedReviewRef);
    expect(readAttemptManifest(reviewManifestPath).execution).toMatchObject({
      attemptIndex: 1,
      requestId: VERDICT_REQUEST_ID,
      deliveryEnvelopeCid: VERDICT_ENVELOPE_CID,
      deliveryTx: VERDICT_DELIVERY_TX,
      deliveryBlockNumber: 112,
    });
  });

  it('keeps pending observations recoverable without changing delivery state', async () => {
    const fixture = attempt();
    await expect(observeMarketplaceSolutionDelivery(
      fixture.manifest.paths.manifest,
      {
        runner: async () => JSON.stringify(observationResult(
          sdkFixture('delivery-pending'),
        )),
      },
    )).resolves.toEqual({
      status: 'pending',
      reason: 'envelope-not-indexed',
      detail: 'The exact envelope row has not reached the indexer.',
    });
    expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
      .not.toHaveProperty('attemptIndex');
  });

  it('rejects an observation response outside the published SDK wrapper contract', async () => {
    const fixture = attempt();
    await expect(observeMarketplaceSolutionDelivery(
      fixture.manifest.paths.manifest,
      {
        runner: async () => JSON.stringify(observationResult(
          sdkFixture('delivery-pending'),
          { unexpected: 'not-in-the-machine-contract' },
        )),
      },
    )).rejects.toThrow();
  });

  it('fails closed when verified Task creation provenance contradicts the manifest', async () => {
    const fixture = attempt();
    const observation =
      sdkFixture('verified-solution') as Record<string, any>;
    await expect(observeMarketplaceSolutionDelivery(
      fixture.manifest.paths.manifest,
      {
        runner: async () => JSON.stringify(observationResult({
          ...observation,
          task: {
            ...observation.task,
            createdAtTx: `0x${'f'.repeat(64)}`,
          },
        })),
      },
    )).rejects.toThrow('contradicts');
  });
});
