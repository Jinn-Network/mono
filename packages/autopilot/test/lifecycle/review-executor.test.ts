// @ts-nocheck — Stage 5 leftover fixtures for deleted review-fix recovery.
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
    confirmAcquisition: async ({ expectedHead, expectedReviewRefOid }) => candidate({
      head: expectedHead,
      reviewRef: {
        oid: expectedReviewRefOid,
        record: claim(),
      },
    }),
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
    sleep: async () => {},
    ...overrides,
  };
  return { deps, events, records, human };
}

describe('review action executor', () => {
  it.skip('fails closed when the scheduled exact head changes before acquisition', async () => {
    const { deps, events } = harness();

    await expect(executeReviewAction({
      prNumber: 84,
      expectedHead: gitOid('9'.repeat(40)),
      recoverFixes: false,
    }, deps)).resolves.toMatchObject({
      status: 'ineligible',
      detail: 'Pull request head changed after scheduling.',
    });
    expect(events).toEqual([]);
  });

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

  it.skip('replaces a stale generation append-only and fences the late loser', async () => {
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

  it('does not reclaim a freshly won active generation just because the PR head is old', async () => {
    // Same livelock this executor must not reintroduce: a claim's own
    // acquisition time -- not just the PR head time -- must gate whether it
    // still holds an active generation, aligned with staleEvidence in
    // lifecycle.ts.
    const h = harness({
      readCandidate: async () => candidate({
        headChangedAt: '2026-07-20T08:00:00.000Z',
        reviewRef: {
          oid: OLD_RECORD,
          record: claim({ recordedAt: '2026-07-20T11:59:00.000Z' }),
        },
      }),
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toMatchObject({ status: 'ineligible', detail: expect.stringMatching(/active/i) });
    expect(h.events).toEqual([]);
  });

  it('fails closed when a current active claim carries a future acquisition timestamp', async () => {
    const h = harness({
      readCandidate: async () => candidate({
        headChangedAt: '2026-07-20T08:00:00.000Z',
        reviewRef: {
          oid: OLD_RECORD,
          record: claim({ recordedAt: '2026-07-20T12:00:00.001Z' }),
        },
      }),
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toMatchObject({
        status: 'ineligible',
        detail: expect.stringMatching(/acquisition timestamp/i),
      });
    expect(h.events).toEqual([]);
  });

  it('repairs a current-head Human record and never reaps or reclaims it', async () => {
    const h = harness({
      readCandidate: async () => candidate({
        reviewRef: {
          oid: OLD_RECORD,
          record: claim({ state: 'human' }),
        },
      }),
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toEqual({
        status: 'human',
        prNumber: 84,
        code: 'review-escalation',
      });
    expect(h.human).toHaveLength(1);
    expect(h.events).toEqual([]);
  });

  it('repairs the Human projection when the snapshot already exposes the hold', async () => {
    const h = harness({
      readCandidate: async () => candidate({
        humanHold: true,
        reviewRef: {
          oid: OLD_RECORD,
          record: claim({ state: 'human' }),
        },
      }),
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toEqual({
        status: 'human',
        prNumber: 84,
        code: 'review-escalation',
      });
    expect(h.human).toHaveLength(1);
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
      confirmAcquisition: async ({ expectedHead, expectedReviewRefOid }) => candidate({
        author: 'someone-else',
        head: expectedHead,
        reviewRef: {
          oid: expectedReviewRefOid,
          record: claim({ reviewer: 'one-bot' }),
        },
      }),
      spawnCoordinator: (input) => {
        expect(input.environment.GH_TOKEN).toBe('one-secret');
        return { pid: 42 };
      },
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toMatchObject({ status: 'spawned', reviewer: 'one-bot' });
    expect(h.records[0]?.reviewer).toBe('one-bot');
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
      confirmAcquisition: async ({ expectedHead, expectedReviewRefOid }) => candidate({
        approvalPolicy: 'human-codeowner',
        head: expectedHead,
        reviewRef: {
          oid: expectedReviewRefOid,
          record: claim(),
        },
      }),
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

  it('re-reads exact ref, head, and Human authority after projection before spawn', async () => {
    let confirmations = 0;
    const h = harness({
      confirmAcquisition: async () => {
        confirmations += 1;
        return candidate({
          humanHold: true,
          reviewRef: { oid: RECORD_A, record: claim() },
        });
      },
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toMatchObject({ status: 'human' });
    expect(confirmations).toBe(1);
    expect(h.events).not.toContain('spawn');
  });

  it('does not spawn when final acquisition readback loses exact ref or head authority', async () => {
    for (const final of [
      candidate({ reviewRef: { oid: RECORD_B, record: claim() } }),
      candidate({ head: OLD_HEAD, reviewRef: { oid: RECORD_A, record: claim({ head: OLD_HEAD }) } }),
    ]) {
      const h = harness({
        confirmAcquisition: async () => final,
      });

      const result = await executeReviewAction({ prNumber: 84 }, h.deps);
      expect(result.status).not.toBe('spawned');
      expect(h.events).not.toContain('spawn');
    }
  });

  it('confirms a won review claim through replication lag instead of orphaning it', async () => {
    // jinn-mono#1925 live bug: the review-claim ref push won its exact-lease
    // race (git-protocol readback and repairProjection's own ls-remote both
    // proved it), but the very next GraphQL snapshot read still reported
    // the pre-push state (no review ref, since this is a first-ever claim
    // with a null parent). A second read shows our record. The claim must
    // be confirmed and the session spawned, not orphaned as lost.
    let confirmations = 0;
    const sleeps: number[] = [];
    const h = harness({
      confirmAcquisition: async ({ expectedHead }) => {
        confirmations += 1;
        if (confirmations === 1) return candidate({ head: expectedHead });
        return candidate({
          head: expectedHead,
          reviewRef: { oid: RECORD_A, record: claim() },
        });
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toMatchObject({ status: 'spawned', reviewRefOid: RECORD_A });
    expect(confirmations).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(h.events).toContain('spawn');
  });

  it('fails closed immediately on a foreign review-claim ref, without retrying', async () => {
    let confirmations = 0;
    const sleeps: number[] = [];
    const h = harness({
      confirmAcquisition: async ({ expectedHead }) => {
        confirmations += 1;
        return candidate({
          head: expectedHead,
          reviewRef: { oid: RECORD_B, record: claim({ attempt: ATTEMPT_B }) },
        });
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toEqual({ status: 'lost', prNumber: 84 });
    expect(confirmations).toBe(1);
    expect(sleeps).toHaveLength(0);
    expect(h.events).not.toContain('spawn');
  });

  it('returns ambiguous, not lost, when replication lag never resolves within the retry budget', async () => {
    let confirmations = 0;
    const sleeps: number[] = [];
    const h = harness({
      confirmAcquisition: async ({ expectedHead }) => {
        confirmations += 1;
        return candidate({ head: expectedHead });
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await expect(executeReviewAction({ prNumber: 84 }, h.deps))
      .resolves.toEqual({ status: 'ambiguous', prNumber: 84 });
    expect(confirmations).toBe(3);
    expect(sleeps).toEqual([1000, 1000]);
    expect(h.events).not.toContain('spawn');
  });

  it('never spawns without an observed-equals-ours review-ref confirmation (fencing guard)', async () => {
    const scenarios: Array<ReviewExecutorDeps['confirmAcquisition']> = [
      // Foreign OID -- immediate loss, no amount of retrying should spawn.
      async ({ expectedHead }) => candidate({
        head: expectedHead,
        reviewRef: { oid: RECORD_B, record: claim() },
      }),
      // Perpetually pre-push -- exhausts the retry budget without ever
      // observing our record.
      async ({ expectedHead }) => candidate({ head: expectedHead }),
      // The exact OID we published, but the decoded record disagrees with
      // it on a field git's content-addressing guarantees can't actually
      // diverge for a real remote -- defense in depth must still refuse.
      async ({ expectedHead }) => candidate({
        head: expectedHead,
        reviewRef: { oid: RECORD_A, record: claim({ generation: GENERATION_B }) },
      }),
    ];
    for (const confirmAcquisition of scenarios) {
      const h = harness({ confirmAcquisition });
      const result = await executeReviewAction({ prNumber: 84 }, h.deps);
      expect(result.status).not.toBe('spawned');
      expect(h.events).not.toContain('spawn');
    }
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
