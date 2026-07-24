import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import type { CommandRunner } from './issue-source.js';
import { REPO } from './constants.js';

/**
 * Creation automation: Autopilot ready-filter as a marketplace TaskSource,
 * issue #1893 / Part 4 of the Stage 1 decomposition in
 * spec/2026-07-20-autopilot-marketplace-execution.md §"Generator".
 *
 * **GitHub-native handoff.** Autopilot stays the single source of readiness
 * truth (Issue Type, Priority, Blocked on, author allowlist, backpressure,
 * concurrency — all computed upstream by `selectReady`/`loop.ts`, unchanged);
 * the daemon stays the only wallet-holder. The handoff between the two sides
 * is entirely GitHub state: an opt-in label (`engine:marketplace`, applied by
 * Autopilot itself — mirrors `engine:review`) plus ONE hidden JSON-in-a-
 * fenced-code-block "marker" comment per issue carrying the frozen snapshot
 * (title + body + base_commit + effort) the daemon-side generator
 * (`client/src/solver-types/jinn-repo-live-auto.ts`) reads to build the
 * live-issue task doc. No shared database, no RPC between the two processes.
 *
 * ── Marker format (and why) ──────────────────────────────────────────────
 *
 * The marker comment is:
 *
 *   <!-- jinn-marketplace-snapshot:v1 issue:<n> hash:<hash> -->
 *
 *   <human-readable prose>
 *
 *   ```json
 *   {"schemaVersion":"jinn-marketplace-snapshot.v1","issueNumber":<n>,...}
 *   ```
 *
 * The raw issue title/body are NEVER interpolated directly into an HTML
 * comment (an issue body containing a literal `-->` would terminate the
 * comment early and let the remainder of the body render as loose markdown —
 * or worse, as a new top-level marker this module would misparse on the next
 * cycle). Instead the full snapshot — including title and body — is
 * `JSON.stringify`d as ONE object and placed inside a fenced ```json code
 * block. `JSON.stringify` escapes every control character (including literal
 * newlines) within string values, so the rendered JSON is always exactly one
 * physical line: no attacker-controlled content — `-->`, backticks, a fake
 * closing fence, an arbitrarily long body — can ever be mistaken for markdown
 * structure or break out of the fence, because none of it ever appears as
 * its own line. The leading HTML-comment line is decorative-but-functional:
 * a cheap `startsWith` check identifies "this is our marker" without parsing
 * JSON, and its `hash:<sha256>` token is a fast eyeball/grep aid — the JSON
 * block is the sole parsed source of truth (`parseMarkerBody`).
 *
 * ── Idempotency (comment identity, not `--edit-last`) ────────────────────
 *
 * `gh issue comment --edit-last` was deliberately NOT used: it edits the
 * *last comment by the authenticated identity*, not "the marker" —  if this
 * identity ever posts any OTHER comment on the same issue afterward (a
 * retraction note, a human reply quoted-replied-to by automation, etc.) that
 * comment would be silently overwritten instead of the actual marker. This
 * module instead reads `comments[].body` via `gh issue view --json comments`,
 * finds the one whose body starts with the marker prefix (by construction
 * there is ever at most one — this module only ever creates one and always
 * updates in place), and extracts its numeric id from the comment's `url`
 * (`.../issues/<n>#issuecomment-<id>`) for a targeted
 * `gh api --method PATCH repos/<repo>/issues/comments/<id>` update.
 *
 * ── Retraction ordering (crash-safe, no double-comment) ──────────────────
 *
 * `retractStaleMarketplaceRoutes` discovers retract candidates by querying
 * every issue currently carrying the label — open OR closed (`gh issue list
 * --label ... --state all`), so a CLOSED issue is never orphaned with the
 * label + stale marker forever (issue #1893 Finding 5) — NOT via the board
 * snapshot (protects the GraphQL budget; this is a REST call). For each
 * candidate no longer in the caller's still-ready set: post the retraction
 * note FIRST (checked for idempotency against a hash-scoped marker prefix so
 * a restart never double-comments), THEN remove the label. This ordering —
 * comment before label removal — means a crash between the two steps leaves
 * the label in place, so the SAME candidate is rediscovered next cycle and
 * the (idempotent) label removal simply completes; posting the note before
 * removing the label is what keeps the note from ever being silently
 * skipped (removing the label first would evict the issue from the very
 * query used to find it, permanently losing the chance to comment if a
 * crash landed between the two steps). A closed issue can never be
 * "ready" (the ready-filter only considers open issues), so it is never
 * mistaken for still-ready by this same check.
 *
 * ── Marker authorship trust (issue #1893 Finding 1 — CRITICAL) ───────────
 *
 * The repo is public: ANY GitHub account can comment on a labeled issue with
 * a body that *looks* like a marker (same `<!-- jinn-marketplace-snapshot:v1`
 * prefix, same fenced JSON shape) but carries attacker-chosen
 * `baseCommit`/`title`/`body`. `findMarker` (below) therefore only accepts a
 * comment as "the existing marker" — for the create/update/self-heal
 * decision in `routeToMarketplace`, and for the idempotency check in
 * `hasRetractionNote` — when the comment's `authorAssociation` (returned by
 * `gh issue view --json comments` per comment) is one of `OWNER`, `MEMBER`,
 * `COLLABORATOR`. Those are the only associations a real write-access
 * identity (a human maintainer or this automation's own bot account, which
 * needs write access to label/comment in the first place) can ever have — an
 * outside forger's comment is `NONE`/`CONTRIBUTOR`/`FIRST_TIME_CONTRIBUTOR`
 * and is never mistaken for the marker. A forged comment that fails this
 * check is simply invisible to `findMarker`: `routeToMarketplace` treats the
 * issue as having no existing marker and posts its own (fresh, correctly
 * authored) one rather than "self-healing" by trusting or PATCHing the
 * forgery.
 *
 * This module deliberately does NOT resolve an exact bot login at this call
 * site (`routeToMarketplace`/`retractStaleMarketplaceRoutes` take only a
 * `CommandRunner`, not a token/identity — unlike the dual-identity review
 * loop in `identity.ts`). `authorAssociation` is the safer, always-available
 * discriminator: it needs no login to be threaded in from the caller, and it
 * is exactly the property that actually matters (a genuine write-access
 * identity), rather than one specific account name. The daemon-side consumer
 * (`client/src/solver-types/jinn-repo-live-auto.ts`) gates on the REST
 * equivalent field (`author_association`, snake_case there — the raw GitHub
 * REST API, vs. `gh`'s own camelCase JSON export here) via its
 * `markerTrustedAssociations` config; **the two sides must be configured
 * with the same trusted-association set** (`OWNER`/`MEMBER`/`COLLABORATOR`
 * here is hardcoded, so the daemon operator's `markerTrustedAssociations`
 * must match) — see that module's doc for its fail-closed default.
 *
 * ── Cancel semantics — soft cancel only (documented here + module callers)
 *
 * There is no on-chain task-cancel path: `TaskCoordinator`'s `Cancelled`
 * enum has zero transitions (verified against the deployed contract).
 * Retraction here is Autopilot-side only: it stops the daemon-side generator
 * from posting NEW tasks for this issue (no label ⇒ generator stops seeing
 * it ⇒ no new buckets) and stops updating the snapshot on further edits. Any
 * task ALREADY posted before retraction stays open with escrow committed
 * until claimed or its window lapses — bounded by `maxClaims=1` on the
 * daemon side, never re-raced. A stale (edited-after-post) task can still be
 * claimed and solved against the OLD snapshot; the delivery→PR bridge's
 * issue-open guard, the mechanical verdict, and human PR review absorb that
 * risk — this module does not and cannot reach back into an in-flight claim.
 */

// ── Constants ────────────────────────────────────────────────────────────

export const DEFAULT_MARKETPLACE_LABEL = 'engine:marketplace';

const MARKER_SCHEMA_VERSION = 'jinn-marketplace-snapshot.v1';
const MARKER_PREFIX = '<!-- jinn-marketplace-snapshot:v1';
const RETRACT_PREFIX_TAG = '<!-- jinn-marketplace-retracted:v1';

const JSON_FENCE_RE = /```json\n([\s\S]*?)\n```/;

// ── Schemas ──────────────────────────────────────────────────────────────

const MarkerPayloadSchema = z.object({
  schemaVersion: z.literal(MARKER_SCHEMA_VERSION),
  issueNumber: z.number().int().positive(),
  snapshotHash: z.string().min(1),
  baseCommit: z.string().min(1),
  effort: z.string().nullable(),
  title: z.string(),
  body: z.string(),
});
type MarkerPayload = z.infer<typeof MarkerPayloadSchema>;

export interface ParsedMarker extends MarkerPayload {
  /** Numeric GitHub comment id, parsed from the comment's `url` field. */
  commentId: string;
}

// ── Public config / result types ────────────────────────────────────────

export interface MarketplaceRouteConfig {
  /** The opt-in label Autopilot applies/removes. Default `engine:marketplace`. */
  label?: string;
  repo?: string;
}

export interface RouteResult {
  issueNumber: number;
  action: 'created' | 'updated' | 'unchanged';
  snapshotHash: string;
}

/** Minimal issue shape `routeToMarketplace` needs — a `ReadyIssue` satisfies this. */
export interface RoutableIssue {
  number: number;
  effort?: string | null;
}

export interface MarketplaceRetractReport {
  retracted: number[];
  skipped: string[];
}

// ── Hashing ──────────────────────────────────────────────────────────────

/** `snapshotHash = sha256(body)` (spec §Generator) — hex digest. */
export function snapshotHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

// ── Marker build / parse ────────────────────────────────────────────────

function buildMarkerComment(args: {
  issueNumber: number;
  hash: string;
  baseCommit: string;
  effort: string | null;
  title: string;
  body: string;
}): string {
  const payload: MarkerPayload = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    issueNumber: args.issueNumber,
    snapshotHash: args.hash,
    baseCommit: args.baseCommit,
    effort: args.effort,
    title: args.title,
    body: args.body,
  };
  // Compact (single-line) JSON.stringify is load-bearing — see module doc:
  // it guarantees no raw newline byte survives inside the fenced block, so
  // nothing inside `title`/`body` can ever masquerade as markdown structure.
  const jsonLine = JSON.stringify(payload);
  return [
    `${MARKER_PREFIX} issue:${args.issueNumber} hash:${args.hash} -->`,
    '',
    `Marketplace snapshot for #${args.issueNumber} — Autopilot Stage 1 Part 4 ` +
      '(spec/2026-07-20-autopilot-marketplace-execution.md §Generator). This comment ' +
      'is machine-managed: Autopilot re-derives and replaces it every cycle from the ' +
      'issue title + body. Editing it by hand has no lasting effect.',
    '',
    '```json',
    jsonLine,
    '```',
  ].join('\n');
}

/** Parse a marker comment body; returns null for anything that is not ours or malformed. */
export function parseMarkerBody(commentBody: string): MarkerPayload | null {
  if (!commentBody.startsWith(MARKER_PREFIX)) return null;
  const m = JSON_FENCE_RE.exec(commentBody);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch {
    return null;
  }
  const parsed = MarkerPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function retractNotePrefix(issueNumber: number, hash: string): string {
  return `${RETRACT_PREFIX_TAG} issue:${issueNumber} hash:${hash} -->`;
}

function retractCommentBody(issueNumber: number, hash: string): string {
  return [
    retractNotePrefix(issueNumber, hash),
    '',
    `Marketplace routing retracted for #${issueNumber} — Autopilot Stage 1 Part 4. ` +
      'The issue no longer passes the ready-filter (unlabeled, blocked, edited off the ' +
      'board, or otherwise no longer dispatchable) and the `engine:marketplace` label ' +
      'has been removed.',
    '',
    'This is a SOFT cancel only: there is no on-chain task-cancel path (the ' +
      '`TaskCoordinator` `Cancelled` enum has zero transitions). Any marketplace task ' +
      `already posted for the prior snapshot (hash \`${hash}\`) stays open — with escrow ` +
      'committed — until it is claimed or its claim window lapses; it is bounded by ' +
      '`maxClaims=1`, never re-raced.',
  ].join('\n');
}

// ── gh comments helpers ──────────────────────────────────────────────────

interface GhComment {
  body?: string;
  url?: string;
  /** `gh issue view --json comments` field: the commenter's GitHub-computed
   *  relationship to the repo (`OWNER`, `MEMBER`, `COLLABORATOR`,
   *  `CONTRIBUTOR`, `NONE`, ...). See module doc "Marker authorship trust". */
  authorAssociation?: string;
}

/** Associations a genuine write-access identity can have — see module doc
 *  "Marker authorship trust" (issue #1893 Finding 1). MUST mirror the set
 *  the daemon-side `markerTrustedAssociations` config is configured with. */
const TRUSTED_MARKER_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function isTrustedMarkerAuthor(comment: GhComment): boolean {
  return comment.authorAssociation != null && TRUSTED_MARKER_ASSOCIATIONS.has(comment.authorAssociation);
}

interface GhIssueView {
  title?: string;
  body?: string;
  labels?: Array<{ name?: string }>;
  comments?: GhComment[];
}

function extractCommentId(url: string | undefined): string | null {
  if (url == null) return null;
  const m = /issuecomment-(\d+)/.exec(url);
  return m ? m[1]! : null;
}

function findMarker(comments: GhComment[]): ParsedMarker | null {
  for (const c of comments) {
    if (c.body == null) continue;
    if (!isTrustedMarkerAuthor(c)) continue; // issue #1893 Finding 1 — never trust a forged marker
    const parsed = parseMarkerBody(c.body);
    if (parsed == null) continue;
    const commentId = extractCommentId(c.url);
    if (commentId == null) continue;
    return { ...parsed, commentId };
  }
  return null;
}

function hasRetractionNote(comments: GhComment[], issueNumber: number, hash: string): boolean {
  const prefix = retractNotePrefix(issueNumber, hash);
  return comments.some((c) => isTrustedMarkerAuthor(c) && (c.body?.startsWith(prefix) ?? false));
}

function hasLabel(labels: Array<{ name?: string }> | undefined, label: string): boolean {
  return (labels ?? []).some((l) => l.name === label);
}

// ── Core: per-issue apply/update ─────────────────────────────────────────

/**
 * Ensure `issue` carries the marketplace label and an up-to-date snapshot
 * marker comment. Called once per ready issue, per cycle (mirrors
 * `dispatchIssue` in local mode — see `loop.ts`'s execution-mode branch).
 * Idempotent: an issue whose body hash is unchanged since the last call is a
 * single cheap read, no writes (`action: 'unchanged'`).
 */
export async function routeToMarketplace(
  issue: RoutableIssue,
  runner: CommandRunner,
  cfg: MarketplaceRouteConfig = {},
): Promise<RouteResult> {
  const label = cfg.label ?? DEFAULT_MARKETPLACE_LABEL;
  const repo = cfg.repo ?? REPO;
  const issueNumber = issue.number;

  const viewRaw = await runner('gh', [
    'issue', 'view', String(issueNumber),
    '--repo', repo,
    '--json', 'title,body,labels,comments',
  ]);
  const view = JSON.parse(viewRaw) as GhIssueView;
  const title = view.title ?? '';
  const body = view.body ?? '';
  const hash = snapshotHash(body);

  const existing = findMarker(view.comments ?? []);
  const effort = issue.effort?.toLowerCase() ?? null;

  if (existing != null && existing.snapshotHash === hash) {
    // Unchanged snapshot. Re-affirm the label defensively (cheap, idempotent)
    // in case it was removed out-of-band without the marker being touched —
    // never fight the retract sweep's own removal, only heal a manual slip.
    // No `base_commit` re-derivation needed — nothing downstream reads it on
    // this path.
    if (!hasLabel(view.labels, label)) {
      await runner('gh', ['issue', 'edit', String(issueNumber), '--repo', repo, '--add-label', label]);
    }
    return { issueNumber, action: 'unchanged', snapshotHash: hash };
  }

  // Only fetch `base_commit` when a new/updated marker will actually be
  // written — the unchanged path above returns before this point.
  const baseCommitRaw = await runner('git', ['rev-parse', 'origin/next']);
  const baseCommit = baseCommitRaw.trim();

  if (!hasLabel(view.labels, label)) {
    await runner('gh', ['issue', 'edit', String(issueNumber), '--repo', repo, '--add-label', label]);
  }

  const commentBody = buildMarkerComment({ issueNumber, hash, baseCommit, effort, title, body });

  if (existing != null) {
    await runner('gh', [
      'api', '--method', 'PATCH',
      `repos/${repo}/issues/comments/${existing.commentId}`,
      '-f', `body=${commentBody}`,
    ]);
    return { issueNumber, action: 'updated', snapshotHash: hash };
  }

  await runner('gh', ['issue', 'comment', String(issueNumber), '--repo', repo, '--body', commentBody]);
  return { issueNumber, action: 'created', snapshotHash: hash };
}

// ── Retract pass (ALL currently-labeled issues, open or closed, not just ready) ─

/**
 * Full retract sweep: query every issue — open OR closed — currently
 * carrying the marketplace label (a single `gh issue list --label --state
 * all` REST call, independent of the board snapshot / ready-filter slicing)
 * and retract any whose number is not in `stillReadyNumbers` — the FULL
 * (unsliced) ready set for this cycle, so an issue merely excluded by this
 * cycle's concurrency/backpressure budget is never mistaken for "no longer
 * ready" (that would flap the label every cycle). Sweeping closed issues too
 * (issue #1893 Finding 5) means a closed issue never keeps the label + stale
 * marker forever — a closed issue is never "ready" (the ready-filter only
 * considers open issues), so it can never be mistaken for still-ready by
 * this same `stillReadyNumbers` check. See module doc for the crash-safe
 * comment-then-label-remove ordering.
 */
export async function retractStaleMarketplaceRoutes(
  stillReadyNumbers: ReadonlySet<number>,
  runner: CommandRunner,
  cfg: MarketplaceRouteConfig = {},
): Promise<MarketplaceRetractReport> {
  const label = cfg.label ?? DEFAULT_MARKETPLACE_LABEL;
  const repo = cfg.repo ?? REPO;
  const report: MarketplaceRetractReport = { retracted: [], skipped: [] };

  let labeledRaw: string;
  try {
    labeledRaw = await runner('gh', [
      'issue', 'list',
      '--repo', repo,
      '--state', 'all', // open AND closed — issue #1893 Finding 5
      '--label', label,
      '--json', 'number',
      '--limit', '200',
    ]);
  } catch (err) {
    report.skipped.push(`retract-scan failed: ${err instanceof Error ? err.message : String(err)}`);
    return report;
  }
  const labeledIssues = (JSON.parse(labeledRaw || '[]') as Array<{ number: number }>).map((r) => r.number);

  for (const issueNumber of labeledIssues) {
    if (stillReadyNumbers.has(issueNumber)) continue;
    try {
      const viewRaw = await runner('gh', [
        'issue', 'view', String(issueNumber),
        '--repo', repo,
        '--json', 'labels,comments',
      ]);
      const view = JSON.parse(viewRaw) as GhIssueView;
      if (!hasLabel(view.labels, label)) continue; // already retracted concurrently — nothing to do

      const comments = view.comments ?? [];
      const marker = findMarker(comments);
      const hash = marker?.snapshotHash ?? 'unknown';

      if (!hasRetractionNote(comments, issueNumber, hash)) {
        await runner('gh', [
          'issue', 'comment', String(issueNumber),
          '--repo', repo,
          '--body', retractCommentBody(issueNumber, hash),
        ]);
      }
      await runner('gh', ['issue', 'edit', String(issueNumber), '--repo', repo, '--remove-label', label]);
      report.retracted.push(issueNumber);
    } catch (err) {
      report.skipped.push(`#${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return report;
}
