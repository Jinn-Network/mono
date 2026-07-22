// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  makeImplementationSessionProtocol,
  type ImplementationAuthority,
  type ImplementationSessionPort,
} from '../../src/lifecycle/implementation-session.js';
import { gitOid, gitRefName, type BranchClaim, type GitOid } from '../../src/lifecycle/types.js';

const CLAIM = gitOid('1'.repeat(40));
const WORK = gitOid('2'.repeat(40));
const OTHER = gitOid('3'.repeat(40));
const COMPLETE = gitOid('4'.repeat(40));
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

function claim(overrides: Partial<BranchClaim> = {}): BranchClaim {
  return {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: 'implement',
    issueNumber: 42,
    prNumber: 84,
    attempt: ATTEMPT,
    runner: 'runner-a',
    login: 'implementation-bot',
    expectedHead: CLAIM,
    targetBase: gitRefName('next'),
    claimedAt: '2026-07-20T12:00:00.000Z',
    ...overrides,
  };
}

function manifest(expectedHead: GitOid = CLAIM): AttemptManifest {
  return {
    version: 2,
    attemptId: ATTEMPT,
    runnerId: 'runner-a',
    host: 'host-a',
    phase: 'implement',
    subject: 'issue-42',
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    expectedHead,
    claimOid: CLAIM,
    selectedLogin: 'implementation-bot',
    repository: {
      root: '/repo',
      gitCommonDir: '/repo/.git',
      remoteName: 'jinn-autopilot-v2',
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
  expectedHead?: GitOid;
  localHead?: GitOid;
  remoteHead?: GitOid;
  latestClaim?: BranchClaim;
  latestClaimOid?: GitOid;
  realTreeChange?: boolean;
  draft?: boolean;
} = {}) {
  let currentManifest = manifest(options.expectedHead ?? CLAIM);
  let localHead = options.localHead ?? WORK;
  let authority: ImplementationAuthority = {
    remoteHead: options.remoteHead ?? currentManifest.expectedHead as GitOid,
    latestClaimOid: options.latestClaimOid ?? CLAIM,
    latestClaim: options.latestClaim ?? claim(),
  };
  const events: string[] = [];
  const comments = new Set<string>();
  let draft = options.draft ?? true;
  let labels = new Set(['engine:review']);
  let body = `Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->`;
  let completeCommits = 0;

  const port: ImplementationSessionPort = {
    readManifest: () => currentManifest,
    readAuthority: async () => authority,
    readLocalHead: async () => localHead,
    readBranchClaim: async (_manifest, oid) =>
      oid === COMPLETE
        ? claim({ expectedHead: currentManifest.expectedHead as GitOid, phaseComplete: true })
        : oid === CLAIM
          ? claim()
          : null,
    readCompletionSummary: async (_manifest, oid) =>
      oid === COMPLETE ? 'Implementation summary' : null,
    isAncestor: async (_manifest, ancestor, descendant) =>
      ancestor === descendant
      || (ancestor === CLAIM && [WORK, OTHER, COMPLETE].includes(descendant))
      || (ancestor === WORK && descendant === COMPLETE),
    treesDiffer: async () => options.realTreeChange ?? localHead === WORK,
    publishBranch: async ({ expectedRemoteHead, newHead }) => {
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
        remoteHead: newHead,
        latestClaimOid: newHead === COMPLETE ? COMPLETE : authority.latestClaimOid,
        latestClaim: newHead === COMPLETE
          ? claim({ expectedHead: expectedRemoteHead, phaseComplete: true })
          : authority.latestClaim,
      };
      return {
        status: 'won',
        expected: expectedRemoteHead,
        published: newHead,
        observed: newHead,
      };
    },
    advanceManifestHead: (_path, expected, next) => {
      events.push(`manifest:${expected}->${next}`);
      expect(currentManifest.expectedHead).toBe(expected);
      currentManifest = { ...currentManifest, expectedHead: next };
      return currentManifest;
    },
    createCompletionCommit: async ({ parent, completionClaim, summary }) => {
      events.push('completion-commit');
      expect(parent).toBe(currentManifest.expectedHead);
      expect(completionClaim).toMatchObject({
        attempt: ATTEMPT,
        expectedHead: parent,
        phaseComplete: true,
      });
      expect(summary).toBe('Implementation summary');
      completeCommits++;
      localHead = COMPLETE;
      return COMPLETE;
    },
    readPullRequest: async () => ({
      number: 84,
      head: authority.remoteHead,
      headRefName: 'autopilot/42',
      baseRefName: 'next',
      draft,
      labels: [...labels],
      body,
    }),
    readPullRequestHead: async () => authority.remoteHead,
    sleep: async () => {},
    ensureCompletionSummary: async (_pr, expectedHead, summary) => {
      events.push('summary');
      expect(expectedHead).toBe(COMPLETE);
      body = `${body}\n\n<!-- jinn-autopilot:v2 implementation-summary:start -->\n`
        + `${summary}\n<!-- jinn-autopilot:v2 implementation-summary:end -->`;
    },
    setPullRequestLabel: async (_pr, expectedHead, label, present) => {
      events.push(`label:${label}:${present}`);
      expect(expectedHead).toBe(authority.remoteHead);
      if (present) labels.add(label);
      else labels.delete(label);
    },
    setPullRequestDraft: async (_pr, expectedHead, nextDraft) => {
      events.push(`draft:${nextDraft}`);
      expect(expectedHead).toBe(authority.remoteHead);
      draft = nextDraft;
    },
    hasHumanComment: async (_pr, expectedHead, marker) => {
      expect(expectedHead).toBe(authority.remoteHead);
      return comments.has(marker);
    },
    ensureHumanComment: async (_pr, expectedHead, marker) => {
      events.push('human-comment');
      expect(expectedHead).toBe(authority.remoteHead);
      comments.add(marker);
    },
  };
  return {
    port,
    protocol: makeImplementationSessionProtocol(port),
    events,
    get manifest() { return currentManifest; },
    get authority() { return authority; },
    set authority(next: ImplementationAuthority) { authority = next; },
    get localHead() { return localHead; },
    set localHead(next: GitOid) { localHead = next; },
    get completeCommits() { return completeCommits; },
    get draft() { return draft; },
    get labels() { return labels; },
    get comments() { return comments; },
    get body() { return body; },
  };
}

describe('implementation session protocol', () => {
  it('checkpoints one real tree change through the exact expected-head lease', async () => {
    const h = harness();

    await expect(h.protocol.checkpoint(h.manifest)).resolves.toEqual({
      status: 'published',
      head: WORK,
    });

    expect(h.events).toEqual([
      `push:${CLAIM}->${WORK}`,
      `manifest:${CLAIM}->${WORK}`,
    ]);
    expect(h.manifest.expectedHead).toBe(WORK);
  });

  it('rejects empty or synthetic checkpoint commits', async () => {
    const h = harness({ realTreeChange: false });

    await expect(h.protocol.checkpoint(h.manifest))
      .rejects.toThrow(/real tree/i);
    expect(h.events).toEqual([]);
  });

  it('stops a stale writer without publishing or mutating PR and Project state', async () => {
    const h = harness({ remoteHead: OTHER });

    await expect(h.protocol.checkpoint(h.manifest)).resolves.toEqual({
      status: 'stale',
      head: OTHER,
    });
    expect(h.events).toEqual([]);
  });

  it.each([
    ['missing lifecycle marker', {
      body: 'Closes #42',
    }],
    ['changed branch', {
      headRefName: 'other/42',
    }],
    ['changed base', {
      baseRefName: 'release/next',
    }],
    ['prematurely ready', {
      draft: false,
    }],
  ])('rejects checkpoint publication when the PR has %s', async (_label, override) => {
    const h = harness();
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => ({
      ...await read(...args),
      ...override,
    });

    await expect(h.protocol.checkpoint(h.manifest)).rejects.toThrow(/pull request/i);
    expect(h.events).toEqual([]);
  });

  it('revalidates exact Human authority between ordered PR mutations', async () => {
    const h = harness({ localHead: CLAIM, realTreeChange: false, draft: false });
    h.labels.delete('engine:review');
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => ({
      ...await read(...args),
      ...(h.events.includes('draft:true') ? { baseRefName: 'release/next' } : {}),
    });

    await expect(
      h.protocol.human(h.manifest, 'A semantic decision is required.'),
    ).rejects.toThrow(/pull request authority/i);
    expect(h.events).toEqual(['draft:true']);
  });

  it('retains the progressive manifest head when push readback remains ambiguous', async () => {
    const h = harness();
    h.port.publishBranch = async ({ expectedRemoteHead, newHead }) => ({
      status: 'ambiguous',
      expected: expectedRemoteHead,
      published: newHead,
      observed: null,
    });

    await expect(h.protocol.checkpoint(h.manifest)).resolves.toEqual({
      status: 'ambiguous',
      head: WORK,
    });
    expect(h.manifest.expectedHead).toBe(CLAIM);
    expect(h.events).toEqual([]);
  });

  it('pushes a durable completion marker and makes ready the final mutation', async () => {
    // Stage 1 three-op finalize: summary → engine:review label → undraft.
    // Project Status is painter-owned and never written here.
    const h = harness();

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({ status: 'complete', head: COMPLETE });

    expect(h.completeCommits).toBe(1);
    expect(h.manifest.expectedHead).toBe(COMPLETE);
    expect(h.draft).toBe(false);
    expect(h.events.at(-1)).toBe('draft:false');
    expect(h.events).toEqual([
      `push:${CLAIM}->${WORK}`,
      `manifest:${CLAIM}->${WORK}`,
      'completion-commit',
      `push:${WORK}->${COMPLETE}`,
      `manifest:${WORK}->${COMPLETE}`,
      'summary',
      'draft:false',
    ]);
    expect(h.events).not.toContain('project:In Review');
  });

  it('converges finalization when the PR record lags the marker push instead of aborting', async () => {
    // jinn-mono#1883 live bug: the completion marker's git push wins
    // instantly (ls-remote is current the moment the push returns), but the
    // very next read of the PR *record* (`gh pr view`) still reports the
    // pre-push head, because that API replicates with up to a few seconds
    // of lag. The old single-shot read treated that lag as the PR having
    // changed and aborted to partial before ever attempting the summary/
    // label/draft/status projection. Two lagging reads followed by a
    // caught-up read must still reach `complete` in one call.
    const h = harness();
    let reads = 0;
    const sleeps: number[] = [];
    h.port.readPullRequestHead = async () => {
      reads += 1;
      return reads <= 2 ? WORK : COMPLETE;
    };
    h.port.sleep = async (ms) => { sleeps.push(ms); };

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({ status: 'complete', head: COMPLETE });

    expect(reads).toBe(3);
    expect(sleeps).toEqual([1000, 1000]);
    expect(h.draft).toBe(false);
    expect(h.draft).toBe(false);
  });

  it('fails closed immediately when the PR record shows a foreign head, without retrying', async () => {
    const h = harness();
    let reads = 0;
    const sleeps: number[] = [];
    h.port.readPullRequestHead = async () => {
      reads += 1;
      return OTHER;
    };
    h.port.sleep = async (ms) => { sleeps.push(ms); };

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toMatchObject({
      status: 'partial',
      head: COMPLETE,
      pending: 'ready',
      detail: expect.stringContaining('foreign write'),
    });

    expect(reads).toBe(1);
    expect(sleeps).toHaveLength(0);
    expect(h.completeCommits).toBe(1);
    expect(h.events).not.toContain('summary');
  });

  it('returns partial with a surfaced detail when replication never resolves', async () => {
    const h = harness();
    let reads = 0;
    const sleeps: number[] = [];
    h.port.readPullRequestHead = async () => {
      reads += 1;
      return WORK;
    };
    h.port.sleep = async (ms) => { sleeps.push(ms); };

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toMatchObject({
      status: 'partial',
      head: COMPLETE,
      pending: 'ready',
      detail: expect.stringContaining('has not caught up'),
    });

    expect(reads).toBe(3);
    expect(sleeps).toEqual([1000, 1000]);
    expect(h.events).not.toContain('summary');
  });

  it('revalidates the draft PR authority before creating a completion marker', async () => {
    const h = harness({ localHead: CLAIM, realTreeChange: false });
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => ({
      ...await read(...args),
      baseRefName: 'release/next',
    });

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).rejects.toThrow(/pull request/i);
    expect(h.events).not.toContain('completion-commit');
  });

  it('restores a prematurely-ready completion PR to draft before projections', async () => {
    const h = harness({
      expectedHead: COMPLETE,
      localHead: COMPLETE,
      remoteHead: COMPLETE,
      latestClaimOid: COMPLETE,
      latestClaim: claim({ expectedHead: WORK, phaseComplete: true }),
      realTreeChange: false,
      draft: false,
    });

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({ status: 'complete', head: COMPLETE });

    expect(h.events).toContain('draft:true');
    expect(h.events.indexOf('draft:true')).toBeLessThan(h.events.indexOf('summary'));
    expect(h.events.at(-1)).toBe('draft:false');
  });

  it.each([
    // failingEvent, pending phase, draft state left behind by the failure.
    // Stage 3: Project Status is painter-owned; completion is summary → label → undraft.
    ['summary', 'summary', true],
    ['draft:false', 'ready', true],
  ] as const)(
    'returns a recoverable partial result when %s fails and converges on retry',
    async (failingEvent, pending, draftAfterFailure) => {
      const h = harness();
      const original = {
        summary: h.port.ensureCompletionSummary,
        ready: h.port.setPullRequestDraft,
      };
      let failed = false;
      if (failingEvent === 'summary') {
        h.port.ensureCompletionSummary = async (...args) => {
          if (!failed) {
            failed = true;
            h.events.push('summary');
            throw new Error('injected');
          }
          return original.summary(...args);
        };
      } else {
        h.port.setPullRequestDraft = async (...args) => {
          if (!failed) {
            failed = true;
            h.events.push('draft:false');
            throw new Error('injected');
          }
          return original.ready(...args);
        };
      }

      await expect(
        h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
      ).resolves.toEqual({
        status: 'partial',
        head: COMPLETE,
        pending,
        detail: 'injected',
      });
      expect(h.completeCommits).toBe(1);
      expect(h.draft).toBe(draftAfterFailure);

      await expect(
        h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
      ).resolves.toEqual({ status: 'complete', head: COMPLETE });
      expect(h.completeCommits).toBe(1);
      expect(h.draft).toBe(false);
      expect(h.draft).toBe(false);
      expect(h.events.at(-1)).toBe('draft:false');
    },
  );

  it('finalizes to non-draft without writing Project Status', async () => {
    const h = harness();
    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({ status: 'complete', head: COMPLETE });
    expect(h.draft).toBe(false);
    expect(h.events).toContain('draft:false');
    expect(h.events).not.toContain('project:In Review');
  });

  it('lets a Human hold that appears after the label block stop the undraft, leaving the PR draft', async () => {
    const h = harness();
    h.labels.delete('engine:review');
    const setLabel = h.port.setPullRequestLabel;
    h.port.setPullRequestLabel = async (...args) => {
      await setLabel(...args);
      h.labels.add('review:needs-human');
    };
    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({ status: 'partial', head: COMPLETE, pending: 'hold' });
    expect(h.labels).toContain('engine:review');
    expect(h.draft).toBe(true);
    expect(h.events).not.toContain('draft:false');
  });

  it('recognizes an already-pushed exact completion marker idempotently', async () => {
    const h = harness({
      expectedHead: COMPLETE,
      localHead: COMPLETE,
      remoteHead: COMPLETE,
      latestClaimOid: COMPLETE,
      latestClaim: claim({ expectedHead: WORK, phaseComplete: true }),
      realTreeChange: false,
    });

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({ status: 'complete', head: COMPLETE });
    expect(h.completeCommits).toBe(0);
    expect(h.events).not.toContain('completion-commit');
  });

  it('converges through replication lag on a resumed phase-complete retry before projecting', async () => {
    // Same PR-record-lag scenario as the fresh-marker case, but on the
    // resumed-session path: the marker is already on the branch (this is a
    // retry), and `authority.latestClaim.expectedHead` -- the completion
    // claim's own recorded parent -- is the exact pre-marker head this
    // convergence wait needs to tell lag apart from a foreign change.
    const h = harness({
      expectedHead: COMPLETE,
      localHead: COMPLETE,
      remoteHead: COMPLETE,
      latestClaimOid: COMPLETE,
      latestClaim: claim({ expectedHead: WORK, phaseComplete: true }),
      realTreeChange: false,
    });
    let reads = 0;
    h.port.readPullRequestHead = async () => {
      reads += 1;
      return reads <= 2 ? WORK : COMPLETE;
    };

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({ status: 'complete', head: COMPLETE });
    expect(reads).toBe(3);
    expect(h.completeCommits).toBe(0);
  });

  it('retries the same local completion marker after an ambiguous push without treating it as a heartbeat', async () => {
    const h = harness({ localHead: WORK, remoteHead: WORK, expectedHead: WORK });
    const publish = h.port.publishBranch;
    let ambiguous = true;
    h.port.publishBranch = async (input) => {
      if (input.newHead === COMPLETE && ambiguous) {
        ambiguous = false;
        return {
          status: 'ambiguous',
          expected: input.expectedRemoteHead,
          published: input.newHead,
          observed: null,
        };
      }
      return publish(input);
    };

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({
      status: 'partial',
      head: COMPLETE,
      pending: 'marker',
    });
    expect(h.manifest.expectedHead).toBe(WORK);
    expect(h.completeCommits).toBe(1);

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({ status: 'complete', head: COMPLETE });
    expect(h.completeCommits).toBe(1);
    expect(h.manifest.expectedHead).toBe(COMPLETE);
  });

  it('converges through replication lag on the localHead-republish path after an ambiguous marker push', async () => {
    // Same lag scenario again, but on the retry of an ambiguously-pushed
    // marker: `manifest.expectedHead` before the republish (captured as
    // `prePublishHead`) is the exact pre-marker head this convergence wait
    // needs.
    const h = harness({ localHead: WORK, remoteHead: WORK, expectedHead: WORK });
    const publish = h.port.publishBranch;
    let ambiguous = true;
    h.port.publishBranch = async (input) => {
      if (input.newHead === COMPLETE && ambiguous) {
        ambiguous = false;
        return {
          status: 'ambiguous',
          expected: input.expectedRemoteHead,
          published: input.newHead,
          observed: null,
        };
      }
      return publish(input);
    };

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({
      status: 'partial',
      head: COMPLETE,
      pending: 'marker',
    });

    let reads = 0;
    h.port.readPullRequestHead = async () => {
      reads += 1;
      return reads <= 2 ? WORK : COMPLETE;
    };

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({ status: 'complete', head: COMPLETE });
    expect(reads).toBe(3);
    expect(h.completeCommits).toBe(1);
    expect(h.manifest.expectedHead).toBe(COMPLETE);
  });

  it('revalidates exact PR authority immediately before retrying an ambiguous marker', async () => {
    const h = harness({ localHead: WORK, remoteHead: WORK, expectedHead: WORK });
    let ambiguous = true;
    let markerPushes = 0;
    const publish = h.port.publishBranch;
    h.port.publishBranch = async (input) => {
      if (input.newHead === COMPLETE) markerPushes += 1;
      if (input.newHead === COMPLETE && ambiguous) {
        ambiguous = false;
        return {
          status: 'ambiguous',
          expected: input.expectedRemoteHead,
          published: input.newHead,
          observed: null,
        };
      }
      return publish(input);
    };

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toMatchObject({ status: 'partial', pending: 'marker' });
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => ({
      ...await read(...args),
      baseRefName: 'release/next',
    });

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).rejects.toThrow(/pull request authority/i);
    expect(markerPushes).toBe(1);
  });

  it('places exact PR revalidation after durable-summary recovery on marker retry', async () => {
    const h = harness({ localHead: WORK, remoteHead: WORK, expectedHead: WORK });
    const publish = h.port.publishBranch;
    let ambiguous = true;
    h.port.publishBranch = async (input) => {
      if (input.newHead === COMPLETE && ambiguous) {
        ambiguous = false;
        return {
          status: 'ambiguous',
          expected: input.expectedRemoteHead,
          published: input.newHead,
          observed: null,
        };
      }
      return publish(input);
    };
    await h.protocol.implementationComplete(h.manifest, 'Implementation summary');

    const audit: string[] = [];
    let beforeRetryPush: string[] = [];
    const readPullRequest = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => {
      audit.push('pr');
      return readPullRequest(...args);
    };
    const readCompletionSummary = h.port.readCompletionSummary;
    h.port.readCompletionSummary = async (...args) => {
      audit.push('summary');
      return readCompletionSummary(...args);
    };
    h.port.publishBranch = async (input) => {
      if (input.newHead === COMPLETE) beforeRetryPush = [...audit, 'push'];
      return publish(input);
    };

    await h.protocol.implementationComplete(h.manifest, 'Implementation summary');

    expect(beforeRetryPush.slice(-3)).toEqual(['summary', 'pr', 'push']);
  });

  it('treats review:needs-human label as dominant over implementation completion', async () => {
    const h = harness({
      localHead: CLAIM,
      realTreeChange: false,
    });
    h.labels.add('review:needs-human');
    await expect(
      h.protocol.implementationComplete(h.manifest, 'Implementation summary'),
    ).resolves.toEqual({ status: 'partial', head: CLAIM, pending: 'hold' });
    expect(h.completeCommits).toBe(0);
    expect(h.draft).toBe(true);
    expect(h.events).not.toContain('draft:false');
  });

  it('uses the exact completion commit summary on retry instead of changed file contents', async () => {
    const h = harness({
      expectedHead: COMPLETE,
      localHead: COMPLETE,
      remoteHead: COMPLETE,
      latestClaimOid: COMPLETE,
      latestClaim: claim({ expectedHead: WORK, phaseComplete: true }),
      realTreeChange: false,
    });
    Object.assign(h.port, {
      readCompletionSummary: async () => 'Implementation summary',
    });

    await expect(
      h.protocol.implementationComplete(h.manifest, 'Changed retry summary'),
    ).rejects.toThrow(/durable summary/i);
    expect(h.body).not.toContain('Changed retry summary');
  });

  it('persists one structured Human hold idempotently and remains draft', async () => {
    const h = harness({ localHead: CLAIM, realTreeChange: false });

    await expect(
      h.protocol.human(h.manifest, 'A semantic decision is required.'),
    ).resolves.toEqual({ status: 'human', head: CLAIM });
    await expect(
      h.protocol.human(h.manifest, 'A semantic decision is required.'),
    ).resolves.toEqual({ status: 'human', head: CLAIM });

    expect(h.draft).toBe(true);
    expect(h.draft).toBe(true);
    expect(h.labels).toContain('review:needs-human');
    expect(h.comments.size).toBe(1);
    expect(h.events).not.toContain('draft:false');
  });

  it.each([
    ['PR number', { number: 85 }],
    ['head', { head: OTHER }],
    ['branch', { headRefName: 'other/42' }],
    ['base', { baseRefName: 'release/next' }],
    ['lifecycle marker', { body: 'Closes #42' }],
  ])('rejects a Human hold when exact %s authority changed', async (_name, override) => {
    const h = harness({ localHead: CLAIM, realTreeChange: false });
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => ({
      ...await read(...args),
      ...override,
    });

    await expect(
      h.protocol.human(h.manifest, 'A semantic decision is required.'),
    ).rejects.toThrow(/pull request authority/i);
    expect(h.events).toEqual([]);
  });

});
