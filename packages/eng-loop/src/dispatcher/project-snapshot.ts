/**
 * Project board snapshot — the dispatcher's single source of truth per cycle.
 *
 * Previously the dispatcher made multiple `gh project item-list` calls per
 * cycle (and per dispatch), each billed at ~96 GraphQL points due to GitHub's
 * complexity formula multiplying nested connections (items × fieldValues ×
 * labels). At 60 cycles/hour that exhausted the 5,000 pts/hr GraphQL budget
 * in ~26 minutes.
 *
 * This module replaces those calls with one paginated lean GraphQL query that
 * fetches only the six fields the dispatcher consumes plus `rateLimit`. The
 * resulting `ProjectSnapshot` is fetched once at the top of each cycle by
 * `scripts/run-eng-loop.ts` and threaded through `runCycle`, `deriveInFlight`,
 * `GhIssueSource.poll`, and `dispatchIssue.getProjectItemId`.
 *
 * Tracking: jinn-mono#585.
 */

import type {
  BlockedOn,
  Effort,
  IssueShape,
  Priority,
  ProjectStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/**
 * Subprocess runner the snapshot fetcher uses to invoke `gh api graphql`.
 * Mirrors the `CommandRunner` type defined in `issue-source.ts`. Kept here
 * as a local re-declaration so this module has no cyclic dependency on
 * `issue-source.ts`; the orchestrator passes the same runner to both.
 */
export type CommandRunner = (cmd: string, args: string[]) => Promise<string>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * GitHub GraphQL rate-limit metadata, surfaced from every snapshot fetch.
 *
 * `remaining` is decremented by the snapshot fetch itself, so the value
 * reflects the budget *after* paying for the current snapshot — i.e. the
 * rate-limit guard checks it against the budget available for *subsequent*
 * work (the cycle's dispatches, sessions, etc.).
 */
export interface RateLimitInfo {
  /** Points remaining in the current 1-hour window. */
  remaining: number;
  /** Points already spent in the current window. */
  used: number;
  /** ISO-8601 timestamp at which the current window resets. */
  resetAt: string;
}

/**
 * The `__typename` of a Project board item's `content`. Per GitHub's GraphQL
 * schema, `ProjectV2Item.content` is a union over `Issue | PullRequest |
 * DraftIssue`, and may also be `null` if the underlying entity was deleted
 * while the project item lingered.
 *
 * The dispatcher only acts on `Issue` content; PR and DraftIssue items are
 * surfaced so consumers can filter them explicitly rather than the snapshot
 * helper hiding the distinction.
 */
export type ProjectContentType = 'Issue' | 'PullRequest' | 'DraftIssue';

/**
 * A single Project board row, projected down to only the fields the
 * dispatcher reads. Items whose `content` was null (deleted underlying
 * entity) are filtered out at fetch time and never appear in a snapshot.
 *
 * `issueType` is only populated when `contentType === 'Issue'`; PRs and
 * DraftIssues always have `issueType: null`.
 *
 * All four single-select Project fields (`status`, `priority`, `effort`,
 * `blockedOn`) come from `fieldValueByName(name: "<exact label>")` and are
 * `null` when the field is unset on the item. If the *field itself* is
 * renamed in the GitHub Project, every item's value collapses to `null` —
 * `fetchProjectSnapshot` detects this catastrophic case and throws
 * `ProjectFieldSchemaError` rather than silently producing a snapshot that
 * fails every ready-filter check.
 */
export interface SnapshotItem {
  /** The Project board item's node id (e.g. `PVTI_…`). Stable across cycles. */
  id: string;
  /** The underlying entity's number. For DraftIssue, the GraphQL schema does
   *  not expose a number — DraftIssue items are surfaced with `number: -1`
   *  so consumers can drop them via the typename check without crashing on
   *  field access. */
  number: number;
  contentType: ProjectContentType;
  status: ProjectStatus | null;
  priority: Priority | null;
  effort: Effort | null;
  blockedOn: BlockedOn | null;
  /** `IssueType.name` from the underlying Issue, mapped to the canonical
   *  shape vocabulary. `null` for non-Issue content or untyped issues. */
  issueType: IssueShape | null;
}

/**
 * A one-shot view of the Project board + the GraphQL rate-limit budget at
 * fetch time. The cycle orchestrator builds one per cycle and hands it to
 * every downstream consumer; nothing else in the dispatcher should call
 * `gh project item-list` directly.
 */
export interface ProjectSnapshot {
  items: SnapshotItem[];
  rateLimit: RateLimitInfo;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Schema-drift check fires only when the issue count is at least this. */
export const SCHEMA_DRIFT_MIN_ISSUE_COUNT = 3;

/** Thrown when {@link fetchProjectSnapshot} hits {@link MAX_PAGES}. The most
 *  likely cause is a buggy paginator (GitHub returning the same `endCursor`
 *  repeatedly) — the snapshot is unsafe to use because some items would be
 *  silently dropped. */
export class PaginationLimitError extends Error {
  constructor(pagesAttempted: number) {
    super(
      `PaginationLimitError: snapshot fetch exceeded ${pagesAttempted} pages. ` +
        `Most likely the GraphQL cursor stopped advancing (GitHub returned the ` +
        `same endCursor twice) or the board grew past the safety cap. Inspect ` +
        `the raw response or raise the cap deliberately if the board legitimately ` +
        `has >${pagesAttempted * 100} items.`,
    );
    this.name = 'PaginationLimitError';
  }
}

/**
 * Thrown by `fetchProjectSnapshot` when N ≥ {@link SCHEMA_DRIFT_MIN_ISSUE_COUNT}
 * Issue items all have *every* single-select Project field (`Status`,
 * `Priority`, `Effort`, `Blocked on`) resolved to `null`. The most likely
 * cause is that one or more field labels were renamed in the Project, so
 * `fieldValueByName(name: "…")` returns `null` for every item.
 *
 * This catches the silent-failure mode where the dispatcher would otherwise
 * continue running with a snapshot in which every issue fails the
 * `selectReady` check (`blockedOn === 'Nothing'`, `status === 'Todo'`, …),
 * silently halting all dispatch. Throwing here surfaces the schema drift
 * loudly enough for an operator to notice on the next cycle.
 *
 * The N ≥ 3 threshold avoids false positives on small boards where one or
 * two brand-new untriaged issues legitimately have no fields set. Catches
 * the catastrophic case (all 4 fields renamed); single-field renames are
 * not detected — that's a future enhancement.
 *
 * Recovery: re-discover the field names via `gh project field-list 1
 * --owner Jinn-Network --format json` and update the snapshot query (or
 * rename the Project fields back).
 */
export class ProjectFieldSchemaError extends Error {
  constructor(itemCount: number) {
    super(
      `ProjectFieldSchemaError: all ${itemCount} project items resolved every ` +
        `single-select field to null (threshold: ${SCHEMA_DRIFT_MIN_ISSUE_COUNT}+). ` +
        `The most likely cause is that one of the ` +
        `Status / Priority / Effort / Blocked on field labels was renamed. ` +
        `Re-run \`gh project field-list 1 --owner Jinn-Network --format json\` ` +
        `to discover the current field labels and update the snapshot query.`,
    );
    this.name = 'ProjectFieldSchemaError';
  }
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const PROJECT_OWNER = 'Jinn-Network';
const PROJECT_NUMBER = 1;

/**
 * The one lean query. Selects ONLY the fields the dispatcher actually reads,
 * plus a top-level `rateLimit` block. GitHub's complexity billing formula
 * (`max(1, sum(connection_first_args) / 100)`) makes this ~1 point per page.
 *
 * IMPORTANT: every field used here is referenced by name elsewhere — keep
 * `"Status"`, `"Priority"`, `"Effort"`, `"Blocked on"` in lock-step with the
 * Project's actual field labels. A rename will trip
 * {@link ProjectFieldSchemaError} on the next cycle.
 */
/**
 * Defensive upper bound on the number of GraphQL pages we'll fetch in a
 * single snapshot. At 100 items/page this caps the snapshot at 10,000
 * board items — well past any plausible Project size. Exists to catch the
 * pathological case where GitHub returns `hasNextPage: true` with the same
 * `endCursor` forever (cursor doesn't advance → infinite loop).
 */
const MAX_PAGES = 100;

const SNAPSHOT_QUERY = `query($cursor: String) {
  rateLimit { cost remaining used resetAt }
  organization(login: "${PROJECT_OWNER}") {
    projectV2(number: ${PROJECT_NUMBER}) {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            __typename
            ... on Issue { number issueType { name } }
            ... on PullRequest { number }
          }
          status:    fieldValueByName(name: "Status")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          priority:  fieldValueByName(name: "Priority")   { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          effort:    fieldValueByName(name: "Effort")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          blockedOn: fieldValueByName(name: "Blocked on") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Internal response shapes
// ---------------------------------------------------------------------------

interface SingleSelectValue {
  name: string;
}

interface ResponseNode {
  id: string;
  content: ResponseContent | null;
  status: SingleSelectValue | null;
  priority: SingleSelectValue | null;
  effort: SingleSelectValue | null;
  blockedOn: SingleSelectValue | null;
}

interface ResponseContent {
  __typename: string;
  number?: number;
  issueType?: { name: string } | null;
}

interface SnapshotResponse {
  data: {
    rateLimit: RateLimitInfo & { cost?: number };
    organization: {
      projectV2: {
        items: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ResponseNode[];
        };
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Parsers
//
// Mirrors the validation logic in `issue-source.ts` so an unknown field value
// (a new option added on the Project board that the dispatcher doesn't
// recognise yet) coerces to `null` rather than corrupting the typed snapshot.
// After Step 5 of the #585 plan, `issue-source.ts` will consume the snapshot
// directly and these become the canonical parsers.
// ---------------------------------------------------------------------------

const VALID_SHAPES = new Set<string>([
  'feat', 'fix', 'refactor', 'spike', 'chore', 'docs', 'test', 'incident', 'design',
]);

const VALID_BLOCKED_ON = new Set<string>(['Nothing', 'Human', 'Another issue']);
const VALID_EFFORT = new Set<string>(['Low', 'Medium', 'High']);
const VALID_PRIORITY = new Set<string>(['P0', 'P1', 'P2', 'P3', 'P4']);
const VALID_STATUS = new Set<string>(['Todo', 'In Progress', 'In Review', 'Done']);

function parseShape(name: string | null | undefined): IssueShape | null {
  if (name == null) return null;
  return VALID_SHAPES.has(name) ? (name as IssueShape) : null;
}

function parseSingleSelect<T extends string>(
  val: SingleSelectValue | null,
  valid: ReadonlySet<string>,
): T | null {
  if (val == null) return null;
  return valid.has(val.name) ? (val.name as T) : null;
}

// ---------------------------------------------------------------------------
// Node → SnapshotItem
// ---------------------------------------------------------------------------

function parseContentType(typename: string): ProjectContentType {
  if (typename === 'Issue' || typename === 'PullRequest' || typename === 'DraftIssue') {
    return typename;
  }
  // Future-proof: unknown content type defaults to DraftIssue (no `number`,
  // never dispatchable). Consumers filter via `contentType !== 'Issue'`.
  return 'DraftIssue';
}

function parseNode(node: ResponseNode): SnapshotItem | null {
  if (node.content == null) return null;
  const contentType = parseContentType(node.content.__typename);
  const number = node.content.number ?? -1; // DraftIssue has no number
  const issueType =
    contentType === 'Issue'
      ? parseShape(node.content.issueType?.name)
      : null;
  return {
    id: node.id,
    number,
    contentType,
    status: parseSingleSelect<ProjectStatus>(node.status, VALID_STATUS),
    priority: parseSingleSelect<Priority>(node.priority, VALID_PRIORITY),
    effort: parseSingleSelect<Effort>(node.effort, VALID_EFFORT),
    blockedOn: parseSingleSelect<BlockedOn>(node.blockedOn, VALID_BLOCKED_ON),
    issueType,
  };
}

// ---------------------------------------------------------------------------
// fetchProjectSnapshot
// ---------------------------------------------------------------------------

/**
 * Fetch a single Project board snapshot by paginating one lean GraphQL query.
 *
 * The query selects only the fields the dispatcher reads (`number`,
 * `contentType`, `status`, `priority`, `effort`, `blockedOn`, `issueType`)
 * plus a top-level `rateLimit { remaining used resetAt }`. Internally paginates
 * via `items(first: 100, after: $cursor)` until `pageInfo.hasNextPage` is false.
 *
 * Throws {@link ProjectFieldSchemaError} when a non-empty board returns Issue
 * items where every single-select field is null — see that class for context.
 * Non-Issue items (PRs, DraftIssues) are excluded from this check because they
 * legitimately have all fields unset.
 *
 * The returned `rateLimit` reflects the *last* page's view of the budget —
 * the most current snapshot of remaining points. The fetch itself spends
 * `pageCount` points (typically 1), so callers should treat `remaining` as
 * the budget available for *subsequent* work, not as a pre-fetch reading.
 *
 * @see {@link ProjectSnapshot}
 */
export interface FetchOpts {
  /** Defensive page cap. Defaults to {@link MAX_PAGES} (100 pages = 10,000
   *  items). Lowering this is useful in tests; raising it requires a
   *  deliberate decision because the snapshot's correctness depends on
   *  reading every page. */
  maxPages?: number;
}

export async function fetchProjectSnapshot(
  runner: CommandRunner,
  opts: FetchOpts = {},
): Promise<ProjectSnapshot> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const items: SnapshotItem[] = [];
  let rateLimit: RateLimitInfo | null = null;
  let cursor: string | null = null;
  let issueCount = 0;
  let issuesWithAllFieldsNull = 0;
  let pageNum = 0;

  for (;;) {
    pageNum += 1;
    if (pageNum > maxPages) {
      throw new PaginationLimitError(maxPages);
    }

    const args = ['api', 'graphql', '-f', `query=${SNAPSHOT_QUERY}`];
    if (cursor != null) {
      args.push('-f', `cursor=${cursor}`);
    }

    const raw = await runner('gh', args);
    const response = JSON.parse(raw) as SnapshotResponse;
    const pageItems = response.data.organization.projectV2.items;

    // Debug visibility into per-page billing — turn on with
    // ENG_LOOP_DEBUG_RATELIMIT=1. Used at PR-time to verify the AC's
    // "≤2 GraphQL points per cycle" against the live project. Off by default
    // to keep normal-run logs clean.
    if (process.env.ENG_LOOP_DEBUG_RATELIMIT === '1') {
      const c = response.data.rateLimit.cost;
      console.debug(
        `[eng:loop] rateLimit.cost=${c ?? '?'} remaining=${response.data.rateLimit.remaining} ` +
          `(page items=${pageItems.nodes.length}, hasNext=${pageItems.pageInfo.hasNextPage})`,
      );
    }

    for (const node of pageItems.nodes) {
      const item = parseNode(node);
      if (item == null) continue;
      items.push(item);
      if (item.contentType === 'Issue') {
        issueCount += 1;
        if (
          item.status == null &&
          item.priority == null &&
          item.effort == null &&
          item.blockedOn == null
        ) {
          issuesWithAllFieldsNull += 1;
        }
      }
    }

    rateLimit = response.data.rateLimit;

    if (!pageItems.pageInfo.hasNextPage || pageItems.pageInfo.endCursor == null) break;
    cursor = pageItems.pageInfo.endCursor;
  }

  if (
    issueCount >= SCHEMA_DRIFT_MIN_ISSUE_COUNT &&
    issueCount === issuesWithAllFieldsNull
  ) {
    throw new ProjectFieldSchemaError(issueCount);
  }

  // Defensive: if no pages returned (shouldn't happen — empty boards still
  // produce a response with rateLimit), default to a zero-budget marker so
  // the rate-limit gate fails closed rather than silently passing.
  return {
    items,
    rateLimit: rateLimit ?? { remaining: 0, used: 0, resetAt: '' },
  };
}
