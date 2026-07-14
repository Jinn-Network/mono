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
 * `scripts/run-autopilot.ts` and threaded through `runCycle`, `deriveInFlight`,
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
// Type-only back-import (#600): `toIssueBoardState` adapts a snapshot into
// the seam's abstract view. `import type` keeps this out of the emitted JS,
// avoiding a runtime cycle between the two modules.
import type { IssueBoardEntry, IssueBoardState } from './issue-source.js';
import { ORG, PROJECT_NUMBER } from './constants.js';

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
  /** GitHub native `blocked_by` issue-dependency numbers. Empty for non-Issue
   *  content, untyped items, or issues with no dependencies. (spec 2026-07-13) */
  blockedByIssues: number[];
  /** Iteration id of the item's `Sprint` field value (e.g. `d710be59`).
   *  `null` when the item has no Sprint value or the Sprint field is absent.
   *  Compared against {@link ProjectSnapshot.currentSprintIterationId} to
   *  derive `PolledIssue.inCurrentSprint`. (#609) */
  sprintIterationId: string | null;
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
  /**
   * Iteration id of the *current* Sprint iteration on the Project board, or
   * `null` when no sprint is active (the field is absent, has no configured
   * iterations, or the only iterations are in the past — i.e. the
   * `completedIterations` list rather than `iterations`).
   *
   * `GhIssueSource.poll` compares each item's `sprintIterationId` against
   * this value to set `PolledIssue.inCurrentSprint`, which the ready-filter
   * sort uses to prioritise sprint commitments (#609).
   *
   * If two future iterations are configured (rare, but allowed), this picks
   * the *first* one — GitHub returns active+future iterations in start-date
   * order, so [0] is the iteration containing today, or the next one to
   * start. The dispatcher treats "sprint that has not yet started" as
   * not-current; sprint commitment kicks in when the iteration is active.
   */
  currentSprintIterationId: string | null;
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
 * Which Project field tripped the schema-drift check.
 *
 * Only `'all'` and `'Status'` are ever emitted today; the per-field check is
 * restricted to `Status` (see {@link ProjectFieldSchemaError}). The other
 * three labels are part of the union so the discriminant stays open for
 * future per-field checks should the false-positive trade-off change.
 */
export type SchemaDriftField = 'Status' | 'Priority' | 'Effort' | 'Blocked on' | 'all';

/**
 * Thrown by `fetchProjectSnapshot` when schema drift is detected on the
 * Project board. Two cases fire:
 *
 * 1. **All-four-fields-null backstop** (`field === 'all'`): every
 *    single-select Project field (`Status`, `Priority`, `Effort`,
 *    `Blocked on`) resolved to `null` on ≥ {@link SCHEMA_DRIFT_MIN_ISSUE_COUNT}
 *    Issues — the catastrophic case where multiple field labels were
 *    renamed at once.
 * 2. **Single-field `Status` rename** (`field === 'Status'`): `Status`
 *    alone resolved to `null` on every Issue. Added in #597 to catch
 *    single-label renames the all-four-null backstop would miss.
 *
 * Per spec/2026-05-26-597, the per-field check is **`Status`-only** by
 * design: `Status` is the only single-select field GitHub auto-sets on
 * issue creation (via `gh project item-add` + the project's auto-add
 * workflow), giving it zero false-positive surface. `Priority` / `Effort`
 * / `Blocked on` legitimately stay `null` on freshly-triaged Issues, so a
 * per-field check on them would fire during normal operation; their
 * renames remain caught by the `'all'` backstop only.
 *
 * Without this, the dispatcher silently runs with a snapshot in which
 * every Issue fails `selectReady` (`blockedOn === 'Nothing'`, `status ===
 * 'Todo'`, …), halting all dispatch. Throwing surfaces the drift loudly
 * enough for an operator to notice on the next cycle.
 *
 * The N ≥ {@link SCHEMA_DRIFT_MIN_ISSUE_COUNT} threshold avoids false
 * positives on small boards where one or two brand-new untriaged Issues
 * legitimately have no fields set.
 *
 * Recovery: re-run `gh project field-list 1 --owner Jinn-Network --format
 * json` and update the snapshot query (or rename the Project fields back).
 */
export class ProjectFieldSchemaError extends Error {
  readonly field: SchemaDriftField;

  constructor(itemCount: number, field: SchemaDriftField = 'all') {
    // Two message shapes, pinned verbatim by spec/2026-05-26-597 so log
    // scrapers keep matching the existing `'all'` text.
    const message =
      field === 'all'
        ? `ProjectFieldSchemaError: all ${itemCount} project items resolved every ` +
            `single-select field to null (threshold: ${SCHEMA_DRIFT_MIN_ISSUE_COUNT}+). ` +
            `The most likely cause is that one of the ` +
            `Status / Priority / Effort / Blocked on field labels was renamed. ` +
            `Re-run \`gh project field-list 1 --owner Jinn-Network --format json\` ` +
            `to discover the current field labels and update the snapshot query.`
        : `ProjectFieldSchemaError: field '${field}' returned null for all ${itemCount} Issues ` +
            `(threshold: ${SCHEMA_DRIFT_MIN_ISSUE_COUNT}+). Likely renamed in the Project — ` +
            `re-run \`gh project field-list 1 --owner Jinn-Network --format json\` ` +
            `to discover the current label and update the snapshot query.`;
    super(message);
    this.name = 'ProjectFieldSchemaError';
    this.field = field;
  }
}

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
  organization(login: "${ORG}") {
    projectV2(number: ${PROJECT_NUMBER}) {
      sprintField: field(name: "Sprint") {
        ... on ProjectV2IterationField {
          configuration {
            iterations { id startDate duration }
          }
        }
      }
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            __typename
            ... on Issue { number issueType { name } blockedBy(first: 20) { nodes { number } } }
            ... on PullRequest { number }
          }
          status:    fieldValueByName(name: "Status")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          priority:  fieldValueByName(name: "Priority")   { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          effort:    fieldValueByName(name: "Effort")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          blockedOn: fieldValueByName(name: "Blocked on") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          sprint:    fieldValueByName(name: "Sprint")     { ... on ProjectV2ItemFieldIterationValue { iterationId } }
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

interface IterationValue {
  iterationId: string;
}

interface ResponseNode {
  id: string;
  content: ResponseContent | null;
  status: SingleSelectValue | null;
  priority: SingleSelectValue | null;
  effort: SingleSelectValue | null;
  blockedOn: SingleSelectValue | null;
  sprint: IterationValue | null;
}

interface ResponseContent {
  __typename: string;
  number?: number;
  issueType?: { name: string } | null;
  /** GitHub native issue-dependency edges — issues this Issue is blocked_by. */
  blockedBy?: { nodes: Array<{ number?: number } | null> } | null;
}

interface IterationConfig {
  id: string;
  startDate: string;   // YYYY-MM-DD
  duration: number;    // days
}

interface SnapshotResponse {
  data: {
    rateLimit: RateLimitInfo & { cost?: number };
    organization: {
      projectV2: {
        sprintField: {
          configuration: { iterations: IterationConfig[] };
        } | null;
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
// Parsers live here, not in `issue-source.ts`. The `toIssueBoardState` adapter
// (below) projects parsed `SnapshotItem` values into `IssueBoardEntry` objects
// that the seam consumes (#600). An unknown field value (a new option added on
// the Project board that the dispatcher doesn't recognise yet) coerces to
// `null` rather than corrupting the typed snapshot.
// ---------------------------------------------------------------------------

const VALID_SHAPES = new Set<string>([
  'feat', 'fix', 'refactor', 'spike', 'chore', 'docs', 'test', 'incident', 'design',
]);

const VALID_BLOCKED_ON = new Set<string>(['Nothing', 'Human', 'Another issue']);
const VALID_EFFORT = new Set<string>(['Low', 'Medium', 'High', 'XHigh', 'Max']);
const VALID_PRIORITY = new Set<string>(['P0', 'P1', 'P2', 'P3', 'P4']);
const VALID_STATUS = new Set<string>(['Todo', 'In Progress', 'Human', 'In Review', 'Done']);

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
  const blockedByIssues =
    contentType === 'Issue'
      ? (node.content.blockedBy?.nodes ?? [])
          .map((n) => n?.number)
          .filter((n): n is number => typeof n === 'number')
      : [];
  return {
    id: node.id,
    number,
    contentType,
    status: parseSingleSelect<ProjectStatus>(node.status, VALID_STATUS),
    priority: parseSingleSelect<Priority>(node.priority, VALID_PRIORITY),
    effort: parseSingleSelect<Effort>(node.effort, VALID_EFFORT),
    blockedOn: parseSingleSelect<BlockedOn>(node.blockedOn, VALID_BLOCKED_ON),
    issueType,
    blockedByIssues,
    sprintIterationId: node.sprint?.iterationId ?? null,
  };
}

/**
 * Resolve which configured iteration *contains* `nowMs`. Returns the
 * iteration id, or `null` when no iteration's date window contains the
 * timestamp (no active sprint right now).
 *
 * GitHub returns active+future iterations in `field.configuration.iterations`
 * sorted by start date; past iterations live in `completedIterations` and
 * are not included here (they shouldn't be picked as "current"). We still
 * iterate through every entry rather than assuming `[0]` is current — a
 * not-yet-started future sprint must not be treated as current.
 *
 * Exported for testability so the date-window logic can be exercised
 * without freezing system time.
 */
export function resolveCurrentSprintIterationId(
  iterations: IterationConfig[],
  nowMs: number,
): string | null {
  for (const it of iterations) {
    const start = Date.parse(`${it.startDate}T00:00:00Z`);
    if (!Number.isFinite(start)) continue;
    const end = start + it.duration * 86_400_000;
    if (nowMs >= start && nowMs < end) return it.id;
  }
  return null;
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
  /** Override "now" for the current-sprint resolver. Tests pass a fixed
   *  timestamp; production calls omit this and {@link Date.now} is used. */
  nowMs?: number;
}

export async function fetchProjectSnapshot(
  runner: CommandRunner,
  opts: FetchOpts = {},
): Promise<ProjectSnapshot> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const nowMs = opts.nowMs ?? Date.now();
  const items: SnapshotItem[] = [];
  let rateLimit: RateLimitInfo | null = null;
  let sprintIterations: IterationConfig[] = [];
  let cursor: string | null = null;
  let issueCount = 0;
  let issuesWithAllFieldsNull = 0;
  let issuesWithNullStatus = 0;
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
    // AUTOPILOT_DEBUG_RATELIMIT=1. Used at PR-time to verify the AC's
    // "≤2 GraphQL points per cycle" against the live project. Off by default
    // to keep normal-run logs clean.
    if (process.env.AUTOPILOT_DEBUG_RATELIMIT === '1') {
      const c = response.data.rateLimit.cost;
      console.debug(
        `[autopilot] rateLimit.cost=${c ?? '?'} remaining=${response.data.rateLimit.remaining} ` +
          `(page items=${pageItems.nodes.length}, hasNext=${pageItems.pageInfo.hasNextPage})`,
      );
    }

    for (const node of pageItems.nodes) {
      const item = parseNode(node);
      if (item == null) continue;
      items.push(item);
      if (item.contentType === 'Issue') {
        issueCount += 1;
        if (item.status == null) {
          issuesWithNullStatus += 1;
        }
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
    // Sprint configuration is duplicated on every page (it's a project-level
    // field, not a per-item value). Capture from the first page that has it;
    // a missing/absent `Sprint` field collapses every iteration list to []
    // and the snapshot's `currentSprintIterationId` ends up null — sprint
    // ordering then becomes a no-op (#609).
    const sprintField = response.data.organization.projectV2.sprintField;
    if (sprintField != null) {
      sprintIterations = sprintField.configuration.iterations;
    }

    if (!pageItems.pageInfo.hasNextPage || pageItems.pageInfo.endCursor == null) break;
    cursor = pageItems.pageInfo.endCursor;
  }

  // Schema-drift checks. Evaluate `'all'` first so its more informative
  // catastrophic message wins when both branches would fire. The per-field
  // check is Status-only by design (see ProjectFieldSchemaError docstring +
  // spec/2026-05-26-597).
  if (issueCount >= SCHEMA_DRIFT_MIN_ISSUE_COUNT) {
    if (issueCount === issuesWithAllFieldsNull) {
      throw new ProjectFieldSchemaError(issueCount, 'all');
    }
    if (issueCount === issuesWithNullStatus) {
      throw new ProjectFieldSchemaError(issueCount, 'Status');
    }
  }

  // Defensive: if no pages returned (shouldn't happen — empty boards still
  // produce a response with rateLimit), default to a zero-budget marker so
  // the rate-limit gate fails closed rather than silently passing.
  return {
    items,
    rateLimit: rateLimit ?? { remaining: 0, used: 0, resetAt: '' },
    currentSprintIterationId: resolveCurrentSprintIterationId(sprintIterations, nowMs),
  };
}

// ---------------------------------------------------------------------------
// IssueBoardState adapter (#600)
// ---------------------------------------------------------------------------

/**
 * Project a {@link ProjectSnapshot} down to the abstract {@link IssueBoardState}
 * the seam consumes (#600). Non-Issue items (PRs, DraftIssues) are dropped so
 * every entry surfaced via `getIssue` is guaranteed Issue-typed.
 */
export function toIssueBoardState(snapshot: ProjectSnapshot): IssueBoardState {
  const byNumber = new Map<number, IssueBoardEntry>();
  for (const item of snapshot.items) {
    if (item.contentType !== 'Issue') continue;
    byNumber.set(item.number, {
      id: item.id,
      status: item.status,
      priority: item.priority,
      effort: item.effort,
      blockedOn: item.blockedOn,
      issueType: item.issueType,
      blockedByIssues: item.blockedByIssues,
      sprintIterationId: item.sprintIterationId,
    });
  }
  return {
    getIssue(issueNumber: number): IssueBoardEntry | null {
      return byNumber.get(issueNumber) ?? null;
    },
    currentSprintIterationId: snapshot.currentSprintIterationId,
  };
}
