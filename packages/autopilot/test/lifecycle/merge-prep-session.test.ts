import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  makeMergePrepSessionProtocol,
  type MergePrepAuthority,
  type MergePrepSessionPort,
} from '../../src/lifecycle/merge-prep-session.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
  type GitOid,
} from '../../src/lifecycle/types.js';

const OLD_HEAD = gitOid('1'.repeat(40));
const BASE = gitOid('2'.repeat(40));
const CLAIM = gitOid('3'.repeat(40));
const PREPARED = gitOid('4'.repeat(40));
const COMPLETE = gitOid('5'.repeat(40));
const MOVED_BASE = gitOid('6'.repeat(40));
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

function claim(overrides: Partial<BranchClaim> = {}): BranchClaim & {
  readonly phase: 'merge-prep';
  readonly targetBaseOid: GitOid;
} {
  return {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: 'merge-prep',
    issueNumber: 42,
    prNumber: 84,
    attempt: ATTEMPT,
    runner: 'runner-a',
    login: 'implementation-bot',
    expectedHead: OLD_HEAD,
    targetBase: gitRefName('next'),
    targetBaseOid: BASE,
    claimedAt: '2026-07-20T12:00:00.000Z',
    ...overrides,
  } as BranchClaim & { readonly phase: 'merge-prep'; readonly targetBaseOid: GitOid };
}

function manifest(expectedHead: GitOid = CLAIM): AttemptManifest {
  return {
    version: 2,
    attemptId: ATTEMPT,
    runnerId: 'runner-a',
    host: 'host-a',
    phase: 'merge-prep',
    subject: 'pr-84',
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    targetBaseOid: BASE,
    expectedHead,
    claimOid: CLAIM,
    selectedLogin: 'implementation-bot',
    repository: {
      root: '/repo',
      gitCommonDir: '/repo/.git',
      remoteName: 'origin',
      remoteUrlHash: 'a'.repeat(64),
    },
    processState: 'running',
    pid: 4242,
    paths: {
      attemptDir: '/attempt',
      worktree: '/attempt/worktree',
      manifest: '/attempt/manifest.json',
      log: '/attempt/session.log',
      ghConfigDir: '/attempt/gh-config',
      askpass: '/attempt/askpass',
      tokenFile: '/attempt/gh-token',
    },
    timestamps: {
      createdAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T12:01:00.000Z',
      childStartedAt: '2026-07-20T12:01:00.000Z',
    },
  };
}

function harness(options: {
  localHead?: GitOid;
  remoteHead?: GitOid;
  targetBaseOid?: GitOid;
  draft?: boolean;
  classification?: 'mechanical' | 'semantic' | 'codeowner' | 'unproven';
  clean?: boolean;
} = {}) {
  let currentManifest = manifest();
  let localHead = options.localHead ?? PREPARED;
  let draft = options.draft ?? true;
  let project: 'In Review' | 'Human' = 'In Review';
  let labels = new Set(['engine:review']);
  const comments = new Set<string>();
  const events: string[] = [];
  let authority: MergePrepAuthority = {
    remoteHead: options.remoteHead ?? CLAIM,
    latestClaimOid: CLAIM,
    latestClaim: claim(),
    targetBaseOid: options.targetBaseOid ?? BASE,
    pullRequest: {
      number: 84,
      issueNumber: 42,
      head: options.remoteHead ?? CLAIM,
      headRefName: 'autopilot/42',
      baseRefName: 'next',
      draft,
      labels: [...labels],
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      humanHold: false,
      codeownerSensitive: false,
      changedFilesComplete: true,
    },
  };
  const completionClaim = claim({ expectedHead: OLD_HEAD, phaseComplete: true });
  if (options.remoteHead === COMPLETE) {
    authority = {
      ...authority,
      latestClaimOid: COMPLETE,
      latestClaim: completionClaim,
    };
  }
  const port: MergePrepSessionPort = {
    readManifest: () => currentManifest,
    readAuthority: async () => ({
      ...authority,
      pullRequest: {
        ...authority.pullRequest,
        head: authority.remoteHead,
        draft,
        labels: [...labels],
        humanHold: project === 'Human' || labels.has('review:needs-human'),
      },
    }),
    readLocalHead: async () => localHead,
    readLocalStatusClean: async () => options.clean ?? true,
    classifyPreparedResult: async () => options.classification ?? 'mechanical',
    isAncestor: async (_manifest, ancestor, descendant) =>
      ancestor === descendant || (ancestor === BASE && descendant === PREPARED),
    treesDiffer: async () => true,
    readBranchClaim: async (_manifest, oid) => oid === COMPLETE ? completionClaim : null,
    readCompletionSummary: async (_manifest, oid) =>
      oid === COMPLETE ? 'Prepared mechanically' : null,
    createCompletionCommit: async () => {
      events.push('completion-commit');
      localHead = COMPLETE;
      return COMPLETE;
    },
    publishPrepared: async ({ expectedRemoteHead, newHead }) => {
      events.push(`push:${expectedRemoteHead}->${newHead}`);
      if (authority.remoteHead === newHead) {
        return {
          status: 'already-applied',
          expected: expectedRemoteHead,
          published: newHead,
          observed: newHead,
        };
      }
      if (authority.remoteHead !== expectedRemoteHead) {
        return {
          status: 'lost',
          expected: expectedRemoteHead,
          published: newHead,
          observed: authority.remoteHead,
        };
      }
      authority = {
        ...authority,
        remoteHead: newHead,
        latestClaimOid: newHead,
        latestClaim: completionClaim,
      };
      return {
        status: 'won',
        expected: expectedRemoteHead,
        published: newHead,
        observed: newHead,
      };
    },
    advanceManifestHead: (_path, expected, next) => {
      expect(currentManifest.expectedHead).toBe(expected);
      currentManifest = { ...currentManifest, expectedHead: next };
      return currentManifest;
    },
    ensureCompletionSummary: async () => {
      events.push('summary');
    },
    setPullRequestLabel: async (_pr, _head, label, present) => {
      events.push(`label:${label}:${present}`);
      present ? labels.add(label) : labels.delete(label);
    },
    setProjectStatus: async (_issue, _head, status) => {
      events.push(`project:${status}`);
      project = status;
    },
    setPullRequestDraft: async (_pr, _head, value) => {
      events.push(`draft:${value}`);
      draft = value;
    },
    hasHumanComment: async (_pr, _head, marker) => comments.has(marker),
    ensureHumanComment: async (_pr, _head, marker) => {
      events.push('comment');
      comments.add(marker);
    },
  };
  return {
    protocol: makeMergePrepSessionProtocol(port),
    port,
    events,
    authority: () => authority,
    setAuthority: (next: MergePrepAuthority) => {
      authority = next;
    },
  };
}

describe('merge-prep session', () => {
  it('publishes rewritten prepared history with the exact claim lease and makes ready last', async () => {
    const h = harness();
    await expect(
      h.protocol.mergePrepComplete(manifest(), 'Prepared mechanically'),
    ).resolves.toEqual({ status: 'complete', head: COMPLETE });
    expect(h.events).toEqual([
      'completion-commit',
      `push:${CLAIM}->${COMPLETE}`,
      'summary',
      'project:In Review',
      'draft:false',
    ]);
  });

  it('does not require prepared history to descend from the old PR head', async () => {
    const h = harness();
    await expect(
      h.protocol.mergePrepComplete(manifest(), 'Prepared mechanically'),
    ).resolves.toMatchObject({ status: 'complete' });
  });

  it.each([
    ['dirty', { clean: false }],
    ['semantic', { classification: 'semantic' as const }],
    ['CODEOWNER', { classification: 'codeowner' as const }],
    ['unproven', { classification: 'unproven' as const }],
    ['moved-base', { targetBaseOid: MOVED_BASE }],
  ])('preserves local work and publishes nothing for %s preparation', async (_name, options) => {
    const h = harness(options);
    await expect(
      h.protocol.mergePrepComplete(manifest(), 'Prepared mechanically'),
    ).resolves.toMatchObject({ status: 'partial' });
    expect(h.events.some((event) => event.startsWith('push:'))).toBe(false);
  });

  it('fences lease loss and preserves the local completion commit', async () => {
    const h = harness();
    h.port.publishPrepared = async ({ expectedRemoteHead, newHead }) => ({
      status: 'lost',
      expected: expectedRemoteHead,
      published: newHead,
      observed: gitOid('9'.repeat(40)),
    });
    await expect(
      h.protocol.mergePrepComplete(manifest(), 'Prepared mechanically'),
    ).resolves.toEqual({ status: 'partial', head: COMPLETE, pending: 'publication' });
    expect(h.events).toEqual(['completion-commit']);
  });

  it('recovers an already-pushed exact completion and only finishes projections', async () => {
    const h = harness({ localHead: COMPLETE, remoteHead: COMPLETE });
    await expect(
      h.protocol.mergePrepComplete(manifest(), 'Prepared mechanically'),
    ).resolves.toEqual({ status: 'complete', head: COMPLETE });
    expect(h.events).toEqual(['summary', 'project:In Review', 'draft:false']);
  });

  it('stops recovery when the target base moves', async () => {
    const h = harness({ localHead: COMPLETE, remoteHead: COMPLETE, targetBaseOid: MOVED_BASE });
    await expect(
      h.protocol.mergePrepComplete(manifest(), 'Prepared mechanically'),
    ).resolves.toMatchObject({ status: 'partial', pending: 'authority' });
    expect(h.events).toEqual([]);
  });

  it('Human redrafts first, persists exact-head evidence, and never publishes', async () => {
    const h = harness({ draft: false });
    await expect(
      h.protocol.human(manifest(), 'Conflict changes overlapping business logic.'),
    ).resolves.toEqual({ status: 'human', head: CLAIM });
    expect(h.events).toEqual([
      'draft:true',
      'label:review:needs-human:true',
      'comment',
      'project:Human',
    ]);
    expect(h.events.some((event) => event.startsWith('push:'))).toBe(false);
  });
});
