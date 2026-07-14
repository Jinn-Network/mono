import { describe, it, expect } from 'vitest';
import { deriveInFlight } from '../../src/dispatcher/state.js';
import { sessionLogPath } from '../../src/dispatcher/session-log.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type {
  ProjectSnapshot,
  SnapshotItem,
} from '../../src/dispatcher/project-snapshot.js';

/**
 * Fixtures matching the post-#585 data flow:
 * - `ProjectSnapshot` is fetched once per cycle by the orchestrator and
 *   passed in (used to come from `gh project item-list` inside this fn).
 * - `git worktree list --porcelain` is still parsed via the runner.
 *
 * Real `git worktree list --porcelain` output shape (observed 2026-05-21):
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<branch>   ← present for checked-out branch
 *   detached                     ← present instead of branch for detached HEAD
 *   <blank line between blocks>
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Issue #418: In Progress on the board — has a matching worktree → in-flight. */
const ISSUE_IN_PROGRESS_WITH_WORKTREE = 418;

/** Issue #501: In Progress on the board — no matching worktree → drift warning. */
const ISSUE_IN_PROGRESS_NO_WORKTREE = 501;

/** The jinn-mono_worktrees/<N> worktree that has no In Progress issue → drift warning. */
const ORPHAN_WORKTREE_ISSUE = 399;

const REPO_ROOT = '/Users/adrianobradley/jinn-mono';
const WORKTREES_BASE = '/Users/adrianobradley/jinn-mono_worktrees';

function snapshotItem(overrides: Partial<SnapshotItem> & Pick<SnapshotItem, 'id' | 'number'>): SnapshotItem {
  return {
    contentType: 'Issue',
    status: null,
    priority: null,
    effort: null,
    blockedOn: null,
    issueType: null,
    blockedByIssues: [],
    sprintIterationId: null,
    ...overrides,
  };
}

const SNAPSHOT: ProjectSnapshot = {
  items: [
    // Issue 418 — In Progress, has a worktree → in-flight
    snapshotItem({
      id: 'PVTI_aaa',
      number: ISSUE_IN_PROGRESS_WITH_WORKTREE,
      contentType: 'Issue',
      status: 'In Progress',
      priority: 'P1',
      effort: 'Medium',
      blockedOn: 'Nothing',
      issueType: 'feat',
    }),
    // Issue 501 — In Progress but no jinn-mono_worktrees/501 worktree exists → drift
    snapshotItem({
      id: 'PVTI_bbb',
      number: ISSUE_IN_PROGRESS_NO_WORKTREE,
      contentType: 'Issue',
      status: 'In Progress',
      priority: 'P2',
      effort: 'Low',
      blockedOn: 'Nothing',
      issueType: 'fix',
    }),
    // Issue in a different status — should be ignored
    snapshotItem({
      id: 'PVTI_ccc',
      number: 900,
      contentType: 'Issue',
      status: 'Todo',
      priority: 'P2',
      effort: 'Low',
      blockedOn: 'Nothing',
      issueType: 'chore',
    }),
  ],
  rateLimit: { remaining: 4999, used: 1, resetAt: '2026-05-25T16:00:00Z' },
  currentSprintIterationId: null,
};

/**
 * Canned git worktree list --porcelain output.
 *
 * Contains:
 *   - the main worktree (not a jinn-mono_worktrees path — ignored)
 *   - a detached worktree (ignored — no branch)
 *   - jinn-mono_worktrees/418  (matches In Progress issue 418 → in-flight)
 *   - jinn-mono_worktrees/399  (no In Progress issue 399 → drift warning)
 */
const WORKTREE_PORCELAIN = [
  // Main worktree — not a jinn-mono_worktrees path
  `worktree ${REPO_ROOT}`,
  'HEAD cdecb61a1f4e1274bda7ab6bb626cca6c465d86e',
  'branch refs/heads/main',
  '',
  // Detached worktree — no branch line, ignored
  `worktree /private/tmp/jinn-pr-review`,
  'HEAD 61822d46e6dd10063c5aeb1cabe1214b968422e3',
  'detached',
  '',
  // jinn-mono_worktrees/418 — matches In Progress issue 418
  `worktree ${WORKTREES_BASE}/418`,
  'HEAD abc123def456abc123def456abc123def456abc1',
  'branch refs/heads/feat/418-something-useful',
  '',
  // jinn-mono_worktrees/399 — orphan: no In Progress issue 399
  `worktree ${WORKTREES_BASE}/399`,
  'HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  'branch refs/heads/fix/399-old-thing',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Fake runner
// ---------------------------------------------------------------------------

function makeFakeRunner(): CommandRunner {
  return async (cmd: string, args: string[]): Promise<string> => {
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
      // git worktree list --porcelain
      return WORKTREE_PORCELAIN;
    }
    // Post-#585: deriveInFlight no longer calls `gh` — Project board state
    // arrives via the snapshot argument, not via the runner.
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveInFlight', () => {
  it('returns one InFlightSession for an In Progress issue with a matching worktree', async () => {
    const { inFlight } = await deriveInFlight(SNAPSHOT, makeFakeRunner());

    expect(inFlight).toHaveLength(1);
    const session = inFlight[0];
    expect(session.issueNumber).toBe(ISSUE_IN_PROGRESS_WITH_WORKTREE);
    expect(session.worktreePath).toBe(`${WORKTREES_BASE}/${ISSUE_IN_PROGRESS_WITH_WORKTREE}`);
    expect(session.branch).toBe('feat/418-something-useful');
    expect(session.pid).toBeNull();
    // #533: recovered sessions are stamped with their canonical per-session log path.
    expect(session.logPath).toBe(sessionLogPath(ISSUE_IN_PROGRESS_WITH_WORKTREE));
    // startedAt is either a real timestamp recovered from the worktree directory (> 0)
    // or the unknown-age sentinel (0) when the fixture path does not exist on disk.
    // Both are valid — the WallClock guards against startedAt <= 0.
    expect(typeof session.startedAt).toBe('number');
  });

  it('surfaces an In Progress issue with no matching worktree as a drift warning', async () => {
    const { drift } = await deriveInFlight(SNAPSHOT, makeFakeRunner());

    const driftForMissingWorktree = drift.find((d) =>
      d.includes(String(ISSUE_IN_PROGRESS_NO_WORKTREE)),
    );
    expect(driftForMissingWorktree).toBeDefined();
  });

  it('surfaces an orphan jinn-mono_worktrees worktree (no In Progress issue) as a drift warning', async () => {
    const { drift } = await deriveInFlight(SNAPSHOT, makeFakeRunner());

    const driftForOrphanWorktree = drift.find((d) =>
      d.includes(String(ORPHAN_WORKTREE_ISSUE)),
    );
    expect(driftForOrphanWorktree).toBeDefined();
  });

  it('does not include Todo or other non-In-Progress issues in in-flight or drift', async () => {
    const { inFlight, drift } = await deriveInFlight(SNAPSHOT, makeFakeRunner());

    // Issue 900 is Todo — not in-flight
    const inFlight900 = inFlight.find((s) => s.issueNumber === 900);
    expect(inFlight900).toBeUndefined();

    // Issue 900 should not appear in drift either (it's just not In Progress)
    const drift900 = drift.find((d) => d.includes('900'));
    expect(drift900).toBeUndefined();
  });

  it('normal case: issue #418 In Progress + jinn-mono_worktrees/418 worktree → one InFlightSession', async () => {
    const { inFlight, drift } = await deriveInFlight(SNAPSHOT, makeFakeRunner());

    // Exactly the matched pair
    const session = inFlight.find((s) => s.issueNumber === ISSUE_IN_PROGRESS_WITH_WORKTREE);
    expect(session).toBeDefined();
    expect(session!.issueNumber).toBe(418);
    expect(session!.worktreePath).toContain('jinn-mono_worktrees/418');
    expect(session!.branch).toBe('feat/418-something-useful');
    expect(session!.pid).toBeNull();
    // startedAt: either recovered from the directory (> 0) or the unknown-age
    // sentinel (0) when the fixture path does not exist on disk. Both are valid.
    expect(typeof session!.startedAt).toBe('number');

    // The drift entries are the two mismatches (501 and 399), not 418
    expect(drift).toHaveLength(2);
    expect(drift.some((d) => d.includes('418'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Escalated (Blocked on: Human) sessions must not hold a concurrency slot.
//
// Regression for the slot-leak: an escalated session keeps Status "In Progress"
// (there is no parked Status) and retains its worktree so a human can resume
// it. Before the fix, deriveInFlight counted it as in-flight, so N escalations
// permanently consumed N concurrency slots and eventually froze the dispatcher
// (observed live 2026-06-13: 5 escalations wedged a cap-5 loop). An escalated
// issue is a *parked* session: NOT in-flight (its slot is free) and NOT drift
// (its worktree is expected, retained for resume).
// ---------------------------------------------------------------------------

const ESCALATED_ISSUE = 777; // In Progress + Blocked on: Human + worktree → parked
const ACTIVE_ISSUE = 778; // In Progress + Blocked on: Nothing + worktree → in-flight

const ESCALATION_SNAPSHOT: ProjectSnapshot = {
  items: [
    snapshotItem({
      id: 'PVTI_esc',
      number: ESCALATED_ISSUE,
      contentType: 'Issue',
      status: 'In Progress',
      blockedOn: 'Human',
      issueType: 'feat',
    }),
    snapshotItem({
      id: 'PVTI_act',
      number: ACTIVE_ISSUE,
      contentType: 'Issue',
      status: 'In Progress',
      blockedOn: 'Nothing',
      issueType: 'fix',
    }),
  ],
  rateLimit: { remaining: 4999, used: 1, resetAt: '2026-06-13T16:00:00Z' },
  currentSprintIterationId: null,
};

const ESCALATION_PORCELAIN = [
  `worktree ${WORKTREES_BASE}/${ESCALATED_ISSUE}`,
  'HEAD aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
  `branch refs/heads/feat/${ESCALATED_ISSUE}-escalated-thing`,
  '',
  `worktree ${WORKTREES_BASE}/${ACTIVE_ISSUE}`,
  'HEAD bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
  `branch refs/heads/fix/${ACTIVE_ISSUE}-active-thing`,
  '',
].join('\n');

function makeEscalationRunner(): CommandRunner {
  return async (cmd: string, args: string[]): Promise<string> => {
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
      return ESCALATION_PORCELAIN;
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

describe('deriveInFlight — escalated (Blocked on: Human) sessions', () => {
  it('does not count an escalated issue as in-flight (frees its concurrency slot)', async () => {
    const { inFlight } = await deriveInFlight(ESCALATION_SNAPSHOT, makeEscalationRunner());
    expect(inFlight.some((s) => s.issueNumber === ESCALATED_ISSUE)).toBe(false);
  });

  it('still counts a non-escalated In Progress issue as in-flight', async () => {
    const { inFlight } = await deriveInFlight(ESCALATION_SNAPSHOT, makeEscalationRunner());
    expect(inFlight.some((s) => s.issueNumber === ACTIVE_ISSUE)).toBe(true);
    expect(inFlight).toHaveLength(1);
  });

  it('does not flag an escalated session\'s retained worktree as drift', async () => {
    const { drift } = await deriveInFlight(ESCALATION_SNAPSHOT, makeEscalationRunner());
    expect(drift.some((d) => d.includes(String(ESCALATED_ISSUE)))).toBe(false);
  });

  it('parks an issue promoted into the Human Status lane (not in-flight, not drift)', async () => {
    // After promotion the issue sits at Status "Human"; it must stay parked
    // (slot free, worktree retained without drift) just like a Blocked on:
    // Human item, even if "Blocked on" were later cleared.
    const snap: ProjectSnapshot = {
      items: [
        snapshotItem({
          id: 'PVTI_human',
          number: ESCALATED_ISSUE,
          contentType: 'Issue',
          status: 'Human',
          blockedOn: 'Nothing',
          issueType: 'feat',
        }),
        snapshotItem({
          id: 'PVTI_act2',
          number: ACTIVE_ISSUE,
          contentType: 'Issue',
          status: 'In Progress',
          blockedOn: 'Nothing',
          issueType: 'fix',
        }),
      ],
      rateLimit: { remaining: 4999, used: 1, resetAt: '2026-06-14T16:00:00Z' },
      currentSprintIterationId: null,
    };
    const { inFlight, drift } = await deriveInFlight(snap, makeEscalationRunner());
    expect(inFlight.some((s) => s.issueNumber === ESCALATED_ISSUE)).toBe(false);
    expect(drift.some((d) => d.includes(String(ESCALATED_ISSUE)))).toBe(false);
    // The active issue is still in-flight.
    expect(inFlight.some((s) => s.issueNumber === ACTIVE_ISSUE)).toBe(true);
  });
});
