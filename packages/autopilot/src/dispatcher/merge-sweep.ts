import type { CommandRunner } from './issue-source.js';
import { parseOwnedPrefixes, touchesCodeOwnedPath } from './code-owned.js';
import { REPO } from './constants.js';

/**
 * Auto-merge sweep (#1735) — the last mile of the review pipeline.
 *
 * `review-pr` approves + un-drafts a clean PR, but nothing merged it: per the
 * original AI-rule 4 every merge waited for a human, which was the single
 * biggest latency in the loop. Operator decision (Ritsu, 2026-07-15) carves
 * out a narrow exception, amended in `docs/engineering/handbook.md`: a PR may
 * merge automatically iff ALL of
 *
 *   - it carries the engine review label (pipeline PRs only),
 *   - it is not a draft (review-pr's un-draft IS the merge-ready signal),
 *   - its author is on the dispatch allowlist,
 *   - reviewDecision is APPROVED (an independent engine review, distinct
 *     login, satisfies branch protection),
 *   - it does not carry `review:needs-human` (advisory-mode PRs),
 *   - every reported status check succeeded (nothing pending, nothing failed),
 *   - GitHub reports it MERGEABLE with a CLEAN / HAS_HOOKS merge state, and
 *   - it touches NO code-owned path (per `.github/CODEOWNERS` read from the
 *     trusted `origin/next` ref — DR-2026-06-03: an agent approval never
 *     satisfies the code-owner gate). Fail-safe: unreadable CODEOWNERS or an
 *     unreadable file list ⇒ treated as code-owned ⇒ never merged here.
 *
 * A `BEHIND` PR gets exactly one `gh pr update-branch` (tracked in
 * `attemptedUpdateBranch`, owned by the orchestrator across cycles) — CI
 * re-runs on the update and the PR merges on a later cycle. Still behind
 * after that → surfaced, not retried forever.
 *
 * Best-effort per PR; a failure is logged and reported, never fatal.
 */

export interface MergeCandidate {
  number: number;
  title: string;
  isDraft: boolean;
  author: string;
  labels: string[];
  reviewDecision: string;
  mergeable: string;
  mergeStateStatus: string;
  headRefName: string;
  headRefOid: string;
  statusChecks: RollupEntry[];
}

/** One entry of gh's statusCheckRollup — CheckRun or StatusContext shape. */
export interface RollupEntry {
  status?: string; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED
  conclusion?: string; // CheckRun: SUCCESS | FAILURE | SKIPPED | NEUTRAL | …
  state?: string; // StatusContext: SUCCESS | FAILURE | PENDING | …
}

export const NEEDS_HUMAN_LABEL = 'review:needs-human';
const GREEN_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS']);

/** 'green' | 'pending' | 'failed' over the whole rollup. */
export function rollupVerdict(checks: RollupEntry[]): 'green' | 'pending' | 'failed' {
  if (checks.length === 0) return 'pending'; // no checks reported yet — wait, don't merge blind
  let verdict: 'green' | 'pending' | 'failed' = 'green';
  for (const c of checks) {
    if (c.state != null) {
      // StatusContext
      if (c.state === 'SUCCESS') continue;
      if (c.state === 'PENDING' || c.state === 'EXPECTED') {
        if (verdict === 'green') verdict = 'pending';
        continue;
      }
      return 'failed';
    }
    // CheckRun
    if (c.status !== 'COMPLETED') {
      if (verdict === 'green') verdict = 'pending';
      continue;
    }
    if (!GREEN_CONCLUSIONS.has(c.conclusion ?? '')) return 'failed';
  }
  return verdict;
}

/**
 * Classify one candidate. Returns 'eligible', 'behind' (one update-branch
 * allowed), or a human-readable skip reason.
 */
export function classifyCandidate(
  c: MergeCandidate,
  authorAllowlist: ReadonlySet<string>,
): 'eligible' | 'behind' | string {
  if (c.isDraft) return `PR #${c.number}: still draft (not review-approved yet)`;
  if (!authorAllowlist.has(c.author.toLowerCase()))
    return `PR #${c.number}: author ${c.author} not on the allowlist`;
  if (c.labels.includes(NEEDS_HUMAN_LABEL))
    return `PR #${c.number}: labeled ${NEEDS_HUMAN_LABEL} — a human code owner merges it`;
  if (c.reviewDecision !== 'APPROVED')
    return `PR #${c.number}: reviewDecision=${c.reviewDecision}`;
  const ci = rollupVerdict(c.statusChecks);
  if (ci !== 'green') return `PR #${c.number}: checks ${ci}`;
  if (c.mergeable !== 'MERGEABLE') return `PR #${c.number}: mergeable=${c.mergeable}`;
  if (c.mergeStateStatus === 'BEHIND') return 'behind';
  if (!MERGEABLE_STATES.has(c.mergeStateStatus))
    return `PR #${c.number}: mergeStateStatus=${c.mergeStateStatus}`;
  return 'eligible';
}

/**
 * Why a PR that already cleared review can no longer be merged by the sweep.
 * `conflicting` — GitHub reports a textual conflict against `next`.
 * `still-behind` — behind `next` and its one `update-branch` attempt did not
 *   catch it up (a conflicting update-branch, or the base advanced again).
 * `update-branch-failed` — the `update-branch` call itself errored (commonly
 *   because the update would conflict).
 */
export type StuckReason = 'conflicting' | 'still-behind' | 'update-branch-failed';

/** A merge candidate the sweep cannot merge and cannot self-heal — the input
 *  to deterministic needs-human escalation (Stage A) and to the merge-prep
 *  session (Stage B). */
export interface StuckPr {
  number: number;
  title: string;
  reason: StuckReason;
  headRefName: string;
  headRefOid: string;
  /** `review:needs-human` is already on the PR — already escalated (or an
   *  advisory-mode PR); do not re-escalate and do not prep. */
  escalated: boolean;
}

/**
 * Detect a *conflicting* stuck PR, INDEPENDENTLY of the `review:needs-human`
 * label. This is deliberate and load-bearing: `classifyCandidate` short-circuits
 * on that label BEFORE the mergeable check, so once escalation applies the label
 * a naive re-classify would go blind to the very conflict that is still stuck.
 * `classifyStuck` re-derives stuckness from the objective merge state so the
 * signal survives its own escalation.
 *
 * A conflicting PR is one that already cleared the review gate — non-draft,
 * allowlist-authored, APPROVED, CI-green — but GitHub reports
 * `mergeable=CONFLICTING` (or `mergeStateStatus=DIRTY`). `mergeable=UNKNOWN` is
 * transient (GitHub still computing) and is never stuck. The `still-behind` and
 * `update-branch-failed` reasons are runtime states, populated inside
 * `syncMerges`, not here.
 */
export function classifyStuck(
  c: MergeCandidate,
  authorAllowlist: ReadonlySet<string>,
): StuckReason | null {
  if (c.isDraft) return null;
  if (!authorAllowlist.has(c.author.toLowerCase())) return null;
  if (c.reviewDecision !== 'APPROVED') return null;
  if (rollupVerdict(c.statusChecks) !== 'green') return null;
  if (c.mergeable === 'CONFLICTING' || c.mergeStateStatus === 'DIRTY') return 'conflicting';
  return null;
}

interface GhListEntry {
  number: number;
  title?: string;
  isDraft: boolean;
  author?: { login?: string };
  labels?: Array<{ name?: string }>;
  reviewDecision?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  headRefName?: string;
  headRefOid?: string;
  statusCheckRollup?: RollupEntry[];
}

export async function fetchMergeCandidates(
  runner: CommandRunner,
  reviewLabel: string,
): Promise<MergeCandidate[]> {
  const raw = await runner('gh', [
    'pr', 'list',
    '--repo', REPO,
    '--state', 'open',
    '--base', 'next',
    '--label', reviewLabel,
    '--json',
    'number,title,isDraft,author,labels,reviewDecision,mergeable,mergeStateStatus,headRefName,headRefOid,statusCheckRollup',
    '--limit', '100',
  ]);
  const entries = JSON.parse(raw) as GhListEntry[];
  return entries.map((e) => ({
    number: e.number,
    title: e.title ?? '',
    isDraft: Boolean(e.isDraft),
    author: e.author?.login ?? '',
    labels: (e.labels ?? []).map((l) => l.name ?? '').filter((n) => n !== ''),
    reviewDecision: e.reviewDecision ?? '',
    mergeable: e.mergeable ?? 'UNKNOWN',
    mergeStateStatus: e.mergeStateStatus ?? 'UNKNOWN',
    headRefName: e.headRefName ?? '',
    headRefOid: e.headRefOid ?? '',
    statusChecks: e.statusCheckRollup ?? [],
  }));
}

/**
 * True when the PR head is behind `next` — or when that cannot be determined
 * (fail-safe: don't merge on stale CI). GitHub only reports
 * `mergeStateStatus=BEHIND` when branch protection has `strict` up-to-date
 * enforcement enabled; `next` runs with `strict=false` (verified live
 * 2026-07-15), so a stale-base PR reports CLEAN with green-but-stale checks —
 * the exact #1730-class hazard, at the merge layer. Compute behind-ness
 * directly instead of trusting the protection settings.
 */
async function isBehindNext(headRefName: string, runner: CommandRunner): Promise<boolean> {
  if (headRefName === '') return true;
  try {
    const raw = await runner('gh', [
      'api', `repos/${REPO}/compare/next...${headRefName}`,
      '--jq', '.behind_by',
    ]);
    const behind = Number(raw.trim());
    return !Number.isFinite(behind) || behind > 0;
  } catch {
    return true;
  }
}

/**
 * True when the PR touches a code-owned path — or when that cannot be
 * determined (fail-safe: uncertainty routes to a human, mirrors
 * review-dispatch).
 */
export async function touchesOwned(prNumber: number, runner: CommandRunner): Promise<boolean> {
  try {
    const [filesRaw, codeowners] = await Promise.all([
      runner('gh', ['pr', 'view', String(prNumber), '--repo', REPO, '--json', 'files']),
      runner('git', ['show', 'origin/next:.github/CODEOWNERS']),
    ]);
    const files = (JSON.parse(filesRaw) as { files?: Array<{ path?: string }> }).files ?? [];
    const paths = files.map((f) => f.path ?? '').filter((p) => p !== '');
    if (paths.length === 0) return true; // unreadable/empty diff → human
    return touchesCodeOwnedPath(paths, parseOwnedPrefixes(codeowners));
  } catch {
    return true;
  }
}

export interface MergeSweepReport {
  merged: number[];
  updatedBranch: number[];
  skipped: string[];
  /** PRs that cleared review but cannot be merged and cannot self-heal —
   *  structured so the orchestrator can escalate (Stage A) or dispatch a
   *  merge-prep session (Stage B) rather than parse the free-text `skipped`. */
  stuck: StuckPr[];
}

/** Build a StuckPr from a candidate; `escalated` reflects the current label. */
function toStuck(c: MergeCandidate, reason: StuckReason): StuckPr {
  return {
    number: c.number,
    title: c.title,
    reason,
    headRefName: c.headRefName,
    headRefOid: c.headRefOid,
    escalated: c.labels.includes(NEEDS_HUMAN_LABEL),
  };
}

export async function syncMerges(
  runner: CommandRunner,
  authorAllowlist: ReadonlySet<string>,
  attemptedUpdateBranch: Set<number>,
  reviewLabel = 'engine:review',
): Promise<MergeSweepReport> {
  const report: MergeSweepReport = { merged: [], updatedBranch: [], skipped: [], stuck: [] };

  let candidates: MergeCandidate[];
  try {
    candidates = await fetchMergeCandidates(runner, reviewLabel);
  } catch (err) {
    console.error('[merge-sweep] candidate fetch failed (skipping this cycle):', err);
    return report;
  }

  for (const c of candidates) {
    // Conflict detection runs independently of classifyCandidate (which is
    // label-blinded by review:needs-human, see classifyStuck).
    if (classifyStuck(c, authorAllowlist) === 'conflicting') {
      report.stuck.push(toStuck(c, 'conflicting'));
    }

    let verdict = classifyCandidate(c, authorAllowlist);

    // Independent stale-base gate: `next` runs strict=false branch protection,
    // so GitHub reports a behind PR as CLEAN — verify up-to-dateness ourselves
    // before trusting its green checks (see isBehindNext).
    if (verdict === 'eligible' && (await isBehindNext(c.headRefName, runner))) {
      verdict = 'behind';
    }

    if (verdict === 'behind') {
      if (attemptedUpdateBranch.has(c.number)) {
        report.skipped.push(`PR #${c.number}: still BEHIND after update-branch — needs a human`);
        report.stuck.push(toStuck(c, 'still-behind'));
        continue;
      }
      try {
        await runner('gh', ['pr', 'update-branch', String(c.number), '--repo', REPO]);
        attemptedUpdateBranch.add(c.number);
        report.updatedBranch.push(c.number);
      } catch (err) {
        console.error(`[merge-sweep] update-branch failed for #${c.number} (continuing):`, err);
        report.stuck.push(toStuck(c, 'update-branch-failed'));
      }
      continue;
    }

    if (verdict !== 'eligible') {
      report.skipped.push(verdict);
      continue;
    }

    if (await touchesOwned(c.number, runner)) {
      report.skipped.push(
        `PR #${c.number}: touches code-owned paths — a human code owner merges it (DR-2026-06-03)`,
      );
      continue;
    }

    // Refuse to merge without a head to pin: gh silently drops an empty
    // `--match-head-commit ''`, which would merge unvalidated — the exact
    // "merge blind" the pin exists to prevent. An eligible OPEN PR always
    // carries a headRefOid, so this is a fail-safe for a malformed payload.
    if (c.headRefOid === '') {
      report.skipped.push(`PR #${c.number}: missing headRefOid — refusing to merge without a validated head pin`);
      continue;
    }

    try {
      // Pin the head we validated: a push landing between the list fetch above
      // and this merge (e.g. a merge-prep session's resolution) must not be
      // merged unvalidated. GitHub rejects the merge if the head has moved.
      await runner('gh', [
        'pr', 'merge', String(c.number),
        '--repo', REPO, '--squash',
        '--match-head-commit', c.headRefOid,
      ]);
      report.merged.push(c.number);
    } catch (err) {
      console.error(`[merge-sweep] merge failed for #${c.number} (continuing):`, err);
      report.skipped.push(`PR #${c.number}: merge command failed — see log`);
    }
  }

  return report;
}
