import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  PolledIssue,
  IssueShape,
  BlockedOn,
  Effort,
  Priority,
  ProjectStatus,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * SEAM: where ready issues come from.
 * Local implementation polls `gh`; the future SolverNet implementation
 * claims on-chain tasks. Nothing above this interface knows which.
 */
export interface IssueSource {
  /** Poll for all candidate issues with their taxonomy fields. */
  poll(): Promise<PolledIssue[]>;
}

/**
 * Injectable command runner — takes a command and args, returns stdout.
 * Defaults to a real execFile-based runner; swap in a fake for tests.
 */
export type CommandRunner = (cmd: string, args: string[]) => Promise<string>;

// ---------------------------------------------------------------------------
// Internal shapes that mirror real `gh` JSON output (observed 2026-05-21).
// ---------------------------------------------------------------------------

/** One entry from `gh issue list --json number,title,labels`. */
interface GhIssue {
  number: number;
  title: string;
  labels: Array<{ name: string } | string>;
}

/** One item from `gh project item-list --format json`. */
interface GhProjectItem {
  'blocked on'?: string;
  effort?: string;
  priority?: string;
  status?: string;
  title: string;
  id: string;
  repository: string;
  content?: {
    number: number;
    type: string;
    title: string;
    url: string;
    body?: string;
    repository: string;
  };
}

/** Top-level shape of `gh project item-list --format json`. */
interface GhProjectItemsResponse {
  items: GhProjectItem[];
  totalCount: number;
}

/** Top-level shape of the GraphQL Issue Type batch query response. */
interface GhIssueTypeResponse {
  data: {
    repository: Record<string, { issueType: { name: string } | null } | null>;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO = 'Jinn-Network/mono';
const PROJECT_OWNER = 'Jinn-Network';
const PROJECT_NUMBER = '1';

// ---------------------------------------------------------------------------
// Type guards / parsers
// ---------------------------------------------------------------------------

const VALID_SHAPES = new Set<string>([
  'feat', 'fix', 'refactor', 'spike', 'chore', 'docs', 'test', 'incident', 'design',
]);

function parseShape(name: string | null | undefined): IssueShape | null {
  if (name == null) return null;
  return VALID_SHAPES.has(name) ? (name as IssueShape) : null;
}

const VALID_BLOCKED_ON = new Set<string>(['Nothing', 'Human', 'Another issue']);

function parseBlockedOn(val: string | undefined): BlockedOn | null {
  if (val == null) return null;
  return VALID_BLOCKED_ON.has(val) ? (val as BlockedOn) : null;
}

const VALID_EFFORT = new Set<string>(['Low', 'Medium', 'High']);

function parseEffort(val: string | undefined): Effort | null {
  if (val == null) return null;
  return VALID_EFFORT.has(val) ? (val as Effort) : null;
}

const VALID_PRIORITY = new Set<string>(['P0', 'P1', 'P2', 'P3', 'P4']);

function parsePriority(val: string | undefined): Priority | null {
  if (val == null) return null;
  return VALID_PRIORITY.has(val) ? (val as Priority) : null;
}

const VALID_STATUS = new Set<string>(['Todo', 'In Progress', 'In Review', 'Done']);

function parseStatus(val: string | undefined): ProjectStatus | null {
  if (val == null) return null;
  return VALID_STATUS.has(val) ? (val as ProjectStatus) : null;
}

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

  async poll(): Promise<PolledIssue[]> {
    // 1. Fetch open issues from the repo
    const issueListRaw = await this.run('gh', [
      'issue', 'list',
      '--repo', REPO,
      '--state', 'open',
      // TODO: `labels` is the hook for per-issue `agent:*` implementer override (Phase 3 stacked dispatch).
      '--json', 'number,title,labels',
      '--limit', '200',
    ]);
    const ghIssues: GhIssue[] = JSON.parse(issueListRaw) as GhIssue[];

    // 2. Fetch Project board items (Issues only, up to 500)
    const projectRaw = await this.run('gh', [
      'project', 'item-list', PROJECT_NUMBER,
      '--owner', PROJECT_OWNER,
      '--format', 'json',
      '--limit', '500',
    ]);
    const projectData: GhProjectItemsResponse = JSON.parse(projectRaw) as GhProjectItemsResponse;

    // Build a lookup map: issue number → project item (Issues only)
    const boardMap = new Map<number, GhProjectItem>();
    for (const item of projectData.items) {
      if (item.content?.type === 'Issue') {
        boardMap.set(item.content.number, item);
      }
    }

    // 3. Batch-query Issue Types via GraphQL for all issues.
    //    Short-circuit when the issue list is empty — an empty selection set may
    //    be rejected by GitHub's GraphQL endpoint.
    const issueNumbers = ghIssues.map((i) => i.number);
    if (issueNumbers.length === 0) return [];
    const aliases = issueNumbers
      .map((n) => `i${n}: issue(number: ${n}) { issueType { name } }`)
      .join('\n    ');
    const gqlQuery = `{
  repository(owner: "Jinn-Network", name: "mono") {
    ${aliases}
  }
}`;

    const issueTypeRaw = await this.run('gh', [
      'api', 'graphql',
      '-f', `query=${gqlQuery}`,
    ]);
    const issueTypeData: GhIssueTypeResponse = JSON.parse(issueTypeRaw) as GhIssueTypeResponse;
    const repoData = issueTypeData.data.repository;

    // Build lookup: issue number → IssueShape | null
    const shapeMap = new Map<number, IssueShape | null>();
    for (const n of issueNumbers) {
      const alias = `i${n}`;
      const entry = repoData[alias];
      const typeName = entry?.issueType?.name ?? null;
      shapeMap.set(n, parseShape(typeName));
    }

    // 4. Map each GhIssue to a PolledIssue
    return ghIssues.map((ghIssue): PolledIssue => {
      const boardItem = boardMap.get(ghIssue.number);
      const onBoard = boardItem != null;

      const blockedOn = onBoard ? parseBlockedOn(boardItem!['blocked on']) : null;
      const effort = onBoard ? parseEffort(boardItem!.effort) : null;
      const priority = onBoard ? parsePriority(boardItem!.priority) : null;
      const status = onBoard ? parseStatus(boardItem!.status) : null;

      return {
        number: ghIssue.number,
        title: ghIssue.title,
        shape: shapeMap.get(ghIssue.number) ?? null,
        blockedOn,
        blockedOnIssue: null,   // Always null in v1 — the field stores "Another issue" with no number suffix; see PolledIssue.blockedOnIssue
        effort,
        priority,
        status,
        onBoard,
      };
    });
  }
}
