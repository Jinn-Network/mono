import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectSnapshot, SnapshotItem } from './project-snapshot.js';
import type {
  PolledIssue,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * SEAM: where ready issues come from.
 * Local implementation polls `gh`; the future SolverNet implementation
 * claims on-chain tasks. Nothing above this interface knows which.
 *
 * Project board state is supplied via the {@link ProjectSnapshot} the
 * orchestrator fetches once per cycle (jinn-mono#585), so individual
 * implementations don't re-query the board themselves.
 */
export interface IssueSource {
  /**
   * Poll for all candidate issues with their taxonomy fields.
   *
   * @param snapshot The cycle's Project board snapshot. Issues not present
   *   in the snapshot are emitted with `onBoard: false` and all
   *   board-derived fields (`status`, `priority`, `effort`, `blockedOn`,
   *   `shape`) `null`.
   */
  poll(snapshot: ProjectSnapshot): Promise<PolledIssue[]>;
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

  async poll(snapshot: ProjectSnapshot): Promise<PolledIssue[]> {
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

    // 2. Build a lookup map from the snapshot: issue number → snapshot item.
    //    All board state (status, priority, effort, blockedOn, issueType) comes
    //    from the snapshot. Pre-#585 this involved a separate
    //    `gh project item-list` call (~96 GraphQL pts) plus an aliased
    //    `gh api graphql` issueType lookup; both are now folded into the
    //    snapshot.
    const boardMap = new Map<number, SnapshotItem>();
    for (const item of snapshot.items) {
      if (item.contentType === 'Issue') {
        boardMap.set(item.number, item);
      }
    }

    // 3. Map each polled issue to PolledIssue.
    //    Note: an issue not in the snapshot is emitted with `onBoard: false`
    //    and all board-derived fields null. `selectReady` filters those out
    //    (it requires `onBoard: true` AND `status === 'Todo'`), so they are
    //    never dispatched. Issue Type for off-board issues is not fetched —
    //    this is intentional, since off-board issues are never dispatchable
    //    in the first place.
    return ghIssues.map((ghIssue): PolledIssue => {
      const boardItem = boardMap.get(ghIssue.number);
      const onBoard = boardItem != null;
      return {
        number: ghIssue.number,
        title: ghIssue.title,
        shape: boardItem?.issueType ?? null,
        blockedOn: boardItem?.blockedOn ?? null,
        blockedOnIssue: null,   // Always null in v1 — the field stores "Another issue" with no number suffix; see PolledIssue.blockedOnIssue
        effort: boardItem?.effort ?? null,
        priority: boardItem?.priority ?? null,
        status: boardItem?.status ?? null,
        onBoard,
        // Empty string is the unknown-author sentinel; never matches the allowlist (#497).
        author: ghIssue.author?.login ?? '',
        projectItemId: boardItem?.id ?? null,
      };
    });
  }
}
