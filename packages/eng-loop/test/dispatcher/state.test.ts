import { describe, it, expect } from 'vitest';
import { deriveInFlight } from '../../src/dispatcher/state.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

/**
 * Fixtures matching real observed output shapes (2026-05-21).
 *
 * gh project item-list 1 --owner Jinn-Network --format json
 *   → {"items":[{"status":"In Progress","title":"...","id":"PVTI_...","repository":"...","content":{"number":418,"type":"Issue",...}}],"totalCount":1}
 *
 * git worktree list --porcelain
 *   → (blank-line-separated blocks, each with worktree/HEAD/branch lines)
 *   worktree /Users/adrianobradley/life's-work/jinn-mono
 *   HEAD cdecb61a1f4e1274bda7ab6bb626cca6c465d86e
 *   branch refs/heads/fix/464-codex-readiness-id-token-deadlock
 *   <blank line>
 *   worktree /private/tmp/jinn-pr423-review
 *   HEAD 61822d46e6dd10063c5aeb1cabe1214b968422e3
 *   detached
 *   <blank line>
 *   worktree /Users/.../cargo/.tasks/418
 *   HEAD abc123
 *   branch refs/heads/feat/418-something
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Issue #418: In Progress on the board — has a matching worktree → in-flight. */
const ISSUE_IN_PROGRESS_WITH_WORKTREE = 418;

/** Issue #501: In Progress on the board — no matching worktree → drift warning. */
const ISSUE_IN_PROGRESS_NO_WORKTREE = 501;

/** The cargo/.tasks/<N> worktree that has no In Progress issue → drift warning. */
const ORPHAN_WORKTREE_ISSUE = 399;

const REPO_ROOT = '/Users/adrianobradley/jinn-mono';

const PROJECT_ITEMS_JSON = JSON.stringify({
  items: [
    // Issue 418 — In Progress, has a worktree
    {
      status: 'In Progress',
      title: 'feat(operator-app): something useful',
      id: 'PVTI_aaa',
      repository: 'https://github.com/Jinn-Network/mono',
      content: {
        number: ISSUE_IN_PROGRESS_WITH_WORKTREE,
        type: 'Issue',
        title: 'feat(operator-app): something useful',
        url: `https://github.com/Jinn-Network/mono/issues/${ISSUE_IN_PROGRESS_WITH_WORKTREE}`,
        body: '',
        repository: 'Jinn-Network/mono',
      },
    },
    // Issue 501 — In Progress but no cargo/.tasks/501 worktree exists → drift
    {
      status: 'In Progress',
      title: 'fix(client): something broken',
      id: 'PVTI_bbb',
      repository: 'https://github.com/Jinn-Network/mono',
      content: {
        number: ISSUE_IN_PROGRESS_NO_WORKTREE,
        type: 'Issue',
        title: 'fix(client): something broken',
        url: `https://github.com/Jinn-Network/mono/issues/${ISSUE_IN_PROGRESS_NO_WORKTREE}`,
        body: '',
        repository: 'Jinn-Network/mono',
      },
    },
    // Issue in a different status — should be ignored
    {
      status: 'Todo',
      title: 'chore: some task',
      id: 'PVTI_ccc',
      repository: 'https://github.com/Jinn-Network/mono',
      content: {
        number: 900,
        type: 'Issue',
        title: 'chore: some task',
        url: 'https://github.com/Jinn-Network/mono/issues/900',
        body: '',
        repository: 'Jinn-Network/mono',
      },
    },
  ],
  totalCount: 3,
});

/**
 * Canned git worktree list --porcelain output.
 *
 * Contains:
 *   - the main worktree (not a cargo/.tasks path — ignored)
 *   - a detached worktree (ignored — no branch)
 *   - cargo/.tasks/418  (matches In Progress issue 418 → in-flight)
 *   - cargo/.tasks/399  (no In Progress issue 399 → drift warning)
 */
const WORKTREE_PORCELAIN = [
  // Main worktree — not a cargo/.tasks path
  `worktree ${REPO_ROOT}`,
  'HEAD cdecb61a1f4e1274bda7ab6bb626cca6c465d86e',
  'branch refs/heads/main',
  '',
  // Detached worktree — no branch line, ignored
  `worktree /private/tmp/jinn-pr-review`,
  'HEAD 61822d46e6dd10063c5aeb1cabe1214b968422e3',
  'detached',
  '',
  // cargo/.tasks/418 — matches In Progress issue 418
  `worktree ${REPO_ROOT}/cargo/.tasks/418`,
  'HEAD abc123def456abc123def456abc123def456abc1',
  'branch refs/heads/feat/418-something-useful',
  '',
  // cargo/.tasks/399 — orphan: no In Progress issue 399
  `worktree ${REPO_ROOT}/cargo/.tasks/399`,
  'HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  'branch refs/heads/fix/399-old-thing',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Fake runner
// ---------------------------------------------------------------------------

function makeFakeRunner(): CommandRunner {
  return async (cmd: string, args: string[]): Promise<string> => {
    if (cmd === 'gh' && args[0] === 'project') {
      // gh project item-list 1 --owner Jinn-Network --format json --limit 500
      return PROJECT_ITEMS_JSON;
    }
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
      // git worktree list --porcelain
      return WORKTREE_PORCELAIN;
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveInFlight', () => {
  it('returns one InFlightSession for an In Progress issue with a matching worktree', async () => {
    const { inFlight } = await deriveInFlight(makeFakeRunner());

    expect(inFlight).toHaveLength(1);
    const session = inFlight[0];
    expect(session.issueNumber).toBe(ISSUE_IN_PROGRESS_WITH_WORKTREE);
    expect(session.worktreePath).toBe(`${REPO_ROOT}/cargo/.tasks/${ISSUE_IN_PROGRESS_WITH_WORKTREE}`);
    expect(session.branch).toBe('feat/418-something-useful');
    expect(session.pid).toBeNull();
    // startedAt is either a real timestamp recovered from the worktree directory (> 0)
    // or the unknown-age sentinel (0) when the fixture path does not exist on disk.
    // Both are valid — the WallClock guards against startedAt <= 0.
    expect(typeof session.startedAt).toBe('number');
  });

  it('surfaces an In Progress issue with no matching worktree as a drift warning', async () => {
    const { drift } = await deriveInFlight(makeFakeRunner());

    const driftForMissingWorktree = drift.find((d) =>
      d.includes(String(ISSUE_IN_PROGRESS_NO_WORKTREE)),
    );
    expect(driftForMissingWorktree).toBeDefined();
  });

  it('surfaces an orphan cargo/.tasks worktree (no In Progress issue) as a drift warning', async () => {
    const { drift } = await deriveInFlight(makeFakeRunner());

    const driftForOrphanWorktree = drift.find((d) =>
      d.includes(String(ORPHAN_WORKTREE_ISSUE)),
    );
    expect(driftForOrphanWorktree).toBeDefined();
  });

  it('does not include Todo or other non-In-Progress issues in in-flight or drift', async () => {
    const { inFlight, drift } = await deriveInFlight(makeFakeRunner());

    // Issue 900 is Todo — not in-flight
    const inFlight900 = inFlight.find((s) => s.issueNumber === 900);
    expect(inFlight900).toBeUndefined();

    // Issue 900 should not appear in drift either (it's just not In Progress)
    const drift900 = drift.find((d) => d.includes('900'));
    expect(drift900).toBeUndefined();
  });

  it('normal case: issue #418 In Progress + cargo/.tasks/418 worktree → one InFlightSession', async () => {
    const { inFlight, drift } = await deriveInFlight(makeFakeRunner());

    // Exactly the matched pair
    const session = inFlight.find((s) => s.issueNumber === ISSUE_IN_PROGRESS_WITH_WORKTREE);
    expect(session).toBeDefined();
    expect(session!.issueNumber).toBe(418);
    expect(session!.worktreePath).toContain('cargo/.tasks/418');
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
