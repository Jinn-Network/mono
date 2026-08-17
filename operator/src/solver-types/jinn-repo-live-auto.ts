/**
 * jinn-repo.v1 LIVE-ISSUE generator (issue #1893, Stage 1 Part 4 of
 * spec/2026-07-20-autopilot-marketplace-execution.md §"Generator").
 *
 * Polls Jinn-Network/mono issues carrying the `engine:marketplace` label
 * (applied host-side by Autopilot —
 * `packages/autopilot/src/dispatcher/marketplace-route.ts`) and turns each
 * into a `source: 'live-issue'` jinn-repo.v1 Task. The handoff between
 * Autopilot and this generator is entirely GitHub state — the label
 * (readiness signal) plus ONE hidden JSON-in-a-fenced-code-block "marker"
 * comment carrying the frozen snapshot (title, body, base_commit, effort).
 * This module never talks to Autopilot directly; it only reads what
 * Autopilot wrote, via plain (optionally-authenticated) GitHub REST calls.
 *
 * ── WIRE FORMAT (must track marketplace-route.ts byte-for-byte) ──────────
 *
 * A marker comment body starts with `<!-- jinn-marketplace-snapshot:v1` and
 * contains exactly one fenced ```json code block whose content parses as
 * `{schemaVersion: "jinn-marketplace-snapshot.v1", issueNumber,
 * snapshotHash, baseCommit, effort, title, body}`. There is deliberately NO
 * shared code between `packages/autopilot` and `client` (the client package
 * must not depend on `@jinn-network/autopilot`, and autopilot must not
 * depend on `@jinn-network/operator` — see `delivery-pr-bridge.ts`'s module
 * doc for the identical trade elsewhere in this codebase); the coupling is
 * the documented wire format only, re-parsed independently here.
 *
 * ── Marker authorship trust (issue #1893 Finding 1 — CRITICAL) ────────────
 *
 * `Jinn-Network/mono` is a public repo: ANY GitHub account can comment on a
 * labeled issue with a body that *looks* like a marker (same
 * `<!-- jinn-marketplace-snapshot:v1` prefix, same fenced JSON shape) but
 * carries attacker-chosen `base_commit`/`problem_statement`/`effort`. Left
 * unchecked, this generator would mint a FUNDED, claimable on-chain task from
 * ANY such forgery — the daemon is the wallet-holder, so this is the one
 * place the trust boundary actually matters. `parseMarketplaceMarker` alone
 * only validates *shape*; it says nothing about *authorship*.
 *
 * Every comment is therefore filtered through `isTrustedMarkerAuthor` BEFORE
 * `parseMarketplaceMarker` is even attempted (see the per-issue loop below).
 * Trust is established one of two ways, both configured on
 * `JinnRepoLiveGeneratorConfig`:
 *
 *  - `markerAuthorLogin` — an exact GitHub login (case-insensitive) the
 *    comment's `user.login` (REST field) must match.
 *  - `markerTrustedAssociations` — a set of REST `author_association` values
 *    (`OWNER`, `MEMBER`, `COLLABORATOR`, ...) one of which the comment must
 *    carry. This MUST mirror the set
 *    `packages/autopilot/src/dispatcher/marketplace-route.ts` trusts
 *    autopilot-side (currently hardcoded there to `OWNER`/`MEMBER`/
 *    `COLLABORATOR` — see that module's "Marker authorship trust" doc) or a
 *    legitimate marker will be silently rejected. There is deliberately no
 *    shared import between the two packages (see below); the two constant
 *    sets must be kept in agreement by hand.
 *
 * **Fail closed.** If NEITHER `markerAuthorLogin` nor
 * `markerTrustedAssociations` is configured, `isTrustedMarkerAuthor` trusts
 * NOTHING — every comment is treated as untrusted, so no marker is ever
 * found and no task is ever posted. A missing/misconfigured trust gate must
 * never silently degrade to "trust everyone"; it degrades to "trust no one,"
 * which is loudly visible (labeled issues pile up with a
 * "no valid snapshot marker" warning) rather than silently exploitable.
 *
 * ── Dedup / re-post (the daemon-side half of "cancel + re-post on edit") ─
 *
 * This generator's own state file (mirrors `jinn-repo-auto.ts`'s `posted`
 * counters) tracks the last-posted snapshot hash PER ISSUE NUMBER. A tick
 * emits a fresh Task for an issue only when its CURRENT marker hash differs
 * from the last one this generator posted for that issue — a material edit
 * (new hash) naturally produces a new Task; an unchanged snapshot is a
 * no-op. `<issueNumber>:<snapshotHash>` is also carried on
 * `task.eligibility` (mirrors `eligibility.instance_id` on the retrospective
 * generator) as the intended bucket key for the posting layer's own
 * once-per-bucket dedup — see `operator/src/main.ts`'s `bucketKeyForTask`.
 *
 * ── Retraction (soft cancel only) ─────────────────────────────────────────
 *
 * There is no daemon-side "cancel" logic at all: retraction is Autopilot
 * removing the label. Once removed, the issue is simply absent from the
 * next poll — no new Task is ever built for it again (unless re-labeled with
 * a fresh marker). A Task already posted before retraction is NOT withdrawn
 * — there is no on-chain cancel path (`TaskCoordinator`'s `Cancelled` enum
 * has zero transitions) — it stays open, bounded by `claimPolicy.maxClaims
 * = 1`, until claimed or its window lapses.
 *
 * `claimPolicy.maxClaims = 1`: no racing claims for a live issue (spec Open
 * Decisions: "Leaning maxClaims=1 + re-post while the fleet is closed") —
 * deliberately narrower than the retrospective generator's parallel-racing
 * default (`JINN_REPO_V1_SOLVER_NET_CONTRACT.claimPolicyDefaults`).
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v3';
import type { TaskGenerator } from './solver-type.js';
import type { Task } from '../types/task.js';
import type { TaskClaimPolicy } from '../types/task-document.js';
import type { LaunchedSolverNetRecord } from '../solvernets/store.js';
import { JinnRepoLiveIssueTaskSchema } from './jinn-repo.js';
import { resolvePostingWindowMs } from './_jinn-repo-posting-window.js';
import { resolveDefaultStateDir } from '../state-dir.js';

const SOLVER_TYPE = 'jinn-repo.v1';
const CONTRACT_ID = 'jinn-repo';
const CONTRACT_VERSION = 'v1';

const DEFAULT_LABEL = 'engine:marketplace';
const DEFAULT_REPO = 'Jinn-Network/mono';
const DEFAULT_MAX_PER_TICK = 5;
/** Claim lease, mirrors the jinn-repo contract default (coding tasks need more time). */
const DEFAULT_CLAIM_LEASE_TTL_SECONDS = 60 * 60;

const STATE_SCHEMA_VERSION = 'jinn-repo-live-generator-state.v1' as const;

// ── Marker wire format (mirrors marketplace-route.ts — see module doc) ────

const MARKER_SCHEMA_VERSION = 'jinn-marketplace-snapshot.v1';
const MARKER_PREFIX = '<!-- jinn-marketplace-snapshot:v1';
const JSON_FENCE_RE = /```json\n([\s\S]*?)\n```/;

const MarkerPayloadSchema = z.object({
  schemaVersion: z.literal(MARKER_SCHEMA_VERSION),
  issueNumber: z.number().int().positive(),
  snapshotHash: z.string().min(1),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/, 'base_commit must be a 40-char hex SHA'),
  effort: z.string().nullable(),
  title: z.string(),
  body: z.string(),
});
export type MarketplaceMarkerPayload = z.infer<typeof MarkerPayloadSchema>;

/**
 * Parse a marker comment body; returns null for anything that is not ours,
 * malformed, or carries a `base_commit` this generator cannot use (never
 * throws — a bad/foreign comment is just not a marker, never a hard error).
 */
export function parseMarketplaceMarker(commentBody: string): MarketplaceMarkerPayload | null {
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

// ── GitHub REST reads (injectable — mirrors task-creator/environment/github.ts) ─

export type GitHubFetch = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface GhIssueListEntry {
  number: number;
}

interface GhComment {
  body?: string;
  /** REST field: `GET /repos/{repo}/issues/{n}/comments` returns `user.login`. */
  user?: { login?: string };
  /** REST field: the commenter's GitHub-computed relationship to the repo
   *  (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, ...). See
   *  module doc "Marker authorship trust". */
  author_association?: string;
}

/**
 * Trust gate for "is this comment's author allowed to author a marker" —
 * see module doc "Marker authorship trust" (issue #1893 Finding 1). Fails
 * closed: with neither `markerAuthorLogin` nor `markerTrustedAssociations`
 * configured, nothing is trusted.
 */
export function isTrustedMarkerAuthor(
  comment: GhComment,
  markerAuthorLogin: string | undefined,
  markerTrustedAssociations: readonly string[] | undefined,
): boolean {
  if (markerAuthorLogin) {
    return (comment.user?.login ?? '').toLowerCase() === markerAuthorLogin.toLowerCase();
  }
  if (markerTrustedAssociations && markerTrustedAssociations.length > 0) {
    return comment.author_association != null && markerTrustedAssociations.includes(comment.author_association);
  }
  return false; // fail closed — no trust config configured ⇒ trust nothing
}

async function fetchJson(
  fetchImpl: GitHubFetch,
  url: string,
  headers: Record<string, string>,
  resource: string,
): Promise<unknown> {
  let response: Awaited<ReturnType<GitHubFetch>>;
  try {
    response = await fetchImpl(url, { headers });
  } catch (err) {
    throw new Error(`GitHub ${resource} request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response || !response.ok) {
    throw new Error(`GitHub ${resource} request failed (status ${String(response?.status)})`);
  }
  try {
    return await response.json();
  } catch (err) {
    throw new Error(`malformed GitHub ${resource} response: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Generator state (dedup by issue number → last posted snapshot hash) ──

interface StateFile {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  issues: Record<string, { lastPostedHash: string }>;
}

function stateFilePath(stateDir: string): string {
  return join(stateDir, 'jinn-repo-live-generator-state.json');
}

async function readState(stateDir: string): Promise<StateFile> {
  try {
    const raw = await readFile(stateFilePath(stateDir), 'utf8');
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed && typeof parsed === 'object' && parsed.issues) return parsed;
  } catch {
    // absent or unreadable — start empty
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, issues: {} };
}

async function writeStateAtomic(stateDir: string, state: StateFile): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const target = stateFilePath(stateDir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, target);
}

// ── Task assembly ──────────────────────────────────────────────────────────

const EFFORT_ENUM = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type SchemaEffort = (typeof EFFORT_ENUM)[number];

/** Board Effort ('Low'|'XHigh'|...) or an already-lowercase marker value → the schema enum. */
function normalizeEffort(effort: string | null): SchemaEffort | undefined {
  if (effort == null) return undefined;
  const lowered = effort.toLowerCase();
  return (EFFORT_ENUM as readonly string[]).includes(lowered) ? (lowered as SchemaEffort) : undefined;
}

function instanceIdFor(repo: string, issueNumber: number, hash: string): string {
  const repoSlug = repo.replace('/', '__');
  return `${repoSlug}-issue-${issueNumber}-${hash.slice(0, 12)}`;
}

function jinnRepoLiveClaimPolicy(claimLeaseTtlSeconds: number): TaskClaimPolicy {
  return {
    mode: 'exclusive',
    maxClaims: 1,
    maxClaimsPerOperator: 1,
    claimLeaseTtlSeconds,
  };
}

export interface JinnRepoLiveGeneratorConfig {
  stateDir: string;
  solverNetManifestCid?: string;
  /** The opt-in label Autopilot applies. Default `engine:marketplace`. */
  label?: string;
  /** Default `Jinn-Network/mono`. */
  repo?: string;
  /** Max tasks emitted per tick (default 5). */
  maxPerTick?: number;
  /** Injectable for tests — never real network in a test process. */
  fetchImpl?: GitHubFetch;
  /** Optional GitHub token — public reads work unauthenticated, but a token
   *  raises the REST rate-limit ceiling for a long-lived poller. */
  token?: string;
  claimLeaseTtlSeconds?: number;
  /**
   * Exact GitHub login (case-insensitive) a marker comment's author must
   * match. Takes precedence over `markerTrustedAssociations` when both are
   * set. See module doc "Marker authorship trust" (issue #1893 Finding 1) —
   * with NEITHER this nor `markerTrustedAssociations` configured, every
   * comment is untrusted and no task is ever posted (fail closed).
   */
  markerAuthorLogin?: string;
  /**
   * Allowed `author_association` values (GitHub REST enum: `OWNER`,
   * `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, ...) for a marker
   * comment's author. MUST mirror the set
   * `packages/autopilot/src/dispatcher/marketplace-route.ts` trusts
   * autopilot-side (currently `OWNER`/`MEMBER`/`COLLABORATOR`) or a
   * legitimate marker will be silently rejected. See module doc "Marker
   * authorship trust".
   */
  markerTrustedAssociations?: string[];
  /** Solve / posting window duration in ms (default: six hours). */
  postingWindowMs?: number;
}

export function makeJinnRepoLiveGenerator(config: JinnRepoLiveGeneratorConfig): TaskGenerator {
  const label = config.label ?? DEFAULT_LABEL;
  const repo = config.repo ?? DEFAULT_REPO;
  const maxPerTick = config.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const postingWindowMs = resolvePostingWindowMs(config.postingWindowMs);
  const fetchImpl = config.fetchImpl ?? fetch;
  const claimPolicy = jinnRepoLiveClaimPolicy(config.claimLeaseTtlSeconds ?? DEFAULT_CLAIM_LEASE_TTL_SECONDS);
  const markerAuthorLogin = config.markerAuthorLogin;
  const markerTrustedAssociations = config.markerTrustedAssociations;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
  };

  return async (): Promise<Task[] | null> => {
    const state = await readState(config.stateDir);

    let labeled: GhIssueListEntry[];
    try {
      const url =
        `https://api.github.com/repos/${repo}/issues?labels=${encodeURIComponent(label)}` +
        '&state=open&per_page=100';
      const raw = await fetchJson(fetchImpl, url, headers, 'labeled issues');
      labeled = Array.isArray(raw) ? (raw as GhIssueListEntry[]) : [];
    } catch (err) {
      console.warn(
        `[jinn-repo-live-gen] labeled-issue poll failed (skipping this tick): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    const now = Date.now();
    const windowEndTs = now + postingWindowMs;
    const tasks: Task[] = [];

    for (const entry of labeled) {
      if (tasks.length >= maxPerTick) break;

      let comments: GhComment[];
      try {
        const commentsUrl = `https://api.github.com/repos/${repo}/issues/${entry.number}/comments?per_page=100`;
        const raw = await fetchJson(fetchImpl, commentsUrl, headers, `comments for #${entry.number}`);
        comments = Array.isArray(raw) ? (raw as GhComment[]) : [];
      } catch (err) {
        console.warn(
          `[jinn-repo-live-gen] comment fetch failed for #${entry.number} (skipping this tick): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      // Trust gate BEFORE shape parsing (issue #1893 Finding 1): an untrusted
      // comment is never even offered to parseMarketplaceMarker, no matter
      // how marker-shaped its body is.
      const trustedComments = comments.filter((c) => isTrustedMarkerAuthor(c, markerAuthorLogin, markerTrustedAssociations));
      const marker = trustedComments
        .map((c) => (c.body != null ? parseMarketplaceMarker(c.body) : null))
        .find((m): m is MarketplaceMarkerPayload => m != null) ?? null;

      if (marker == null) {
        const forged = comments.some(
          (c) =>
            !isTrustedMarkerAuthor(c, markerAuthorLogin, markerTrustedAssociations) &&
            c.body != null &&
            parseMarketplaceMarker(c.body) != null,
        );
        if (forged) {
          // A marker-shaped comment exists but its author is untrusted —
          // never throws, but distinct from "no marker yet" for observability.
          console.warn(
            `[jinn-repo-live-gen] #${entry.number} carries a marker-shaped comment from an untrusted author — ignored`,
          );
        } else {
          // Labeled but no valid marker yet (label/comment race, or a foreign
          // label reuse) — never throws, just skipped with a log; the next
          // tick re-checks.
          console.warn(`[jinn-repo-live-gen] #${entry.number} carries "${label}" but no valid snapshot marker — skipped`);
        }
        continue;
      }

      const stateKey = String(marker.issueNumber);
      if (state.issues[stateKey]?.lastPostedHash === marker.snapshotHash) continue; // already posted this exact snapshot

      const instanceId = instanceIdFor(repo, marker.issueNumber, marker.snapshotHash);
      const effort = normalizeEffort(marker.effort);
      const specDoc = JinnRepoLiveIssueTaskSchema.parse({
        schemaVersion: 'jinn-repo.v1',
        source: 'live-issue',
        instance_id: instanceId,
        repo,
        base_commit: marker.baseCommit,
        language: 'typescript',
        problem_statement: `${marker.title}\n\n${marker.body}`,
        issue_number: marker.issueNumber,
        ...(effort ? { effort } : {}),
      });

      tasks.push({
        id: randomUUID(),
        description: `Jinn repo live issue #${marker.issueNumber}: ${marker.title}`,
        solverType: SOLVER_TYPE,
        contractId: CONTRACT_ID,
        contractVersion: CONTRACT_VERSION,
        ...(config.solverNetManifestCid ? { solverNetManifestCid: config.solverNetManifestCid } : {}),
        role: 'restoration',
        window: { startTs: now, endTs: windowEndTs },
        claimPolicy,
        spec: specDoc as unknown as Record<string, unknown>,
        eligibility: { issue_number: marker.issueNumber, snapshot_hash: marker.snapshotHash },
      });

      state.issues[stateKey] = { lastPostedHash: marker.snapshotHash };
    }

    if (tasks.length === 0) return null;
    await writeStateAtomic(config.stateDir, state);
    return tasks;
  };
}

// ── Launched-record wiring (mirrors jinn-repo-auto.ts) ────────────────────

export interface MakeJinnRepoLiveGeneratorForLaunchedRecordOpts {
  recordRef: { current: LaunchedSolverNetRecord };
  staticConfig?: {
    stateDir?: string;
    label?: string;
    repo?: string;
    maxPerTick?: number;
    fetchImpl?: GitHubFetch;
    token?: string;
    /** See `JinnRepoLiveGeneratorConfig.markerAuthorLogin` — issue #1893 Finding 1. */
    markerAuthorLogin?: string;
    /** See `JinnRepoLiveGeneratorConfig.markerTrustedAssociations` — issue #1893 Finding 1. */
    markerTrustedAssociations?: string[];
    postingWindowMs?: number;
  };
}

function defaultStateDir(): string {
  const stateRoot = process.env['JINN_STATE_DIR'];
  if (stateRoot) return join(stateRoot, 'jinn-repo-live');
  return join(resolveDefaultStateDir(), 'jinn-repo-live');
}

export function makeJinnRepoLiveGeneratorForLaunchedRecord(
  opts: MakeJinnRepoLiveGeneratorForLaunchedRecordOpts,
): TaskGenerator {
  const { recordRef, staticConfig = {} } = opts;
  const stateDir =
    staticConfig.stateDir ?? process.env['JINN_JINN_REPO_LIVE_STATE_DIR'] ?? defaultStateDir();

  const postingWindowMs = resolvePostingWindowMs(
    staticConfig.postingWindowMs ??
      recordRef.current.generatorConfig?.['posting_window_ms'],
  );

  const generator = makeJinnRepoLiveGenerator({
    stateDir,
    solverNetManifestCid: recordRef.current.manifestCid,
    label: staticConfig.label,
    repo: staticConfig.repo,
    maxPerTick: staticConfig.maxPerTick,
    fetchImpl: staticConfig.fetchImpl,
    token: staticConfig.token,
    markerAuthorLogin: staticConfig.markerAuthorLogin,
    markerTrustedAssociations: staticConfig.markerTrustedAssociations,
    postingWindowMs,
  });

  return async (): Promise<Task | Task[] | null> => {
    const record = recordRef.current;
    if (record.status !== 'launched') return null;
    if (!record.generatorEnabled) return null;
    return generator();
  };
}
