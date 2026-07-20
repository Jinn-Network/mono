import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  executeImplementationAction,
  runCanonicalImplementationRealityCheck,
  type ImplementationExecutorDeps,
  type ImplementationIssue,
  type ImplementationPullRequest,
} from '../../src/lifecycle/implementation-executor.js';
import {
  makeImplementationSessionProtocol,
  type ImplementationSessionPort,
} from '../../src/lifecycle/implementation-session.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
  type ClaimOutcome,
  type GitOid,
} from '../../src/lifecycle/types.js';

const BASE = gitOid('1'.repeat(40));
const CLAIM_A = gitOid('2'.repeat(40));
const CLAIM_B = gitOid('3'.repeat(40));
const ADOPTED_HEAD = gitOid('4'.repeat(40));
const WORK = gitOid('5'.repeat(40));
const ATTEMPT_A = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_B = '22222222-2222-4222-8222-222222222222';
const HTTPS_REMOTE = 'https://github.com/Jinn-Network/mono.git';

function issue(overrides: Partial<ImplementationIssue> = {}): ImplementationIssue {
  return {
    number: 42,
    title: 'Implement exact lifecycle ownership',
    open: true,
    eligible: true,
    targetBase: gitRefName('next'),
    effort: 'High',
    ...overrides,
  };
}

function pr(overrides: Partial<ImplementationPullRequest> = {}): ImplementationPullRequest {
  return {
    number: 84,
    headRefName: gitRefName('existing/issue-42'),
    head: ADOPTED_HEAD,
    baseRefName: gitRefName('next'),
    draft: true,
    labels: ['engine:review'],
    body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=existing/issue-42 -->',
    ...overrides,
  };
}

function pool(): CredentialPool {
  return new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'selected-secret',
  }]);
}

function claimOutcome(
  status: ClaimOutcome['status'],
  published: GitOid,
  observed: GitOid | null = published,
): ClaimOutcome {
  return {
    status,
    expected: null,
    published,
    observed,
  };
}

function harness(overrides: Partial<ImplementationExecutorDeps> = {}) {
  const events: string[] = [];
  const claims: Array<{
    branch: string;
    candidateParent: GitOid;
    expectedRemoteHead: GitOid | null;
    claimOid: GitOid;
    remoteUrl: string;
    login: string;
  }> = [];
  const human: unknown[] = [];
  let attemptIndex = 0;
  const attemptIds = [ATTEMPT_A, ATTEMPT_B];
  const deps: ImplementationExecutorDeps = {
    readIssue: async () => issue(),
    runRealityCheck: async () => ({
      classification: 'clear',
      evidence: {},
      suggestedBlockedOn: null,
      suggestedComment: null,
    }),
    listOpenPullRequests: async () => [],
    credentials: pool(),
    remoteUrl: HTTPS_REMOTE,
    readTargetBaseHead: async () => BASE,
    createClaimCommit: async ({ attempt }) => attempt === ATTEMPT_A ? CLAIM_A : CLAIM_B,
    claimBranch: async (input) => {
      events.push('claim');
      claims.push(input);
      return claimOutcome('won', input.claimOid);
    },
    ensureDraftPullRequest: async (input) => {
      events.push('pr');
      return pr({
        number: 84,
        headRefName: input.branch,
        head: input.claimOid,
        baseRefName: input.targetBase,
        body: input.body,
      });
    },
    setProjectInProgress: async () => {
      events.push('project');
    },
    createAttempt: async (input) => {
      events.push('attempt');
      return {
        attemptId: input.attemptId,
        paths: {
          worktree: `/tmp/${input.attemptId}/worktree`,
          manifest: `/tmp/${input.attemptId}/manifest.json`,
          log: `/tmp/${input.attemptId}/session.log`,
          ghConfigDir: `/tmp/${input.attemptId}/gh-config`,
          askpass: `/tmp/${input.attemptId}/askpass`,
        },
      };
    },
    spawnCoordinator: (input) => {
      events.push('spawn');
      expect(input.environment.GH_TOKEN).toBe('selected-secret');
      expect(input.environment.GITHUB_TOKEN).toBeUndefined();
      expect(input.environment.GIT_SSH_COMMAND).toBe('false');
      expect(input.environment.JINN_AUTOPILOT_SESSION_MANIFEST)
        .toBe(`/tmp/${input.attemptId}/manifest.json`);
      return { pid: 4242 };
    },
    trackChild: () => {
      events.push('track');
    },
    escalateHuman: async (input) => {
      human.push(input);
    },
    ambientEnvironment: {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ambient-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    },
    nextAttemptId: () => attemptIds[attemptIndex++]!,
    runnerId: 'runner-a',
    now: () => new Date('2026-07-20T12:00:00.000Z'),
    ...overrides,
  };
  return { deps, events, claims, human };
}

describe('implementation action executor', () => {
  it('exposes the canonical gather-and-classify reality check for production injection', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const verdict = await runCanonicalImplementationRealityCheck(
      42,
      async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'git' && args.includes('fetch')) return '';
        if (cmd === 'gh' && args.includes('search')) return '[]';
        if (cmd === 'gh' && args.includes('issue')) {
          return '{"closedByPullRequestsReferences":[]}';
        }
        if (cmd === 'git' && args.includes('log')) return '';
        throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
      },
    );

    expect(verdict.classification).toBe('clear');
    expect(calls[0]).toMatchObject({ cmd: 'git', args: expect.arrayContaining(['fetch']) });
  });

  it('elects one concurrent claim, creates one draft PR, and spawns one child', async () => {
    const shared = harness();
    let remoteHead: GitOid | null = null;
    shared.deps.claimBranch = async (input) => {
      shared.events.push('claim');
      shared.claims.push(input);
      if (remoteHead !== null) {
        return {
          status: 'lost',
          expected: input.expectedRemoteHead,
          published: input.claimOid,
          observed: remoteHead,
        };
      }
      remoteHead = input.claimOid;
      return {
        status: 'won',
        expected: input.expectedRemoteHead,
        published: input.claimOid,
        observed: input.claimOid,
      };
    };

    const [first, second] = await Promise.all([
      executeImplementationAction({ issueNumber: 42 }, shared.deps),
      executeImplementationAction({ issueNumber: 42 }, shared.deps),
    ]);

    expect([first.status, second.status].sort()).toEqual(['lost', 'spawned']);
    expect(shared.claims).toHaveLength(2);
    expect(shared.events.filter((event) => event === 'pr')).toHaveLength(1);
    expect(shared.events.filter((event) => event === 'spawn')).toHaveLength(1);
    expect(shared.events.indexOf('pr')).toBeLessThan(shared.events.indexOf('attempt'));
    expect(shared.events.indexOf('pr')).toBeLessThan(shared.events.indexOf('spawn'));
  });

  it('uses the stable branch and exact claim metadata for brand-new work', async () => {
    const { deps, claims, events } = harness();

    const result = await executeImplementationAction({ issueNumber: 42 }, deps);

    expect(result).toMatchObject({
      status: 'spawned',
      issueNumber: 42,
      prNumber: 84,
      branch: 'autopilot/42',
      claimOid: CLAIM_A,
      attemptId: ATTEMPT_A,
    });
    expect(claims).toEqual([expect.objectContaining({
      branch: 'autopilot/42',
      candidateParent: BASE,
      expectedRemoteHead: null,
      claimOid: CLAIM_A,
      remoteUrl: HTTPS_REMOTE,
      login: 'implementation-bot',
    })]);
    expect(events).toEqual(['claim', 'pr', 'project', 'attempt', 'spawn', 'track']);
  });

  it('carries a brand-new executor claim into an authoritative session checkpoint', async () => {
    let initialClaim: BranchClaim | undefined;
    let createdAttempt: Parameters<ImplementationExecutorDeps['createAttempt']>[0] | undefined;
    const { deps } = harness({
      createClaimCommit: async ({ claim }) => {
        initialClaim = claim;
        return CLAIM_A;
      },
      createAttempt: async (input) => {
        createdAttempt = input;
        return {
          attemptId: input.attemptId,
          paths: {
            worktree: '/tmp/new-branch/worktree',
            manifest: '/tmp/new-branch/manifest.json',
            log: '/tmp/new-branch/session.log',
            ghConfigDir: '/tmp/new-branch/gh-config',
            askpass: '/tmp/new-branch/askpass',
          },
        };
      },
      spawnCoordinator: () => ({ pid: 4242 }),
    });
    await expect(executeImplementationAction({ issueNumber: 42 }, deps))
      .resolves.toMatchObject({ status: 'spawned', prNumber: 84 });
    expect(initialClaim).not.toHaveProperty('prNumber');

    const manifest: AttemptManifest = {
      version: 2,
      attemptId: createdAttempt!.attemptId,
      runnerId: 'runner-a',
      host: 'host-a',
      phase: 'implement',
      subject: 'issue-42',
      issueNumber: 42,
      prNumber: createdAttempt!.prNumber,
      branch: createdAttempt!.branch,
      targetBase: createdAttempt!.targetBase,
      expectedHead: CLAIM_A,
      claimOid: CLAIM_A,
      selectedLogin: createdAttempt!.selectedLogin,
      repository: {
        root: '/repo',
        gitCommonDir: '/repo/.git',
        remoteName: 'jinn-autopilot-v2',
        remoteUrlHash: 'a'.repeat(64),
      },
      processState: 'running',
      pid: 4242,
      paths: {
        attemptDir: '/tmp/new-branch',
        worktree: '/tmp/new-branch/worktree',
        manifest: '/tmp/new-branch/manifest.json',
        log: '/tmp/new-branch/session.log',
        ghConfigDir: '/tmp/new-branch/gh-config',
        askpass: '/tmp/new-branch/askpass',
      },
      timestamps: {
        createdAt: '2026-07-20T12:00:00.000Z',
        updatedAt: '2026-07-20T12:01:00.000Z',
        childStartedAt: '2026-07-20T12:01:00.000Z',
      },
    };
    let progressiveHead = CLAIM_A;
    const port: ImplementationSessionPort = {
      readManifest: () => ({ ...manifest, expectedHead: progressiveHead }),
      readAuthority: async () => ({
        remoteHead: CLAIM_A,
        latestClaimOid: CLAIM_A,
        latestClaim: initialClaim!,
      }),
      readLocalHead: async () => WORK,
      readBranchClaim: async () => null,
      readCompletionSummary: async () => null,
      isAncestor: async (_manifest, ancestor, descendant) =>
        ancestor === descendant || (ancestor === CLAIM_A && descendant === WORK),
      treesDiffer: async () => true,
      publishBranch: async ({ expectedRemoteHead, newHead }) => ({
        status: 'won',
        expected: expectedRemoteHead,
        published: newHead,
        observed: newHead,
      }),
      advanceManifestHead: (_path, _expected, next) => {
        progressiveHead = next;
        return { ...manifest, expectedHead: next };
      },
      createCompletionCommit: async () => {
        throw new Error('not used');
      },
      readPullRequest: async () => ({
        number: 84,
        head: CLAIM_A,
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        draft: true,
        labels: ['engine:review'],
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      }),
      ensureCompletionSummary: async () => {},
      setPullRequestLabel: async () => {},
      setProjectStatus: async () => {},
      readProjectStatus: async () => 'In Progress',
      setPullRequestDraft: async () => {},
      hasHumanComment: async () => false,
      ensureHumanComment: async () => {},
    };

    await expect(makeImplementationSessionProtocol(port).checkpoint(manifest))
      .resolves.toEqual({ status: 'published', head: WORK });
  });

  it('adopts one unambiguous open PR branch unchanged', async () => {
    const adopted = pr();
    const { deps, claims } = harness({
      listOpenPullRequests: async () => [adopted],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: adopted.number },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Open PR exists.',
      }),
    });

    const result = await executeImplementationAction({ issueNumber: 42 }, deps);

    expect(result).toMatchObject({
      status: 'spawned',
      branch: adopted.headRefName,
      prNumber: adopted.number,
    });
    expect(claims[0]).toMatchObject({
      branch: adopted.headRefName,
      candidateParent: adopted.head,
      expectedRemoteHead: adopted.head,
    });
  });

  it('does not claim missing, ineligible, or resolved work', async () => {
    const cases: Array<Partial<ImplementationExecutorDeps>> = [
      { readIssue: async () => null },
      { readIssue: async () => issue({ eligible: false }) },
      {
        runRealityCheck: async () => ({
          classification: 'fixed-on-trunk',
          evidence: { sha: BASE, branch: 'next' },
          suggestedBlockedOn: 'Human',
          suggestedComment: 'Already fixed.',
        }),
      },
    ];

    for (const override of cases) {
      const { deps, claims, events } = harness(override);
      await expect(executeImplementationAction({ issueNumber: 42 }, deps))
        .resolves.toMatchObject({ status: 'ineligible' });
      expect(claims).toEqual([]);
      expect(events).toEqual([]);
    }
  });

  it('escalates contradictory branch mappings without a claim', async () => {
    const { deps, claims, human } = harness({
      listOpenPullRequests: async () => [
        pr(),
        pr({ number: 85, headRefName: gitRefName('other/issue-42') }),
      ],
    });

    await expect(executeImplementationAction({ issueNumber: 42 }, deps))
      .resolves.toMatchObject({ status: 'human', code: 'branch-mapping-ambiguous' });
    expect(claims).toEqual([]);
    expect(human).toEqual([expect.objectContaining({
      issueNumber: 42,
      reason: expect.objectContaining({
        phase: 'eligible',
        code: 'branch-mapping-ambiguous',
      }),
    })]);
  });

  it('escalates multiple open PRs before applying the pr-open reality verdict', async () => {
    const existing = pr();
    const { deps, claims, human } = harness({
      listOpenPullRequests: async () => [
        existing,
        pr({ number: 85, headRefName: gitRefName('other/issue-42') }),
      ],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: existing.number },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Open PR exists.',
      }),
    });

    await expect(executeImplementationAction({ issueNumber: 42 }, deps))
      .resolves.toMatchObject({ status: 'human', code: 'branch-mapping-ambiguous' });
    expect(claims).toEqual([]);
    expect(human).toHaveLength(1);
  });

  it('escalates a sole mapped PR that contradicts canonical pr-open reality evidence', async () => {
    const mapped = pr({ number: 85 });
    const { deps, claims, human } = harness({
      listOpenPullRequests: async () => [mapped],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: 84 },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Canonical reality evidence names PR #84.',
      }),
    });

    await expect(executeImplementationAction({ issueNumber: 42 }, deps))
      .resolves.toMatchObject({ status: 'human', code: 'branch-mapping-ambiguous' });
    expect(claims).toEqual([]);
    expect(human).toEqual([expect.objectContaining({
      issueNumber: 42,
      reason: expect.objectContaining({
        phase: 'eligible',
        code: 'branch-mapping-ambiguous',
        detail: expect.stringMatching(/PR #84.*PR #85/),
      }),
    })]);
  });

  it('escalates when canonical pr-open reality has no bounded PR mapping', async () => {
    const { deps, claims, events, human } = harness({
      listOpenPullRequests: async () => [],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: 84 },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Canonical reality evidence names PR #84.',
      }),
    });

    await expect(executeImplementationAction({ issueNumber: 42 }, deps))
      .resolves.toMatchObject({ status: 'human', code: 'branch-mapping-ambiguous' });
    expect(claims).toEqual([]);
    expect(events).toEqual([]);
    expect(human).toEqual([expect.objectContaining({
      issueNumber: 42,
      reason: expect.objectContaining({
        phase: 'eligible',
        code: 'branch-mapping-ambiguous',
        detail: expect.stringMatching(/PR #84.*no open PR/),
      }),
    })]);
  });

  it('preserves structural PR ambiguity as Human before ordinary eligibility', async () => {
    let realityChecks = 0;
    const { deps, claims, human } = harness({
      readIssue: async () => issue({ eligible: false }),
      runRealityCheck: async () => {
        realityChecks += 1;
        return {
          classification: 'fixed-on-trunk',
          evidence: { sha: BASE, branch: 'next' },
          suggestedBlockedOn: 'Human',
          suggestedComment: 'Already fixed.',
        };
      },
      listOpenPullRequests: async () => [
        pr(),
        pr({ number: 85, headRefName: gitRefName('other/issue-42') }),
      ],
    });

    await expect(executeImplementationAction({ issueNumber: 42 }, deps))
      .resolves.toMatchObject({ status: 'human', code: 'branch-mapping-ambiguous' });
    expect(realityChecks).toBe(1);
    expect(claims).toEqual([]);
    expect(human).toHaveLength(1);
  });

  it('fails closed when target-base authority changes after the claim', async () => {
    let reads = 0;
    const { deps, events } = harness({
      readIssue: async () => reads++ === 0
        ? issue()
        : issue({ targetBase: gitRefName('release/next') }),
    });

    await expect(executeImplementationAction({ issueNumber: 42 }, deps))
      .resolves.toMatchObject({
        status: 'partial',
        code: 'target-base-changed',
        claimOid: CLAIM_A,
      });
    expect(events).toEqual(['claim']);
  });

  it('fails closed when the claim result remains ambiguous', async () => {
    const { deps, events } = harness({
      claimBranch: async (input) => ({
        status: 'ambiguous',
        expected: input.expectedRemoteHead,
        published: input.claimOid,
        observed: null,
      }),
    });

    await expect(executeImplementationAction({ issueNumber: 42 }, deps))
      .resolves.toMatchObject({ status: 'ambiguous' });
    expect(events).toEqual([]);
  });
});
