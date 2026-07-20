import { describe, expect, it } from 'vitest';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  executeReviewAction,
  type ReviewActionCandidate,
  type ReviewExecutorDeps,
} from '../../src/lifecycle/review-executor.js';
import {
  gitOid,
  gitRefName,
  type GitOid,
  type ReviewClaimRecord,
} from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const OLD_HEAD = gitOid('2'.repeat(40));
const RECORD_A = gitOid('3'.repeat(40));
const RECORD_B = gitOid('4'.repeat(40));
const OLD_RECORD = gitOid('5'.repeat(40));
const ATTEMPT_A = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_B = '22222222-2222-4222-8222-222222222222';
const GENERATION_A = '33333333-3333-4333-8333-333333333333';
const GENERATION_B = '44444444-4444-4444-8444-444444444444';

function pool(
  entries: ConstructorParameters<typeof CredentialPool>[0] = [{
    login: 'review-bot',
    normalizedLogin: 'review-bot',
    reviewToken: 'review-secret',
  }],
): CredentialPool {
  return new CredentialPool(entries);
}

function claim(overrides: Partial<ReviewClaimRecord> = {}): ReviewClaimRecord {
  return {
    kind: 'review-claim',
    protocolVersion: 2,
    prNumber: 84,
    generation: GENERATION_A,
    attempt: ATTEMPT_A,
    reviewer: 'review-bot',
    head: HEAD,
    state: 'active',
    recordedAt: '2026-07-20T08:00:00.000Z',
    ...overrides,
  } as ReviewClaimRecord;
}

function candidate(overrides: Partial<ReviewActionCandidate> = {}): ReviewActionCandidate {
  return {
    issueNumber: 42,
    number: 84,
    open: true,
    head: HEAD,
    headChangedAt: '2026-07-20T08:00:00.000Z',
    headRefName: gitRefName('autopilot/42'),
    baseRefName: gitRefName('next'),
    draft: false,
    author: 'implementation-bot',
    labels: ['engine:review'],
    body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
    humanHold: false,
    approvalPolicy: 'approve-eligible',
    nativeReviews: [],
    ...overrides,
  };
}

function harness(overrides: Partial<ReviewExecutorDeps> = {}) {
  const events: string[] = [];
  const records: ReviewClaimRecord[] = [];
  const human: unknown[] = [];
  let attemptIndex = 0;
  let generationIndex = 0;
  const attempts = [ATTEMPT_A, ATTEMPT_B];
  const generations = [GENERATION_A, GENERATION_B];
  const deps: ReviewExecutorDeps = {
    readCandidate: async () => candidate(),
    credentials: pool(),
    createReviewRecord: async ({ record }) => {
      events.push('record');
      records.push(record);
      return record.attempt === ATTEMPT_A ? RECORD_A : RECORD_B;
    },
    publishReviewClaim: async ({ recordOid, expectedRemoteRecordOid }) => {
      events.push('claim');
      return {
        status: 'won',
        expected: expectedRemoteRecordOid,
        published: recordOid,
        observed: recordOid,
      };
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
    repairProjection: async () => {
      events.push('projection');
    },
    spawnCoordinator: (input) => {
      events.push('spawn');
      expect(input.environment.GH_TOKEN).toBe('review-secret');
      expect(input.environment.GITHUB_TOKEN).toBeUndefined();
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
    ambientEnvironment: { PATH: '/usr/bin', GITHUB_TOKEN: 'ambient-secret' },
    nextAttemptId: () => attempts[attemptIndex++]!,
    nextGeneration: () => generations[generationIndex++]!,
    runnerId: 'runner-a',
    now: () => new Date('2026-07-20T12:00:00.000Z'),
    staleAfterMs: 2 * 60 * 60_000,
    ...overrides,
  };
  return { deps, events, records, human };
}

describe('review action executor', () => {
  it('elects exactly one absent-ref contender and starts only the exact read-back winner', async () => {
    const h = harness();
    let current: GitOid | null = null;
    h.deps.publishReviewClaim = async ({ recordOid, expectedRemoteRecordOid }) => {
      h.events.push('claim');
      if (current !== expectedRemoteRecordOid) {
        return {
          status: 'lost',
          expected: expectedRemoteRecordOid,
          published: recordOid,
          observed: current,
        };
      }
      current = recordOid;
      return {
        status: 'won',
        expected: expectedRemoteRecordOid,
        published: recordOid,
        observed: recordOid,
      };
    };

    const [first, second] = await Promise.all([
      executeReviewAction({ prNumber: 84 }, h.deps),
      executeReviewAction({ prNumber: 84 }, h.deps),
    ]);

    expect([first.status, second.status].sort()).toEqual(['lost', 'spawned']);
    expect(h.events.filter((event) => event === 'spawn')).toHaveLength(1);
    expect(h.events.filter((event) => event === 'attempt')).toHaveLength(1);
    expect(h.events.indexOf('claim')).toBeLessThan(h.events.indexOf('spawn'));
  });

  it('accepts an ambiguous publish only when exact ref read-back proves the candidate won', async () => {
    const exact = harness({
      publishReviewClaim: async ({ recordOid, expectedRemoteRecordOid }) => ({
        status: 'already-applied',
        expected: expectedRemoteRecordOid,
        published: recordOid,
        observed: recordOid,
      }),
    });
    await expect(executeReviewAction({ prNumber: 84 }, exact.deps))
      .resolves.toMatchObject({ status: 'spawned', reviewRefOid: RECORD_A });

    const unknown = harness({
      publishReviewClaim: async ({ recordOid, expectedRemoteRecordOid }) => ({
        status: 'ambiguous',
        expected: expectedRemoteRecordOid,
        published: recordOid,
        observed: null,
      }),
    });
    await expect(executeReviewAction({ prNumber: 84 }, unknown.deps))
      .resolves.toEqual({ status: 'ambiguous', prNumber: 84 });
    expect(unknown.events).not.toContain('spawn');
  });

  it('replaces a stale generation append-only and fences the late loser', async () => {
    const stale = candidate({
      draft: true,
      reviewRef: { oid: OLD_RECORD, record: claim({ state: 'fixing' }) },
    });
    const h = harness({ readCandidate: async () => stale });

    const result = await executeReviewAction({ prNumber: 84 }, h.deps);

    expect(result).toMatchObject({ status: 'spawned', recoverFixes: true });
    expect(h.records[0]).toMatchObject({
      state: 'active',
      prNumber: 84,
      head: HEAD,
      reviewer: 'review-bot',
    });
    expect(h.deps.createReviewRecord).toBeDefined();

    const late = harness({
      readCandidate: async () => stale,
      publishReviewClaim: async ({ recordOid }) => ({
        status: 'lost',
        expected: OLD_RECORD,
        published: recordOid,
        observed: RECORD_A,
      }),
    });
    await expect(executeReviewAction({ prNumber: 84 }, late.deps))
      .resolves.toEqual({ status: 'lost', prNumber: 84 });
    expect(late.events).not.toContain('spawn');
  });

  it('does not claim a current non-stale generation', async () => {
    const h = harness({
      readCandidate: async () => candidate({
        headChangedAt: '2026-07-20T11:30:00.000Z',
        reviewRef: { oid: OLD_RECORD, record: claim() },
      }),
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toMatchObject({ status: 'ineligible', detail: expect.stringMatching(/active/i) });
    expect(h.events).toEqual([]);
  });

  it('selects a single reviewer distinct from the author and permits one-credential review', async () => {
    const h = harness({
      credentials: pool([{
        login: 'one-bot',
        normalizedLogin: 'one-bot',
        implementationToken: 'one-secret',
      }]),
      readCandidate: async () => candidate({ author: 'someone-else' }),
      spawnCoordinator: (input) => {
        expect(input.environment.GH_TOKEN).toBe('one-secret');
        return { pid: 42 };
      },
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toMatchObject({ status: 'spawned', reviewer: 'one-bot' });
    expect(h.records[0]?.reviewer).toBe('one-bot');
  });

  it('requires the prior reviewer for stale draft fix recovery or enters structured Human', async () => {
    const h = harness({
      credentials: pool([{
        login: 'replacement-bot',
        normalizedLogin: 'replacement-bot',
        reviewToken: 'replacement-secret',
      }]),
      readCandidate: async () => candidate({
        draft: true,
        reviewRef: {
          oid: OLD_RECORD,
          record: claim({ reviewer: 'missing-reviewer', state: 'fixing' }),
        },
      }),
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toEqual({
        status: 'human',
        prNumber: 84,
        code: 'reviewer-identity-unavailable',
      });
    expect(h.human).toEqual([expect.objectContaining({
      reason: expect.objectContaining({ code: 'reviewer-identity-unavailable' }),
    })]);
    expect(h.events).toEqual([]);
  });

  it('fails contradictory mapping, Human evidence, self-review, and wrong draft policy closed', async () => {
    const cases: ReviewActionCandidate[] = [
      candidate({ issueNumber: 43 }),
      candidate({ humanHold: true }),
      candidate({ author: 'review-bot' }),
      candidate({ draft: true }),
      candidate({ open: false }),
      candidate({ body: '<!-- malformed -->' }),
    ];
    for (const current of cases) {
      const h = harness({ readCandidate: async () => current });
      const result = await executeReviewAction({ prNumber: 84 }, h.deps);
      expect(result.status).not.toBe('spawned');
      expect(h.events).not.toContain('spawn');
    }
  });

  it('binds attempt authority and approval policy before projection and runtime spawn', async () => {
    let attempt: Parameters<ReviewExecutorDeps['createAttempt']>[0] | undefined;
    const h = harness({
      readCandidate: async () => candidate({ approvalPolicy: 'human-codeowner' }),
      createAttempt: async (input) => {
        attempt = input;
        return {
          attemptId: input.attemptId,
          paths: {
            worktree: '/tmp/review/worktree',
            manifest: '/tmp/review/manifest.json',
            log: '/tmp/review/session.log',
            ghConfigDir: '/tmp/review/gh',
            askpass: '/tmp/review/askpass',
          },
        };
      },
      spawnCoordinator: (input) => {
        h.events.push('spawn');
        expect(input.environment.GH_TOKEN).toBe('review-secret');
        expect(input.environment.JINN_AUTOPILOT_SESSION_MANIFEST)
          .toBe('/tmp/review/manifest.json');
        return { pid: 42 };
      },
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toMatchObject({ status: 'spawned', approvalPolicy: 'human-codeowner' });
    expect(attempt).toMatchObject({
      issueNumber: 42,
      prNumber: 84,
      branch: 'autopilot/42',
      targetBase: 'next',
      expectedHead: HEAD,
      claimOid: RECORD_A,
      reviewGeneration: GENERATION_A,
      reviewRefOid: RECORD_A,
      approvalPolicy: 'human-codeowner',
      selectedLogin: 'review-bot',
    });
    expect(h.events.indexOf('projection')).toBeGreaterThan(h.events.indexOf('claim'));
    expect(h.events.indexOf('spawn')).toBeGreaterThan(h.events.indexOf('projection'));
  });

  it('does not re-review a matching terminal approval, but may claim a terminal older head', async () => {
    const terminal = claim({
      state: 'terminal-approved',
      verdict: { state: 'APPROVE', marker: '55555555-5555-4555-8555-555555555555' },
    });
    const same = harness({
      readCandidate: async () => candidate({
        reviewRef: { oid: OLD_RECORD, record: terminal },
        nativeReviews: [{
          reviewer: 'review-bot',
          state: 'APPROVED',
          commitId: HEAD,
          body: 'matching marker',
          submittedAt: '2026-07-20T09:00:00.000Z',
        }],
        terminalApprovalMatches: true,
      }),
    });
    await expect(executeReviewAction({ prNumber: 84 }, same.deps))
      .resolves.toEqual({ status: 'already-approved', prNumber: 84, head: HEAD });

    const older = harness({
      readCandidate: async () => candidate({
        reviewRef: {
          oid: OLD_RECORD,
          record: { ...terminal, head: OLD_HEAD },
        },
      }),
    });
    await expect(executeReviewAction({ prNumber: 84 }, older.deps))
      .resolves.toMatchObject({ status: 'spawned' });
    expect(older.records[0]?.head).toBe(HEAD);
  });
});
