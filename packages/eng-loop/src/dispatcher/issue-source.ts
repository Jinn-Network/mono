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
import { REPO } from './constants.js';

const execFileAsync = promisify(execFile);

/**
 * One row of board state, projected down to the fields an `IssueSource`
 * needs to populate a {@link PolledIssue}.
 */
export interface IssueBoardEntry {
  /** Opaque identifier for the underlying record (e.g. GitHub Project item id `PVTI_…`). */
  readonly id: string;
  readonly status: ProjectStatus | null;
  readonly priority: Priority | null;
  readonly effort: Effort | null;
  readonly blockedOn: BlockedOn | null;
  readonly issueType: IssueShape | null;
  /** GitHub native `blocked_by` issue-dependency numbers (spec 2026-07-13). */
  readonly blockedByIssues: number[];
  /** Sprint iteration this entry belongs to, compared against
   *  {@link IssueBoardState.currentSprintIterationId} to derive
   *  `PolledIssue.inCurrentSprint`. */
  readonly sprintIterationId: string | null;
}

/**
 * Backing-substrate-agnostic view of board state an `IssueSource` consults.
 * The GitHub implementation builds one via `toIssueBoardState(snapshot)`; a
 * future SolverNet implementation would build one from on-chain task records.
 */
export interface IssueBoardState {
  /** Board entry for `issueNumber`, or `null` when not on the board. */
  getIssue(issueNumber: number): IssueBoardEntry | null;
  /** Active sprint iteration id, or `null` when no sprint is active (#609). */
  readonly currentSprintIterationId: string | null;
}

/**
 * SEAM: where ready issues come from. Local implementation polls `gh`; a
 * future SolverNet implementation claims on-chain tasks. Board state is
 * supplied per cycle via {@link IssueBoardState} (jinn-mono#585, #600) so
 * implementations don't re-query their backing data source themselves.
 */
export interface IssueSource {
  /**
   * Poll for all candidate issues with their taxonomy fields. Issues not
   * on `board` are emitted with `onBoard: false` and null board-derived fields.
   */
  poll(board: IssueBoardState): Promise<PolledIssue[]>;
}

/**
 * Injectable command runner — takes a command and args, returns stdout.
 * Defaults to a real execFile-based runner; swap in a fake for tests.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string> },
) => Promise<string>;

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
// Default real CommandRunner
// ---------------------------------------------------------------------------

export const defaultRunner: CommandRunner = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, {
    maxBuffer: 10 * 1024 * 1024,
    // Per-call env overlay (used to run `gh` as a specific identity via
    // GH_TOKEN — the dual-identity boot check, DR-2026-06-15). Merged over the
    // ambient env so PATH etc. survive.
    ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
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

    // 2. Hoist the active-sprint id; when null, every `inCurrentSprint` is
    //    false and the ready-filter's sprint sort becomes a no-op (#609).
    const currentSprintId = board.currentSprintIterationId;

    // 3. Map each gh issue to PolledIssue. Off-board issues get `onBoard: false`
    //    and null board-derived fields; `selectReady` then drops them (it
    //    requires `onBoard: true` AND `status === 'Todo'`).
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
        blockedByIssues: entry?.blockedByIssues ?? [],
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
