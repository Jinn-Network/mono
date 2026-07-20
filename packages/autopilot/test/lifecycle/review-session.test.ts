import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import { formatAutomatedReviewMarker } from '../../src/lifecycle/codecs.js';
import {
  makeReviewSessionProtocol,
  type ReviewSessionAuthority,
  type ReviewSessionPort,
} from '../../src/lifecycle/review-session.js';
import {
  gitOid,
  type GitOid,
  type ReviewClaimRecord,
  type ReviewVerdictState,
} from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const FIX_ONE = gitOid('2'.repeat(40));
const FIX_TWO = gitOid('3'.repeat(40));
const ACTIVE = gitOid('4'.repeat(40));
const INTENT = gitOid('5'.repeat(40));
const FIXING = gitOid('6'.repeat(40));
const NEXT_ACTIVE = gitOid('7'.repeat(40));
const TERMINAL = gitOid('8'.repeat(40));
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const MARKER = '33333333-3333-4333-8333-333333333333';

function record(
  state: ReviewClaimRecord['state'] = 'active',
  overrides: Partial<ReviewClaimRecord> = {},
): ReviewClaimRecord {
  const common = {
    kind: 'review-claim' as const,
    protocolVersion: 2 as const,
    prNumber: 84,
    generation: GENERATION,
    attempt: ATTEMPT,
    reviewer: 'review-bot',
    head: HEAD,
    recordedAt: '2026-07-20T12:00:00.000Z',
  };
  if (state === 'verdict-intent') {
    return {
      ...common,
      state,
      verdict: { state: 'REQUEST_CHANGES', marker: MARKER },
      ...overrides,
    } as ReviewClaimRecord;
  }
  if (state === 'terminal-approved') {
    return {
      ...common,
      state,
      verdict: { state: 'APPROVE', marker: MARKER },
      ...overrides,
    } as ReviewClaimRecord;
  }
  return { ...common, state, ...overrides } as ReviewClaimRecord;
}

function manifest(
  expectedHead: GitOid = HEAD,
  reviewRefOid: GitOid = ACTIVE,
  approvalPolicy: 'approve-eligible' | 'human-codeowner' = 'approve-eligible',
): AttemptManifest {
  return {
    version: 2,
    attemptId: ATTEMPT,
    runnerId: 'runner-a',
    host: 'host-a',
    phase: 'review',
    subject: 'pr-84',
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    expectedHead,
    claimOid: ACTIVE,
    reviewGeneration: GENERATION,
    reviewRefOid,
    reviewApprovalPolicy: approvalPolicy,
    selectedLogin: 'review-bot',
    repository: {
      root: '/repo',
      gitCommonDir: '/repo/.git',
      remoteName: 'jinn-autopilot-v2',
      remoteUrlHash: 'a'.repeat(64),
    },
    processState: 'running',
    pid: 42,
    paths: {
      attemptDir: '/attempt',
      worktree: '/attempt/worktree',
      manifest: '/attempt/manifest.json',
      log: '/attempt/session.log',
      ghConfigDir: '/attempt/gh',
      askpass: '/attempt/askpass',
      tokenFile: '/attempt/gh-token',
    },
    timestamps: {
      createdAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T12:00:00.000Z',
      childStartedAt: '2026-07-20T12:00:00.000Z',
    },
  } as AttemptManifest;
}

function nativeBody(state: ReviewVerdictState, head: GitOid = HEAD): string {
  return formatAutomatedReviewMarker({
    generation: GENERATION,
    attempt: ATTEMPT,
    intent: MARKER,
    reviewer: 'review-bot',
    head,
    verdict: state,
  });
}

function harness(options: {
  state?: ReviewClaimRecord['state'];
  verdictState?: ReviewVerdictState;
  draft?: boolean;
  policy?: 'approve-eligible' | 'human-codeowner';
  localHead?: GitOid;
  clean?: boolean;
  treeChanged?: boolean;
  nativeExists?: boolean;
  humanChecks?: boolean[];
} = {}) {
  let currentManifest = manifest(HEAD, ACTIVE, options.policy);
  let authority: ReviewSessionAuthority = {
    reviewRefOid: ACTIVE,
    record: options.state === 'verdict-intent'
      ? record('verdict-intent', {
          verdict: {
            state: options.verdictState ?? 'REQUEST_CHANGES',
            marker: MARKER,
          },
        })
      : record(options.state),
  };
  if (options.state !== undefined && options.state !== 'active') {
    currentManifest = manifest(HEAD, ACTIVE, options.policy);
  }
  let draft = options.draft ?? false;
  let labels = new Set(['engine:review']);
  let project: 'In Review' | 'Human' = 'In Review';
  let localHead = options.localHead ?? FIX_ONE;
  let native = options.nativeExists
    ? [{
        reviewer: 'review-bot',
        state: (options.verdictState ?? 'REQUEST_CHANGES') === 'APPROVE'
          ? 'APPROVED' as const
          : 'CHANGES_REQUESTED' as const,
        commitId: HEAD,
        body: nativeBody(options.verdictState ?? 'REQUEST_CHANGES'),
        submittedAt: '2026-07-20T12:01:00.000Z',
      }]
    : [];
  const events: string[] = [];
  const humanChecks = [...(options.humanChecks ?? [])];
  const comments = new Set<string>();

  const port: ReviewSessionPort = {
    readManifest: () => currentManifest,
    readAuthority: async () => authority,
    readPullRequest: async () => ({
      number: 84,
      issueNumber: 42,
      open: true,
      head: currentManifest.expectedHead as GitOid,
      headRefName: 'autopilot/42',
      baseRefName: 'next',
      draft,
      author: 'implementation-bot',
      labels: [...labels],
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      approvalPolicy: options.policy ?? 'approve-eligible',
    }),
    readNativeReviews: async () => native,
    hasHumanHold: async () => humanChecks.shift() ?? project === 'Human',
    createReviewRecord: async ({ record: next }) => {
      events.push(`record:${next.state}`);
      if (next.state === 'verdict-intent') return INTENT;
      if (next.state === 'fixing') return FIXING;
      if (next.state === 'terminal-approved') return TERMINAL;
      return NEXT_ACTIVE;
    },
    publishReviewClaim: async ({ recordOid, expectedRemoteRecordOid, record: next }) => {
      events.push(`claim:${next.state}`);
      if (authority.reviewRefOid !== expectedRemoteRecordOid) {
        return {
          status: 'lost',
          expected: expectedRemoteRecordOid,
          published: recordOid,
          observed: authority.reviewRefOid,
        };
      }
      authority = { reviewRefOid: recordOid, record: next };
      currentManifest = { ...currentManifest, reviewRefOid: recordOid };
      return {
        status: 'won',
        expected: expectedRemoteRecordOid,
        published: recordOid,
        observed: recordOid,
      };
    },
    submitNativeReview: async ({ state, commitId, body }) => {
      events.push(`native:${state}:${commitId}`);
      native = [...native, {
        reviewer: 'review-bot',
        state: state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
        commitId,
        body,
        submittedAt: '2026-07-20T12:01:00.000Z',
      }];
    },
    setPullRequestLabel: async (_pr, _head, label, present) => {
      events.push(`label:${label}:${present}`);
      if (present) labels.add(label);
      else labels.delete(label);
    },
    setProjectStatus: async (_issue, _head, status) => {
      events.push(`project:${status}`);
      project = status;
    },
    setPullRequestDraft: async (_pr, _head, next) => {
      events.push(`draft:${next}`);
      draft = next;
    },
    readLocalFix: async () => ({
      head: localHead,
      clean: options.clean ?? true,
      parentMatches: true,
      treeChanged: options.treeChanged ?? true,
    }),
    publishReviewFix: async ({ expectedRemoteHead, newHead, recordOid, record: next }) => {
      events.push(`atomic:${expectedRemoteHead}->${newHead}`);
      authority = { reviewRefOid: recordOid, record: next };
      return {
        status: 'won',
        expected: { branch: expectedRemoteHead, review: currentManifest.reviewRefOid as GitOid },
        published: { branch: newHead, review: recordOid },
        observed: { branch: newHead, review: recordOid },
      };
    },
    advanceManifestPair: (_path, expectedHead, expectedReview, nextHead, nextReview) => {
      events.push(`manifest:${expectedHead}/${expectedReview}->${nextHead}/${nextReview}`);
      if (
        currentManifest.expectedHead !== expectedHead
        || currentManifest.reviewRefOid !== expectedReview
      ) {
        throw new Error('stale manifest writer');
      }
      currentManifest = {
        ...currentManifest,
        expectedHead: nextHead,
        reviewRefOid: nextReview,
      };
      return currentManifest;
    },
    hasHumanComment: async (_pr, _head, body) => comments.has(body),
    ensureHumanComment: async (_pr, _head, _marker, body) => {
      events.push('human-comment');
      comments.add(body);
    },
    nextMarker: () => MARKER,
    now: () => new Date('2026-07-20T12:01:00.000Z'),
  };
  return {
    port,
    protocol: makeReviewSessionProtocol(port),
    events,
    get manifest() { return currentManifest; },
    get authority() { return authority; },
    set authority(next: ReviewSessionAuthority) { authority = next; },
    get draft() { return draft; },
    get labels() { return labels; },
    get project() { return project; },
    get native() { return native; },
    set localHead(next: GitOid) { localHead = next; },
  };
}

describe('review session protocol', () => {
  it('publishes verdict intent before native request-changes, confirms it, enters fixing, then drafts', async () => {
    const h = harness();

    await expect(h.protocol.reviewVerdict(h.manifest, 'REQUEST_CHANGES', 'Please fix.'))
      .resolves.toMatchObject({ status: 'fixing', head: HEAD });

    expect(h.events).toEqual([
      'record:verdict-intent',
      'claim:verdict-intent',
      `native:REQUEST_CHANGES:${HEAD}`,
      'record:fixing',
      'claim:fixing',
      'label:review:changes-requested:true',
      'draft:true',
    ]);
    expect(h.draft).toBe(true);
  });

  it('recovers an accepted-response ambiguity and duplicate retry without a second native verdict', async () => {
    const h = harness({
      state: 'verdict-intent',
      verdictState: 'REQUEST_CHANGES',
      nativeExists: true,
    });

    await h.protocol.reviewVerdict(h.manifest, 'REQUEST_CHANGES', 'Retry body');
    expect(h.events.filter((event) => event.startsWith('native:'))).toEqual([]);
    expect(h.events).toContain('claim:fixing');
  });

  it('does not complete an exact intent from a copied marker with the wrong login', async () => {
    const h = harness({
      state: 'verdict-intent',
      verdictState: 'REQUEST_CHANGES',
    });
    h.native.push({
      reviewer: 'marker-copying-bot',
      state: 'CHANGES_REQUESTED',
      commitId: HEAD,
      body: nativeBody('REQUEST_CHANGES'),
      submittedAt: '2026-07-20T12:01:00.000Z',
    });

    await h.protocol.reviewVerdict(h.manifest, 'REQUEST_CHANGES', 'Retry body');

    expect(h.events.filter((event) => event.startsWith('native:'))).toEqual([
      `native:REQUEST_CHANGES:${HEAD}`,
    ]);
  });

  it('repairs labels and draft state after a crash that already reached fixing authority', async () => {
    const h = harness({
      state: 'fixing',
      verdictState: 'REQUEST_CHANGES',
      nativeExists: true,
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'REQUEST_CHANGES', 'Retry body'))
      .resolves.toMatchObject({ status: 'fixing' });

    expect(h.events).toEqual([
      'label:review:changes-requested:true',
      'draft:true',
    ]);
  });

  it('reads back an accepted native verdict after the client loses the response', async () => {
    const h = harness();
    const submit = h.port.submitNativeReview;
    h.port.submitNativeReview = async (input) => {
      await submit(input);
      throw new Error('connection reset after server acceptance');
    };

    await expect(
      h.protocol.reviewVerdict(h.manifest, 'REQUEST_CHANGES', 'Please fix.'),
    ).resolves.toMatchObject({ status: 'fixing' });
    expect(h.events.filter((event) => event.startsWith('native:'))).toHaveLength(1);
  });

  it('approves the exact final head, appends terminal, reconciles, and makes ready last', async () => {
    const h = harness({ draft: true });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: 'approved', head: HEAD });

    expect(h.events.at(-1)).toBe('draft:false');
    expect(h.events.indexOf('claim:terminal-approved'))
      .toBeLessThan(h.events.indexOf('draft:false'));
    expect(h.events).toContain(`native:APPROVE:${HEAD}`);
  });

  it('never approves a human-codeowner surface and preserves a draft Human hold', async () => {
    const h = harness({ policy: 'human-codeowner', draft: true });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Engine clean.'))
      .resolves.toMatchObject({ status: 'human' });

    expect(h.events.some((event) => event.startsWith('native:'))).toBe(false);
    expect(h.events).toContain('human-comment');
    expect(h.events).toContain('project:Human');
    expect(h.draft).toBe(true);
  });

  it('keeps any native requested-changes verdict as an approval blocker', async () => {
    const h = harness({ draft: true });
    h.native.push({
      reviewer: 'late-stale-reviewer',
      state: 'CHANGES_REQUESTED',
      commitId: HEAD,
      body: '<!-- stale generation -->',
      submittedAt: '2026-07-20T12:00:30.000Z',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain(`native:APPROVE:${HEAD}`);
    expect(h.draft).toBe(true);
  });

  it('keeps an effective requested-changes review on an older head as a blocker', async () => {
    const h = harness({ draft: true });
    h.native.push({
      reviewer: 'stale-head-reviewer',
      state: 'CHANGES_REQUESTED',
      commitId: FIX_ONE,
      body: 'Still unresolved.',
      submittedAt: '2026-07-20T12:00:30.000Z',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain(`native:APPROVE:${HEAD}`);
  });

  it('does not exempt a current requested-changes blocker by matching marker substrings', async () => {
    const h = harness({ draft: true });
    h.native.push({
      reviewer: 'review-bot',
      state: 'CHANGES_REQUESTED',
      commitId: HEAD,
      body: `generation=${GENERATION} attempt=${ATTEMPT}`,
      submittedAt: '2026-07-20T12:00:30.000Z',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain(`native:APPROVE:${HEAD}`);
  });

  it('uses each reviewer login latest decisive current-head review as the effective blocker', async () => {
    const h = harness({ draft: true });
    h.native.push(
      {
        reviewer: 'human-reviewer',
        state: 'CHANGES_REQUESTED',
        commitId: HEAD,
        body: 'Old blocker.',
        submittedAt: '2026-07-20T12:00:10.000Z',
      },
      {
        reviewer: 'human-reviewer',
        state: 'APPROVED',
        commitId: HEAD,
        body: 'Resolved.',
        submittedAt: '2026-07-20T12:00:20.000Z',
      },
    );

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: 'approved' });
  });

  it('rechecks native blockers after approval readback before terminal publication', async () => {
    const h = harness({ draft: true });
    const read = h.port.readNativeReviews;
    let reads = 0;
    h.port.readNativeReviews = async (...args) => {
      reads += 1;
      const reviews = [...await read(...args)];
      if (reads >= 4) {
        reviews.push({
          reviewer: 'late-human-reviewer',
          state: 'CHANGES_REQUESTED',
          commitId: HEAD,
          body: 'Arrived after approval.',
          submittedAt: '2026-07-20T12:01:30.000Z',
        });
      }
      return reviews;
    };

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain('claim:terminal-approved');
  });

  it('rechecks native blockers immediately before ready', async () => {
    const h = harness({
      state: 'terminal-approved',
      verdictState: 'APPROVE',
      nativeExists: true,
      draft: true,
    });
    const read = h.port.readNativeReviews;
    let reads = 0;
    h.port.readNativeReviews = async (...args) => {
      reads += 1;
      const reviews = [...await read(...args)];
      if (reads >= 4) {
        reviews.push({
          reviewer: 'late-human-reviewer',
          state: 'CHANGES_REQUESTED',
          commitId: HEAD,
          body: 'Arrived before ready.',
          submittedAt: '2026-07-20T12:02:00.000Z',
        });
      }
      return reviews;
    };

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain('draft:false');
  });

  it('stops when Human arrives immediately before an inverse mutation or ready', async () => {
    const beforeLabelRemoval = harness({
      draft: true,
      humanChecks: [false, true],
    });
    beforeLabelRemoval.labels.add('review:changes-requested');
    await expect(
      beforeLabelRemoval.protocol.reviewVerdict(
        beforeLabelRemoval.manifest,
        'APPROVE',
        'Clean.',
      ),
    ).resolves.toMatchObject({ status: 'human' });
    expect(beforeLabelRemoval.events).not.toContain('label:review:changes-requested:false');
    expect(beforeLabelRemoval.events).not.toContain('draft:false');

    const beforeReady = harness({
      draft: true,
      humanChecks: [false, false, true],
    });
    await expect(
      beforeReady.protocol.reviewVerdict(beforeReady.manifest, 'APPROVE', 'Clean.'),
    ).resolves.toMatchObject({ status: 'human' });
    expect(beforeReady.events).not.toContain('draft:false');
  });

  it('atomically publishes a real clean fix and advances the manifest head/ref pair', async () => {
    const h = harness({ state: 'fixing', draft: true, localHead: FIX_ONE });

    await expect(h.protocol.reviewFixPublish(h.manifest))
      .resolves.toEqual({ status: 'published', head: FIX_ONE, reviewRefOid: NEXT_ACTIVE });

    expect(h.events).toEqual([
      'record:active',
      `atomic:${HEAD}->${FIX_ONE}`,
      `manifest:${HEAD}/${ACTIVE}->${FIX_ONE}/${NEXT_ACTIVE}`,
    ]);
  });

  it('recovers an already-published atomic branch/review pair after a process crash', async () => {
    const h = harness({ state: 'fixing', draft: true, localHead: FIX_ONE });
    h.authority = {
      reviewRefOid: NEXT_ACTIVE,
      record: record('active', { head: FIX_ONE }),
    };
    h.port.readPullRequest = async (_pr, expectedHead) => ({
      number: 84,
      issueNumber: 42,
      open: true,
      head: expectedHead,
      headRefName: 'autopilot/42',
      baseRefName: 'next',
      draft: true,
      author: 'implementation-bot',
      labels: ['engine:review', 'review:changes-requested'],
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      approvalPolicy: 'approve-eligible',
    });

    await expect(h.protocol.reviewFixPublish(h.manifest)).resolves.toEqual({
      status: 'already-applied',
      head: FIX_ONE,
      reviewRefOid: NEXT_ACTIVE,
    });
    expect(h.events).toEqual([
      `manifest:${HEAD}/${ACTIVE}->${FIX_ONE}/${NEXT_ACTIVE}`,
    ]);
  });

  it.each([
    { clean: false, treeChanged: true, message: /clean/i },
    { clean: true, treeChanged: false, message: /tree/i },
  ])('preserves invalid local fix work: $message', async ({ clean, treeChanged, message }) => {
    const h = harness({ state: 'fixing', draft: true, clean, treeChanged });
    await expect(h.protocol.reviewFixPublish(h.manifest)).rejects.toThrow(message);
    expect(h.events).toEqual([]);
  });

  it('fails closed on atomic lease loss and one-sided/ambiguous application', async () => {
    const h = harness({ state: 'fixing', draft: true });
    h.port.publishReviewFix = async () => ({
      status: 'lost',
      expected: { branch: HEAD, review: ACTIVE },
      published: { branch: FIX_ONE, review: NEXT_ACTIVE },
      observed: { branch: FIX_ONE, review: ACTIVE },
    });

    await expect(h.protocol.reviewFixPublish(h.manifest))
      .resolves.toMatchObject({ status: 'stale' });
    expect(h.manifest.expectedHead).toBe(HEAD);
    expect(h.manifest.reviewRefOid).toBe(ACTIVE);
  });

  it('supports same-session multi-round fixes and binds approval to the final head', async () => {
    const h = harness({ state: 'fixing', draft: true, localHead: FIX_ONE });
    await h.protocol.reviewFixPublish(h.manifest);
    h.authority = { reviewRefOid: NEXT_ACTIVE, record: record('active', { head: FIX_ONE }) };
    h.localHead = FIX_TWO;
    await h.protocol.reviewVerdict(h.manifest, 'REQUEST_CHANGES', 'Round two.');
    await h.protocol.reviewFixPublish(h.manifest);
    await h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Final clean.');

    expect(h.events).toContain(`native:APPROVE:${FIX_TWO}`);
    expect(h.manifest.expectedHead).toBe(FIX_TWO);
  });

  it('rejects stale manifests, changed PR authority, wrong reviewer, and late stale approval', async () => {
    const h = harness();
    h.authority = {
      reviewRefOid: ACTIVE,
      record: record('active', { reviewer: 'someone-else' }),
    };
    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'No.'))
      .rejects.toThrow(/owns|authority|reviewer/i);
    expect(h.events).toEqual([]);
  });

  it('parks review attempts with structured Human evidence without clearing existing holds', async () => {
    const h = harness({ state: 'fixing', draft: true });
    await expect(h.protocol.human(h.manifest, 'Needs architectural judgment.'))
      .resolves.toMatchObject({ status: 'human', head: HEAD });
    expect(h.events.slice(0, 2)).toEqual(['record:human', 'claim:human']);
    expect(h.events).toContain('human-comment');
    expect(h.events).toContain('project:Human');
    expect(h.events).not.toContain('draft:false');
  });

  it('does not project Human until the exact-parent Human review record wins', async () => {
    const h = harness({ state: 'fixing', draft: false });
    h.port.publishReviewClaim = async ({ recordOid, expectedRemoteRecordOid }) => ({
      status: 'lost',
      expected: expectedRemoteRecordOid,
      published: recordOid,
      observed: TERMINAL,
    });

    await expect(h.protocol.human(h.manifest, 'Needs judgment.'))
      .rejects.toThrow(/Human.*record|authority/i);
    expect(h.events).toEqual(['record:human']);
  });

  it.each([
    {
      name: 'closed PR',
      mutate: (pullRequest: Awaited<ReturnType<ReviewSessionPort['readPullRequest']>>) => ({
        ...pullRequest,
        open: false,
      }),
    },
    {
      name: 'changed issue mapping',
      mutate: (pullRequest: Awaited<ReturnType<ReviewSessionPort['readPullRequest']>>) => ({
        ...pullRequest,
        issueNumber: 43,
        mappingProblem: 'PR now maps to issue #43.',
      }),
    },
    {
      name: 'changed CODEOWNER policy',
      mutate: (pullRequest: Awaited<ReturnType<ReviewSessionPort['readPullRequest']>>) => ({
        ...pullRequest,
        approvalPolicy: 'human-codeowner' as const,
      }),
    },
  ])('enters durable Human when verdict authority sees a $name', async ({ mutate }) => {
    const h = harness({ draft: true });
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => mutate(await read(...args));

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: 'human' });
    expect(h.authority.record.state).toBe('human');
    expect(h.events).not.toContain(`native:APPROVE:${HEAD}`);
  });

  it('enters durable Human when fix publication sees changed mapping or policy', async () => {
    const h = harness({ state: 'fixing', draft: true });
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => ({
      ...await read(...args),
      approvalPolicy: 'human-codeowner',
    });

    await expect(h.protocol.reviewFixPublish(h.manifest))
      .resolves.toMatchObject({ status: 'human' });
    expect(h.authority.record.state).toBe('human');
    expect(h.events).not.toContain(`atomic:${HEAD}->${FIX_ONE}`);
  });
});
