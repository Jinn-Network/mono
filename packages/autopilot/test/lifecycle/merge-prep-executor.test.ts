import { describe, expect, it } from 'vitest';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  executeMergePrepAction,
  type MergePrepCandidate,
  type MergePrepExecutorDeps,
} from '../../src/lifecycle/merge-prep-executor.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
  type GitOid,
} from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const BASE = gitOid('2'.repeat(40));
const CLAIM_A = gitOid('3'.repeat(40));
const CLAIM_B = gitOid('4'.repeat(40));
const ATTEMPT_A = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_B = '22222222-2222-4222-8222-222222222222';

function candidate(overrides: Partial<MergePrepCandidate> = {}): MergePrepCandidate {
  return {
    issueNumber: 42,
    prNumber: 84,
    open: true,
    head: HEAD,
    headRefName: gitRefName('autopilot/42'),
    baseRefName: gitRefName('next'),
    targetBaseOid: BASE,
    draft: false,
    labels: ['engine:review'],
    body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
    humanHold: false,
    terminalApprovalMatches: true,
    mergeState: 'behind',
    codeownerSensitive: false,
    changedFilesComplete: true,
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

function harness(overrides: Partial<MergePrepExecutorDeps> = {}) {
  const events: string[] = [];
  const claims: BranchClaim[] = [];
  const claimByOid = new Map<GitOid, BranchClaim>();
  let attemptIndex = 0;
  const attemptIds = [ATTEMPT_A, ATTEMPT_B];
  const deps: MergePrepExecutorDeps = {
    readCandidate: async () => candidate(),
    confirmAuthority: async ({ claimOid }) => candidate({
      head: claimOid,
      draft: true,
      terminalApprovalMatches: false,
      branchClaim: claimByOid.get(claimOid),
    }),
    credentials: pool(),
    remoteUrl: 'https://github.com/Jinn-Network/mono.git',
    createClaimCommit: async ({ claim }) => {
      claims.push(claim);
      const oid = claim.attempt === ATTEMPT_A ? CLAIM_A : CLAIM_B;
      claimByOid.set(oid, claim);
      return oid;
    },
    claimBranch: async ({ expectedRemoteHead, claimOid }) => {
      events.push('claim');
      return {
        status: 'won',
        expected: expectedRemoteHead,
        published: claimOid,
        observed: claimOid,
      };
    },
    repairProjection: async () => {
      events.push('projection');
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
      return { pid: 4242 };
    },
    trackChild: () => events.push('track'),
    escalateHuman: async () => {
      events.push('human');
    },
    ambientEnvironment: { GITHUB_TOKEN: 'ambient-secret' },
    nextAttemptId: () => attemptIds[attemptIndex++]!,
    runnerId: 'runner-a',
    now: () => new Date('2026-07-20T12:00:00.000Z'),
    sleep: async () => {},
    ...overrides,
  };
  return { deps, events, claims };
}

describe('merge-prep action executor', () => {
  it('elects one exact-head contender and only the winner creates a child', async () => {
    const h = harness();
    let remote: GitOid = HEAD;
    h.deps.claimBranch = async ({ expectedRemoteHead, claimOid }) => {
      h.events.push('claim');
      if (remote !== expectedRemoteHead) {
        return {
          status: 'lost',
          expected: expectedRemoteHead,
          published: claimOid,
          observed: remote,
        };
      }
      remote = claimOid;
      return {
        status: 'won',
        expected: expectedRemoteHead,
        published: claimOid,
        observed: claimOid,
      };
    };

    const [first, second] = await Promise.all([
      executeMergePrepAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
      executeMergePrepAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ]);

    expect([first.status, second.status].sort()).toEqual(['lost', 'spawned']);
    expect(h.events.filter((event) => event === 'spawn')).toHaveLength(1);
    expect(h.claims[0]).toMatchObject({
      phase: 'merge-prep',
      expectedHead: HEAD,
      targetBaseOid: BASE,
    });
  });

  it('accepts an ambiguous claim response only after exact winning readback', async () => {
    const h = harness({
      claimBranch: async ({ expectedRemoteHead, claimOid }) => ({
        status: 'already-applied',
        expected: expectedRemoteHead,
        published: claimOid,
        observed: claimOid,
      }),
    });

    await expect(
      executeMergePrepAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ).resolves.toMatchObject({ status: 'spawned', claimOid: CLAIM_A });
  });

  it('reclaims stale prep only through a new claim from the exact current head', async () => {
    const h = harness({
      readCandidate: async () => candidate({
        branchClaim: {
          kind: 'branch-claim',
          protocolVersion: 2,
          phase: 'merge-prep',
          issueNumber: 42,
          prNumber: 84,
          attempt: ATTEMPT_B,
          runner: 'dead-runner',
          login: 'implementation-bot',
          expectedHead: gitOid('9'.repeat(40)),
          targetBase: gitRefName('next'),
          targetBaseOid: BASE,
          claimedAt: '2026-07-20T08:00:00.000Z',
        },
        head: HEAD,
        draft: true,
      }),
    });

    await executeMergePrepAction({
      prNumber: 84,
      expectedHead: HEAD,
      recoverStale: true,
    }, h.deps);
    expect(h.claims[0]?.expectedHead).toBe(HEAD);
  });

  it('does not replace an existing merge-prep claim without stale recovery authority', async () => {
    const existing = {
      kind: 'branch-claim' as const,
      protocolVersion: 2 as const,
      phase: 'merge-prep' as const,
      issueNumber: 42,
      prNumber: 84,
      attempt: ATTEMPT_B,
      runner: 'live-runner',
      login: 'implementation-bot',
      expectedHead: gitOid('9'.repeat(40)),
      targetBase: gitRefName('next'),
      targetBaseOid: BASE,
      claimedAt: '2026-07-20T11:30:00.000Z',
    };
    const h = harness({
      readCandidate: async () => candidate({
        branchClaim: existing,
        draft: true,
      }),
    });

    await expect(executeMergePrepAction({
      prNumber: 84,
      expectedHead: HEAD,
    }, h.deps)).resolves.toMatchObject({ status: 'ineligible' });
    expect(h.events).toEqual([]);
  });

  it('stops without a local attempt when the target base moves after claim', async () => {
    const h = harness({
      confirmAuthority: async ({ claimOid }) => candidate({
        head: claimOid,
        targetBaseOid: gitOid('8'.repeat(40)),
        draft: true,
      }),
    });

    await expect(
      executeMergePrepAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ).resolves.toMatchObject({ status: 'lost', reason: 'target-base-changed' });
    expect(h.events).toEqual(['claim', 'projection']);
  });

  it('confirms a won merge-prep claim through replication lag instead of orphaning it', async () => {
    // jinn-mono#1925-style regression for merge-prep: the claim commit won
    // its exact-lease branch push, but the very next GraphQL PR read still
    // reported the pre-push head. A second read shows our claim commit as
    // the head. The claim must be confirmed and the session spawned, not
    // orphaned as lost.
    let confirmations = 0;
    const sleeps: number[] = [];
    const h = harness({
      confirmAuthority: async ({ claimOid }) => {
        confirmations += 1;
        if (confirmations === 1) return candidate();
        return candidate({
          head: claimOid,
          draft: true,
          terminalApprovalMatches: false,
          branchClaim: h.claims.at(-1),
        });
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await expect(
      executeMergePrepAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ).resolves.toMatchObject({ status: 'spawned', claimOid: CLAIM_A });
    // Two confirmMergePrepAuthority calls happen in the success path
    // (post-win, post-attempt-creation); the first one needed one retry.
    expect(confirmations).toBe(3);
    expect(sleeps).toHaveLength(1);
  });

  it('fails closed immediately on a foreign merge-prep branch head, without retrying', async () => {
    let confirmations = 0;
    const sleeps: number[] = [];
    const h = harness({
      confirmAuthority: async () => {
        confirmations += 1;
        return candidate({ head: gitOid('9'.repeat(40)), draft: true });
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await expect(
      executeMergePrepAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ).resolves.toMatchObject({ status: 'lost', reason: 'authority-changed' });
    expect(confirmations).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it('returns ambiguous, not lost, when merge-prep replication lag never resolves within the retry budget', async () => {
    let confirmations = 0;
    const sleeps: number[] = [];
    const h = harness({
      confirmAuthority: async () => {
        confirmations += 1;
        return candidate();
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await expect(
      executeMergePrepAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ).resolves.toEqual({ status: 'ambiguous', prNumber: 84 });
    expect(confirmations).toBe(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it.each([
    ['draft', { draft: true }],
    ['Human', { humanHold: true }],
    ['approval', { terminalApprovalMatches: false }],
    ['merge-state', { mergeState: 'clean' as const }],
    ['CODEOWNERS', { codeownerSensitive: true }],
    ['changed-files', { changedFilesComplete: false }],
  ])('fails closed before claiming for %s ineligibility', async (_name, override) => {
    const h = harness({ readCandidate: async () => candidate(override) });
    await expect(
      executeMergePrepAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ).resolves.toMatchObject({ status: 'ineligible' });
    expect(h.events).toEqual([]);
  });

  it('orders redraft/projection before local attempt and final authority before spawn', async () => {
    const h = harness();
    h.deps.confirmAuthority = async ({ claimOid }) => {
      h.events.push('authority');
      return candidate({
        head: claimOid,
        draft: true,
        terminalApprovalMatches: false,
        branchClaim: h.claims.at(-1),
      });
    };

    await executeMergePrepAction({ prNumber: 84, expectedHead: HEAD }, h.deps);
    expect(h.events).toEqual([
      'claim',
      'projection',
      'authority',
      'attempt',
      'authority',
      'spawn',
      'track',
    ]);
  });
});
