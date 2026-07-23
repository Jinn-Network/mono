import { describe, expect, it } from 'vitest';
import type {
  AutopilotAdoptionReceipt,
  AutopilotMutationResult,
  AutopilotSessionCapsule,
} from '../../../sdk/src/autopilot-session.js';
import {
  formatAdoptionReceiptComment,
  parseAdoptionReceiptComment,
  type AdoptionReceiptComment,
  type AdoptionReceiptPorts,
  type CreateAdoptionReceiptCommentInput,
} from '../../src/lifecycle/marketplace-adoption-receipt.js';
import {
  makeMarketplaceMutationAdoptionCoordinator,
  type ConfirmedMarketplaceReviewClaim,
  type MarketplaceMutationAdoptionBoundary,
  type MarketplaceMutationAdoptionCoordinator,
  type MarketplaceMutationAuthority,
  type MarketplaceMutationAuthorityPort,
  type MarketplaceMutationDeliveryReference,
  type MarketplaceMutationManifestReceiptPort,
  type MarketplaceReviewClaimPort,
  type VerifiedMarketplaceSolutionDelivery,
  type VerifiedMarketplaceSolutionDeliveryPort,
} from '../../src/lifecycle/marketplace-mutation-adoption.js';
import type {
  AttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';
import type {
  ImplementationSessionProtocol,
} from '../../src/lifecycle/implementation-session.js';
import {
  MarketplacePatchCheckError,
  type ValidatedMarketplacePatch,
} from '../../src/lifecycle/marketplace-patch.js';
import type {
  MarketplaceMutationCommitIdentity,
  MarketplaceMutationGitPort,
  MarketplaceMutationGitState,
} from '../../src/lifecycle/marketplace-mutation-git.js';
import {
  MarketplaceVerificationPlanError,
  type MarketplaceMutationVerificationPort,
  type MarketplaceMutationVerificationResult,
} from '../../src/lifecycle/marketplace-mutation-verification.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
  type GitOid,
} from '../../src/lifecycle/types.js';

const CLAIM = gitOid('1'.repeat(40));
const EXPECTED = gitOid('2'.repeat(40));
const HOST_COMMIT = gitOid('3'.repeat(40));
const HOST_TREE = gitOid('4'.repeat(40));
const COMPLETION = gitOid('5'.repeat(40));
const REVIEW_REF = gitOid('6'.repeat(40));
const STALE = gitOid('9'.repeat(40));
const ATTEMPT = '123e4567-e89b-42d3-a456-426614174000';
const REVIEW_ATTEMPT = '123e4567-e89b-42d3-a456-426614174001';
const GENERATION = '123e4567-e89b-42d3-a456-426614174002';
const NOW = '2026-07-24T12:00:00.000Z';
const WORKTREE = '/trusted/attempt/worktree';
const MANIFEST = '/trusted/attempt/manifest.json';
const PATCH = [
  'diff --git a/value.txt b/value.txt',
  'index 1111111..2222222 100644',
  '--- a/value.txt',
  '+++ b/value.txt',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  '',
].join('\n');

type MutationWorkflow =
  | 'implement'
  | 'fix-child'
  | 'reconcile'
  | 'ci-failure';

function workflowContract(workflow: MutationWorkflow) {
  return {
    skill: workflow === 'implement'
      ? 'implement-issue'
      : workflow === 'reconcile'
        ? 'reconcile'
        : 'fix-child',
    version: 'v2',
    resultSchema: 'jinn-autopilot-mutation-result.v1',
  } as const;
}

function session(workflow: MutationWorkflow): AutopilotSessionCapsule {
  return {
    schemaVersion: 'jinn-autopilot-session.v1',
    workflow,
    repository: 'Jinn-Network/mono',
    issueNumber: 501,
    ...(workflow === 'implement'
      ? {}
      : { childIssueNumber: 701, parentPrNumber: 2101 }),
    prNumber: 2101,
    targetBase: 'next',
    branch: 'autopilot/issue-501',
    claimOid: CLAIM,
    expectedHead: EXPECTED,
    v2AttemptId: ATTEMPT,
    runnerId: 'runner-1',
    taskSnapshot: {
      title: 'Change the value',
      body: 'Update value.txt.',
      prBody:
        '<!-- jinn-autopilot:v2 issue=501 branch=autopilot/issue-501 -->',
      baseSha: gitOid('a'.repeat(40)),
    },
    deadline: '2026-07-24T13:00:00.000Z',
    receiptAuthors: ['jinn-autopilot'],
    workflowContract: workflowContract(workflow),
  } as AutopilotSessionCapsule;
}

function correlation() {
  return {
    taskId: 'task-501',
    attemptIndex: 0,
    requestId: 'request-abc',
    deliveryEnvelopeCid: 'bafybeimutation',
    v2AttemptId: ATTEMPT,
    claimOid: CLAIM,
    prNumber: 2101,
    expectedHead: EXPECTED,
  } as const;
}

function mutationResult(
  outcome: 'mutation-complete' | 'human' = 'mutation-complete',
): AutopilotMutationResult {
  if (outcome === 'human') {
    return {
      schemaVersion: 'jinn-autopilot-mutation-result.v1',
      outcome,
      correlation: correlation(),
      reason: {
        code: 'semantic-conflict',
        detail: 'The requested change needs Human judgment.',
      },
    };
  }
  return {
    schemaVersion: 'jinn-autopilot-mutation-result.v1',
    outcome,
    correlation: correlation(),
    patch: PATCH,
    summary: 'Adopt the verified marketplace mutation.',
    evidence: {
      commands: ['git diff --check'],
      tests: ['focused tests passed'],
    },
  };
}

function manifest(workflow: MutationWorkflow): AttemptManifest {
  const child = workflow !== 'implement';
  return {
    version: 2,
    attemptId: ATTEMPT,
    runnerId: 'runner-1',
    host: 'host-1',
    phase: 'implement',
    subject: `issue-${child ? 701 : 501}`,
    issueNumber: child ? 701 : 501,
    prNumber: 2101,
    branch: 'autopilot/issue-501',
    targetBase: 'next',
    expectedHead: EXPECTED,
    claimOid: CLAIM,
    selectedLogin: 'jinn-autopilot',
    repository: {
      root: '/trusted/repository',
      gitCommonDir: '/trusted/repository/.git',
      remoteName: 'origin',
      remoteUrlHash: 'a'.repeat(64),
    },
    execution: {
      backend: 'marketplace',
      taskId: 'task-501',
      taskCid: 'bafybeitask',
      deadline: '2026-07-24T13:00:00.000Z',
      requestFile: '/trusted/attempt/request.json',
      attemptIndex: 0,
      requestId: 'request-abc',
      deliveryTx: `0x${'a'.repeat(64)}`,
      deliveryEnvelopeCid: 'bafybeimutation',
    },
    processState: 'running',
    pid: null,
    paths: {
      attemptDir: '/trusted/attempt',
      worktree: WORKTREE,
      manifest: MANIFEST,
      log: '/trusted/attempt/session.log',
      ghConfigDir: '/trusted/attempt/gh-config',
      askpass: '/trusted/attempt/askpass.sh',
      tokenFile: '/trusted/attempt/gh-token',
    },
    timestamps: {
      createdAt: NOW,
      updatedAt: NOW,
      childStartedAt: NOW,
    },
  };
}

function branchClaim(workflow: MutationWorkflow): BranchClaim {
  const child = workflow !== 'implement';
  return {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: workflow === 'implement'
      ? 'implement'
      : workflow === 'reconcile'
        ? 'reconcile'
        : 'fix',
    issueNumber: child ? 701 : 501,
    prNumber: 2101,
    attempt: ATTEMPT,
    runner: 'runner-1',
    login: 'jinn-autopilot',
    expectedHead: gitOid('a'.repeat(40)),
    targetBase: gitRefName('next'),
    claimedAt: NOW,
  };
}

function delivery(
  workflow: MutationWorkflow,
  result: AutopilotMutationResult = mutationResult(),
): VerifiedMarketplaceSolutionDelivery {
  return {
    schemaVersion: 'jinn-autopilot-verified-solution-delivery.v1',
    task: {
      id: 'task-501',
      creationTransactionHash: `0x${'c'.repeat(64)}`,
      creationBlockNumber: 123400,
      solverNetManifestCid: 'bafybeisolvernet',
    },
    attempt: {
      index: 0,
      v2AttemptId: ATTEMPT,
      manifestPath: MANIFEST,
    },
    request: { id: 'request-abc' },
    operator: {
      id: 'operator-1',
      address: `0x${'b'.repeat(40)}`,
      role: 'solver',
    },
    envelope: {
      cid: 'bafybeimutation',
      author: 'operator-1',
    },
    transaction: {
      hash: `0x${'a'.repeat(64)}`,
      blockNumber: 123456,
    },
    result,
    session: session(workflow),
  };
}

function reviewManifest(): AttemptManifest {
  return {
    ...manifest('implement'),
    attemptId: REVIEW_ATTEMPT,
    phase: 'review',
    subject: 'pr-2101',
    issueNumber: 501,
    expectedHead: COMPLETION,
    claimOid: REVIEW_REF,
    reviewGeneration: GENERATION,
    reviewRefOid: REVIEW_REF,
    reviewApprovalPolicy: 'approve-eligible',
    selectedLogin: 'reviewer-bot',
    execution: { backend: 'marketplace' },
    processState: 'preparing',
    paths: {
      ...manifest('implement').paths,
      attemptDir: '/trusted/review-attempt',
      worktree: '/trusted/review-attempt/worktree',
      manifest: '/trusted/review-attempt/manifest.json',
    },
    timestamps: {
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

class Harness implements
  VerifiedMarketplaceSolutionDeliveryPort,
  MarketplaceMutationAuthorityPort,
  MarketplaceMutationGitPort,
  MarketplaceMutationVerificationPort,
  MarketplaceReviewClaimPort,
  AdoptionReceiptPorts,
  MarketplaceMutationManifestReceiptPort {
  readonly reference: MarketplaceMutationDeliveryReference = {
    taskId: 'task-501',
    attemptIndex: 0,
    requestId: 'request-abc',
    deliveryEnvelopeCid: 'bafybeimutation',
  };
  readonly comments: AdoptionReceiptComment[] = [];
  readonly boundaries: MarketplaceMutationAdoptionBoundary[] = [];
  readonly receiptRecords: AutopilotAdoptionReceipt[] = [];
  currentManifest: AttemptManifest;
  currentClaim: BranchClaim;
  currentClaimOid: GitOid = CLAIM;
  remoteHead: GitOid = EXPECTED;
  prHead: GitOid = EXPECTED;
  gitState: MarketplaceMutationGitState = {
    status: 'clean',
    head: EXPECTED,
  };
  reviewClaim?: ConfirmedMarketplaceReviewClaim;
  deliveryValue: VerifiedMarketplaceSolutionDelivery;
  child?: MarketplaceMutationAuthority['child'];
  workflow: MutationWorkflow;
  verificationStatus: 'passed' | 'failed' = 'passed';
  verificationError?: Error;
  readonly verificationRepositoryPaths: string[] = [];
  codeOwnerRequired = false;
  trustedOperatorIds = ['operator-1'];
  crashBoundary?: MarketplaceMutationAdoptionBoundary;
  crashCommentWrite = false;
  patchError?: Error;
  staleOnAuthorityRead?: number;
  authorityReads = 0;
  applyMutations = 0;
  commitMutations = 0;
  checkpointMutations = 0;
  completionMutations = 0;
  childCloseMutations = 0;
  humanMutations = 0;
  reviewClaimMutations = 0;
  nextCommentId = 9001;
  clock: () => Date = () => new Date(NOW);

  constructor(workflow: MutationWorkflow = 'implement') {
    this.workflow = workflow;
    this.currentManifest = manifest(workflow);
    this.currentClaim = branchClaim(workflow);
    this.deliveryValue = delivery(workflow);
    if (workflow !== 'implement') {
      this.child = {
        number: 701,
        parentPrNumber: 2101,
        kind: workflow === 'fix-child'
          ? 'review-finding'
          : workflow === 'reconcile'
            ? 'reconcile'
            : 'ci-failure',
        open: true,
      };
    }
  }

  async readVerifiedSolutionDelivery(reference: MarketplaceMutationDeliveryReference) {
    expect(reference.taskId).not.toBe('');
    return this.deliveryValue;
  }

  async readExactAuthority(): Promise<MarketplaceMutationAuthority> {
    this.authorityReads += 1;
    if (this.staleOnAuthorityRead === this.authorityReads) {
      this.remoteHead = STALE;
      this.prHead = STALE;
    }
    return {
      manifest: this.currentManifest,
      latestClaimOid: this.currentClaimOid,
      latestClaim: this.currentClaim,
      remoteHead: this.remoteHead,
      pullRequest: {
        number: 2101,
        head: this.prHead,
        headRefName: 'autopilot/issue-501',
        baseRefName: 'next',
        open: true,
        draft: this.currentClaim.phaseComplete !== true,
        labels: [
          'engine:review',
          ...(this.currentClaim.phaseComplete === true ? [] : []),
          ...(this.codeOwnerRequired ? ['review:needs-human'] : []),
        ],
        body: session(this.workflow).taskSnapshot.prBody,
        implementationSummary: this.currentClaim.phaseComplete === true
          ? 'Adopt the verified marketplace mutation.'
          : undefined,
        human: {
          active: this.humanMutations > 0,
          draft: this.humanMutations > 0,
          label: this.humanMutations > 0,
          comment: this.humanMutations > 0,
        },
        codeOwner: {
          required: this.codeOwnerRequired,
          paths: this.codeOwnerRequired ? ['protected/path.ts'] : [],
        },
      },
      ...(this.child === undefined ? {} : { child: this.child }),
      ...(this.reviewClaim === undefined
        ? {}
        : { reviewClaim: this.reviewClaim }),
      trustedOperatorIds: this.trustedOperatorIds,
      receiptAuthors: ['jinn-autopilot'],
      publisherLogin: 'jinn-autopilot',
    };
  }

  async readState() {
    return this.gitState;
  }

  async commit(input: MarketplaceMutationCommitIdentity) {
    if (this.gitState.status === 'committed') return this.gitState;
    expect(this.gitState.status).toBe('pending-change');
    expect(new TextDecoder().decode(input.artifact)).toBe(PATCH);
    expect(input.workflow).toBe(this.workflow);
    expect(input.reconcileBase).toBe(
      this.workflow === 'reconcile'
        ? session('reconcile').taskSnapshot.baseSha
        : undefined,
    );
    this.commitMutations += 1;
    this.gitState = {
      status: 'committed',
      head: HOST_COMMIT,
      localHead: HOST_COMMIT,
      parent: EXPECTED,
      tree: HOST_TREE,
      changedPaths: ['value.txt'],
    };
    expect(input.childIssueNumber).toBe(
      this.workflow === 'implement' ? undefined : 701,
    );
    return this.gitState;
  }

  async verify(
    input: { readonly repositoryPath: string },
  ): Promise<MarketplaceMutationVerificationResult> {
    this.verificationRepositoryPaths.push(input.repositoryPath);
    if (this.verificationError !== undefined) throw this.verificationError;
    const common = {
      profile: 'jinn-mono.v1' as const,
      workspaces: ['packages/autopilot'] as const,
      commands: ['packages/autopilot:install'],
    };
    return this.verificationStatus === 'passed'
      ? { ...common, status: 'passed' }
      : {
          ...common,
          status: 'failed',
          failedCommand: 'packages/autopilot:typecheck',
          detail: 'typecheck failed',
        };
  }

  async acquireOrRecover(): Promise<
  | { readonly status: 'confirmed'; readonly claim: ConfirmedMarketplaceReviewClaim }
  | { readonly status: 'lost' | 'ambiguous' | 'human' | 'ineligible'; readonly detail?: string }
  > {
    if (this.reviewClaim === undefined) {
      this.reviewClaimMutations += 1;
      const head = this.workflow === 'implement' ? COMPLETION : HOST_COMMIT;
      const adoptedManifest = {
        ...reviewManifest(),
        expectedHead: head,
      };
      this.reviewClaim = {
        head,
        generation: GENERATION,
        refOid: REVIEW_REF,
        attemptId: REVIEW_ATTEMPT,
        manifest: adoptedManifest,
        reviewer: 'reviewer-bot',
        approvalPolicy: 'approve-eligible',
        state: 'active',
      };
    }
    return { status: 'confirmed', claim: this.reviewClaim };
  }

  readonly protocol: ImplementationSessionProtocol = {
    checkpoint: async () => {
      if (this.remoteHead !== HOST_COMMIT) {
        this.checkpointMutations += 1;
        this.remoteHead = HOST_COMMIT;
        this.prHead = HOST_COMMIT;
        this.currentManifest = {
          ...this.currentManifest,
          expectedHead: HOST_COMMIT,
        };
      }
      return { status: 'already-applied', head: HOST_COMMIT };
    },
    implementationComplete: async (_manifest, summary) => {
      if (this.currentClaim.phaseComplete !== true) {
        this.completionMutations += 1;
        this.currentClaim = {
          ...this.currentClaim,
          expectedHead: HOST_COMMIT,
          phaseComplete: true,
        };
        this.currentClaimOid = COMPLETION;
        this.remoteHead = COMPLETION;
        this.prHead = COMPLETION;
        this.currentManifest = {
          ...this.currentManifest,
          expectedHead: COMPLETION,
        };
        if (this.gitState.status === 'committed') {
          this.gitState = {
            ...this.gitState,
            localHead: COMPLETION,
          };
        }
      }
      expect(summary).toBe('Adopt the verified marketplace mutation.');
      return { status: 'complete', head: COMPLETION };
    },
    childComplete: async () => {
      if (this.child?.open === true) {
        this.childCloseMutations += 1;
        this.child = { ...this.child, open: false };
        this.remoteHead = HOST_COMMIT;
        this.prHead = HOST_COMMIT;
        this.currentManifest = {
          ...this.currentManifest,
          expectedHead: HOST_COMMIT,
        };
      }
      return { status: 'closed' };
    },
    reviewVerdict: async () => {
      throw new Error('not used');
    },
    human: async () => {
      if (this.humanMutations === 0) this.humanMutations += 1;
      return { status: 'human', head: this.remoteHead };
    },
  };

  async listPrIssueComments() {
    return { comments: this.comments };
  }

  async verifyReceiptFacts() {
    return true;
  }

  async readCurrentPrHead() {
    return this.prHead;
  }

  async createPrComment(input: CreateAdoptionReceiptCommentInput) {
    expect(input.expectedHead).toBe(this.prHead);
    const comment = {
      id: this.nextCommentId,
      authorLogin: 'jinn-autopilot',
      body: input.body,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.nextCommentId += 1;
    this.comments.push(comment);
    if (this.crashCommentWrite) {
      this.crashCommentWrite = false;
      throw new Error('crash after comment write');
    }
    return { commentId: comment.id };
  }

  async record(input: { readonly receipt: AutopilotAdoptionReceipt }) {
    this.receiptRecords.push(input.receipt);
  }

  async applyPatch(): Promise<ValidatedMarketplacePatch> {
    if (this.patchError !== undefined) throw this.patchError;
    expect(this.gitState.status).toBe('clean');
    this.applyMutations += 1;
    this.gitState = {
      status: 'pending-change',
      head: EXPECTED,
      tree: HOST_TREE,
      changedPaths: ['value.txt'],
    };
    return { byteLength: new TextEncoder().encode(PATCH).byteLength, touchedPaths: ['value.txt'] };
  }

  async boundary(boundary: MarketplaceMutationAdoptionBoundary) {
    this.boundaries.push(boundary);
    if (this.crashBoundary === boundary) {
      this.crashBoundary = undefined;
      throw new Error(`crash after ${boundary}`);
    }
  }

  coordinator(): MarketplaceMutationAdoptionCoordinator {
    return makeMarketplaceMutationAdoptionCoordinator({
      deliveries: this,
      authority: this,
      git: this,
      verification: this,
      implementation: this.protocol,
      reviewClaims: this,
      receipts: this,
      manifestReceipts: this,
      applyPatch: () => this.applyPatch(),
      now: () => this.clock(),
      onBoundary: (boundary) => this.boundary(boundary),
    });
  }
}

async function adopt(harness: Harness) {
  return harness.coordinator().adopt(harness.reference);
}

describe('marketplace mutation adoption workflows', () => {
  it('adopts an implementation result through completion, review claim, and receipt readback', async () => {
    const harness = new Harness();

    const result = await adopt(harness);

    expect(result).toMatchObject({
      status: 'accepted',
      operation: 'implementation-complete',
      hostCommit: { head: HOST_COMMIT, tree: HOST_TREE },
      resultingHead: COMPLETION,
      origin: { v2AttemptId: ATTEMPT, manifestPath: MANIFEST },
      taskProvenance: {
        creationTransactionHash: `0x${'c'.repeat(64)}`,
        creationBlockNumber: 123400,
        solverNetManifestCid: 'bafybeisolvernet',
      },
      reviewClaim: {
        attemptId: REVIEW_ATTEMPT,
        generation: GENERATION,
        refOid: REVIEW_REF,
        head: COMPLETION,
        manifest: { phase: 'review' },
      },
      publication: 'published',
    });
    expect(harness.comments).toHaveLength(1);
    expect(parseAdoptionReceiptComment(harness.comments[0]!.body)?.receipt)
      .toMatchObject({
        disposition: 'accepted',
        operation: 'implementation-complete',
        resultingHead: COMPLETION,
        reviewGeneration: GENERATION,
        reviewRefOid: REVIEW_REF,
    });
    expect(harness.receiptRecords).toHaveLength(1);
    expect(harness.verificationRepositoryPaths).toEqual([WORKTREE]);
  });

  it.each([
    ['fix-child', 'review-finding'],
    ['reconcile', 'reconcile'],
    ['ci-failure', 'ci-failure'],
  ] as const)('maps %s directly through child-complete', async (workflow, kind) => {
    const harness = new Harness(workflow);

    const result = await adopt(harness);

    expect(result).toMatchObject({
      status: 'accepted',
      operation: 'child-complete',
      resultingHead: HOST_COMMIT,
      reviewClaim: { head: HOST_COMMIT },
    });
    expect(harness.child).toEqual({
      number: 701,
      parentPrNumber: 2101,
      kind,
      open: false,
    });
    expect(harness.completionMutations).toBe(0);
    expect(harness.checkpointMutations).toBe(0);
    expect(harness.childCloseMutations).toBe(1);
  });

  it('turns a Human mutation result into a durable Human hold and rejected receipt', async () => {
    const harness = new Harness();
    harness.deliveryValue = delivery('implement', mutationResult('human'));

    const result = await adopt(harness);

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'policy-human',
      publication: 'published',
    });
    expect(harness.humanMutations).toBe(1);
    expect(harness.applyMutations).toBe(0);
    expect(harness.commitMutations).toBe(0);
    expect(harness.completionMutations).toBe(0);
  });

  it('rejects a CODEOWNER surface before applying the artifact', async () => {
    const harness = new Harness();
    harness.codeOwnerRequired = true;

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'policy-human',
    });
    expect(harness.applyMutations).toBe(0);
    expect(harness.humanMutations).toBe(0);
  });
});

describe('marketplace mutation adoption rejection policy', () => {
  it('rejects a full-correlation mismatch before effects', async () => {
    const harness = new Harness();
    harness.deliveryValue = delivery('implement', {
      ...mutationResult(),
      correlation: {
        ...correlation(),
        requestId: 'wrong-request',
      },
    } as AutopilotMutationResult);

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'correlation-mismatch',
      publication: 'published',
    });
    expect(harness.applyMutations).toBe(0);
    expect(harness.comments).toHaveLength(1);
  });

  it('fences a mismatched reference before reading malformed delivery payloads', async () => {
    const harness = new Harness();
    harness.deliveryValue = {
      ...harness.deliveryValue,
      session: { malformed: true } as unknown as AutopilotSessionCapsule,
      result: { malformed: true } as unknown as AutopilotMutationResult,
    };

    await expect(harness.coordinator().adopt({
      ...harness.reference,
      requestId: 'different-request',
    })).resolves.toMatchObject({
      status: 'recoverable',
      stage: 'delivery-fence',
    });
    expect(harness.applyMutations).toBe(0);
    expect(harness.comments).toHaveLength(0);
  });

  it('rejects an untrusted operator before effects', async () => {
    const harness = new Harness();
    harness.trustedOperatorIds = ['another-operator'];

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'untrusted-operator',
    });
    expect(harness.applyMutations).toBe(0);
  });

  it('rejects stale claim authority before effects', async () => {
    const harness = new Harness();
    harness.currentClaim = {
      ...harness.currentClaim,
      attempt: '123e4567-e89b-42d3-a456-426614174099',
    };

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'stale-claim',
    });
    expect(harness.applyMutations).toBe(0);
  });

  it('rejects a stale head before effects', async () => {
    const harness = new Harness();
    harness.remoteHead = STALE;
    harness.prHead = STALE;

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'stale-head',
    });
    expect(harness.applyMutations).toBe(0);
  });

  it('rejects a previously closed child unless an exact host commit is recoverable', async () => {
    const harness = new Harness('fix-child');
    harness.child = { ...harness.child!, open: false };

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'stale-claim',
    });
    expect(harness.applyMutations).toBe(0);
    expect(harness.commitMutations).toBe(0);
  });

  it('re-reads authority after verification and refuses to commit a stale head', async () => {
    const harness = new Harness();
    harness.staleOnAuthorityRead = 2;

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'stale-head',
    });
    expect(harness.applyMutations).toBe(1);
    expect(harness.commitMutations).toBe(0);
  });

  it('maps invalid artifact paths to invalid-artifact', async () => {
    const harness = new Harness();
    const result = mutationResult() as Extract<
      AutopilotMutationResult,
      { readonly outcome: 'mutation-complete' }
    >;
    harness.deliveryValue = delivery('implement', {
      ...result,
      patch: result.patch.replaceAll('value.txt', '../outside.txt'),
    });

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'invalid-artifact',
    });
    expect(harness.applyMutations).toBe(0);
  });

  it('maps apply-check failure to patch-does-not-apply', async () => {
    const harness = new Harness();
    harness.patchError = new MarketplacePatchCheckError(new Error('does not apply'));

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'patch-does-not-apply',
    });
    expect(harness.commitMutations).toBe(0);
  });

  it('rejects failed jinn-mono.v1 verification without branch publication', async () => {
    const harness = new Harness();
    harness.verificationStatus = 'failed';

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'verification-failed',
    });
    expect(harness.applyMutations).toBe(1);
    expect(harness.commitMutations).toBe(0);
    expect(harness.checkpointMutations).toBe(0);
  });

  it.each(['invalid-path', 'unsupported-path'] as const)(
    'stably rejects deterministic verification planner error %s',
    async (code) => {
      const harness = new Harness();
      harness.verificationError = new MarketplaceVerificationPlanError(
        code,
        `deterministic ${code}`,
      );

      await expect(adopt(harness)).resolves.toMatchObject({
        status: 'rejected',
        reason: 'invalid-artifact',
        publication: 'published',
      });
      expect(harness.commitMutations).toBe(0);
    },
  );

  it('keeps infrastructure ambiguity recoverable and writes no receipt', async () => {
    const harness = new Harness();
    harness.readExactAuthority = async () => {
      throw new Error('authority transport unavailable');
    };

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'recoverable',
      detail: 'authority transport unavailable',
    });
    expect(harness.comments).toHaveLength(0);
  });

  it('turns a durable Git contradiction into Human authority and receipt-contradiction', async () => {
    const harness = new Harness();
    harness.gitState = {
      status: 'contradiction',
      detail: 'local tree is not the exact delivered patch',
    };

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'receipt-contradiction',
      publication: 'published',
    });
    expect(harness.humanMutations).toBe(1);
    expect(harness.applyMutations).toBe(0);
    expect(harness.commitMutations).toBe(0);
  });

  it('turns a conflicting durable receipt into Human authority without overwriting it', async () => {
    const harness = new Harness();
    const existingReceipt: AutopilotAdoptionReceipt = {
      schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
      disposition: 'rejected',
      role: 'solution',
      reason: 'stale-head',
      detail: 'earlier exact rejection',
      ...correlation(),
      recordedAt: NOW,
    };
    harness.comments.push({
      id: 8001,
      authorLogin: 'jinn-autopilot',
      body: formatAdoptionReceiptComment(existingReceipt),
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'receipt-contradiction',
      publication: 'not-published',
    });
    expect(harness.humanMutations).toBe(1);
    expect(harness.comments).toHaveLength(1);
  });
});

describe('marketplace mutation adoption crash recovery', () => {
  it.each([
    'validated',
    'patch-applied',
    'committed',
    'checkpointed',
    'completed',
    'review-claimed',
  ] as const)('recovers idempotently after %s', async (boundary) => {
    const harness = new Harness();
    harness.crashBoundary = boundary;

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'recoverable',
    });
    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(harness.applyMutations).toBe(1);
    expect(harness.commitMutations).toBe(1);
    expect(harness.checkpointMutations).toBe(1);
    expect(harness.completionMutations).toBe(1);
    expect(harness.reviewClaimMutations).toBe(1);
    expect(harness.comments).toHaveLength(1);
  });

  it('recovers an accepted comment when the writer crashed after GitHub stored it', async () => {
    const harness = new Harness();
    harness.crashCommentWrite = true;

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'recoverable',
      detail: 'crash after comment write',
    });
    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'accepted',
      publication: 'already-published',
    });
    expect(harness.comments).toHaveLength(1);
    expect(harness.receiptRecords).toHaveLength(1);
  });

  it('recovers the exact accepted receipt across a real-clock crash after comment write', async () => {
    const harness = new Harness();
    let tick = 0;
    harness.clock = () => new Date(
      tick++ === 0
        ? '2026-07-24T12:00:00.000Z'
        : '2026-07-24T12:05:00.000Z',
    );
    harness.crashCommentWrite = true;

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'recoverable',
      detail: 'crash after comment write',
    });
    const durable =
      parseAdoptionReceiptComment(harness.comments[0]!.body)!.receipt;
    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'accepted',
      publication: 'already-published',
      receipt: { recordedAt: durable.recordedAt },
    });
    expect(harness.comments).toHaveLength(1);
    expect(harness.receiptRecords).toEqual([durable]);
  });

  it('recovers after the exact child was closed without closing it twice', async () => {
    const harness = new Harness('fix-child');
    harness.crashBoundary = 'completed';

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'recoverable',
    });
    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'accepted',
      operation: 'child-complete',
    });
    expect(harness.childCloseMutations).toBe(1);
    expect(harness.checkpointMutations).toBe(0);
    expect(harness.reviewClaimMutations).toBe(1);
    expect(harness.comments).toHaveLength(1);
  });

  it('reconstructs a completed adoption without duplicate effects', async () => {
    const harness = new Harness();

    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'accepted',
      publication: 'published',
    });
    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'accepted',
      publication: 'already-published',
    });
    expect(harness.applyMutations).toBe(1);
    expect(harness.commitMutations).toBe(1);
    expect(harness.checkpointMutations).toBe(1);
    expect(harness.completionMutations).toBe(1);
    expect(harness.reviewClaimMutations).toBe(1);
    expect(harness.comments).toHaveLength(1);
  });
});
