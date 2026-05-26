import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  BlockedOn,
  Effort,
  IssueShape,
  PolledIssue,
  Priority,
  ProjectStatus,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * One row of board state, projected down to the fields an `IssueSource`
 * implementation needs to populate a {@link PolledIssue}. Read-only by
 * convention; consumers must not mutate.
 *
 * A GitHub Project board contributes one entry per Issue-typed item (see
 * {@link toIssueBoardState}); a future SolverNet implementation would
 * synthesise entries from on-chain task data.
 */
export interface IssueBoardEntry {
  /** Stable, opaque identifier the implementation can use to mutate the
   *  underlying record (e.g. the GitHub Project item id `PVTI_…`). */
  readonly id: string;
  readonly status: ProjectStatus | null;
  readonly priority: Priority | null;
  readonly effort: Effort | null;
  readonly blockedOn: BlockedOn | null;
  readonly issueType: IssueShape | null;
  /** Iteration / sprint identifier this entry belongs to, or `null` when
   *  the entry has no sprint assignment. Compared against
   *  {@link IssueBoardState.currentSprintIterationId} to derive
   *  `PolledIssue.inCurrentSprint`. */
  readonly sprintIterationId: string | null;
}

/**
 * Abstract view of board state that an `IssueSource` consults while polling.
 *
 * This is the only board-shaped data type the seam exposes — `IssueSource`
 * implementations do NOT depend on the GitHub-Project-specific
 * `ProjectSnapshot`. The GitHub implementation feeds in
 * `toIssueBoardState(snapshot)` from `./project-snapshot.js`; a future
 * SolverNet implementation would construct an `IssueBoardState` from
 * on-chain task records.
 */
export interface IssueBoardState {
  /** Look up the board entry for a given issue number, or `null` when the
   *  issue is not on the board. */
  getIssue(issueNumber: number): IssueBoardEntry | null;
  /** Identifier of the currently-active sprint iteration, or `null` when no
   *  sprint is active. Used to derive `PolledIssue.inCurrentSprint` without
   *  threading the full board state through the ready-filter. (#609) */
  readonly currentSprintIterationId: string | null;
}

/**
 * SEAM: where ready issues come from.
 * Local implementation polls `gh`; the future SolverNet implementation
 * claims on-chain tasks. Nothing above this interface knows which.
 *
 * Board state is supplied via an {@link IssueBoardState} the orchestrator
 * builds once per cycle (jinn-mono#585), so individual implementations
 * don't re-query their backing data source themselves. The GitHub
 * implementation derives the board state from a `ProjectSnapshot` via
 * `toIssueBoardState`; a future on-chain implementation builds its own.
 */
export interface IssueSource {
  /**
   * Poll for all candidate issues with their taxonomy fields.
   *
   * @param board The cycle's abstract board state. Issues not present
   *   (i.e. `board.getIssue(n)` returns `null`) are emitted with
   *   `onBoard: false` and all board-derived fields (`status`, `priority`,
   *   `effort`, `blockedOn`, `shape`) `null`.
   */
  poll(board: IssueBoardState): Promise<PolledIssue[]>;
}

/**
 * Injectable command runner — takes a command and args, returns stdout.
 * Defaults to a real execFile-based runner; swap in a fake for tests.
 */
export type CommandRunner = (cmd: string, args: string[]) => Promise<string>;

// ---------------------------------------------------------------------------
// Internal shapes that mirror real `gh` JSON output (observed 2026-05-21).
// ---------------------------------------------------------------------------

/** One entry from `gh issue list --json number,title,labels,author`. */
interface GhIssue {
  number: number;
  title: string;
  labels: Array<{ name: string } | string>;
  /**
   * `gh` returns `{ login, ... }`. Optional so older `gh` versions or
   * unexpected payloads degrade to `''` rather than throwing — the empty
   * string never matches an allowlist entry, so the trust boundary fails safe.
   */
  author?: { login?: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO = 'Jinn-Network/mono';

// ---------------------------------------------------------------------------
// Default real CommandRunner
// ---------------------------------------------------------------------------

export const defaultRunner: CommandRunner = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
};

// ---------------------------------------------------------------------------
// GhIssueSource
// ---------------------------------------------------------------------------

export class GhIssueSource implements IssueSource {
  private readonly run: CommandRunner;

  constructor(runner: CommandRunner = defaultRunner) {
    this.run = runner;
  }

  async poll(board: IssueBoardState): Promise<PolledIssue[]> {
    // 1. Fetch open issues from the repo (REST — does not consume GraphQL budget).
    const issueListRaw = await this.run('gh', [
      'issue', 'list',
      '--repo', REPO,
      '--state', 'open',
      // TODO: `labels` is the hook for per-issue `agent:*` implementer override (Phase 3 stacked dispatch).
      // `author` powers the dispatcher author-allowlist trust boundary (#497).
      '--json', 'number,title,labels,author',
      '--limit', '200',
    ]);
    const ghIssues: GhIssue[] = JSON.parse(issueListRaw) as GhIssue[];

    // 2. Pre-compute whether the board has an active sprint to avoid threading
    //    it through the per-issue map. When `currentSprintIterationId` is null
    //    (no active sprint), every issue's `inCurrentSprint` is false and the
    //    ready-filter's sprint-first sort becomes a no-op (#609).
    //
    //    Board state comes in via the abstract IssueBoardState (#600); the
    //    GitHub-specific projection (Issue-only filtering, field plumbing)
    //    lives in `toIssueBoardState` so this implementation stays seam-pure.
    const currentSprintId = board.currentSprintIterationId;

    // 3. Map each polled issue to PolledIssue.
    //    An issue not on the board is emitted with `onBoard: false` and all
    //    board-derived fields null. `selectReady` filters those out (it
    //    requires `onBoard: true` AND `status === 'Todo'`), so they are
    //    never dispatched.
    return ghIssues.map((ghIssue): PolledIssue => {
      const entry = board.getIssue(ghIssue.number);
      const onBoard = entry != null;
      const inCurrentSprint =
        currentSprintId != null &&
        entry?.sprintIterationId === currentSprintId;
      return {
        number: ghIssue.number,
        title: ghIssue.title,
        shape: entry?.issueType ?? null,
        blockedOn: entry?.blockedOn ?? null,
        blockedOnIssue: null,   // Always null in v1 — the field stores "Another issue" with no number suffix; see PolledIssue.blockedOnIssue
        effort: entry?.effort ?? null,
        priority: entry?.priority ?? null,
        status: entry?.status ?? null,
        onBoard,
        // Empty string is the unknown-author sentinel; never matches the allowlist (#497).
        author: ghIssue.author?.login ?? '',
        projectItemId: entry?.id ?? null,
        inCurrentSprint,
      };
    });
  }
}
