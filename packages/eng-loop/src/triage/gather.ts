/**
 * Triage reality-check — signal gatherer.
 *
 * Issues the four shell commands documented in
 * `.claude/skills/implement-issue/SKILL.md` Step 1.5 and reduces their
 * output to a {@link RealityCheckInput} suitable for the pure-function
 * classifier in `reality-check.ts`.
 *
 * Sequence:
 *
 *   1. `git fetch --all --quiet`                                   (once)
 *   2. `gh search prs "#<N> in:body" --repo Jinn-Network/mono --json number,body`
 *      (no `--state` flag — `gh search prs` rejects `--state all`; its
 *      default already returns both open and closed PRs, which is what the
 *      classifier needs. The JSON projection is narrow because
 *      `gh search prs --json` does not expose `headRefName` / `mergedAt` /
 *      `mergeCommit`; those are fetched per-PR in step 3.)
 *   3. for each PR number found in step 2:
 *      `gh pr view <n> --repo Jinn-Network/mono
 *        --json number,state,title,headRefName,mergedAt,closedAt,body,mergeCommit`
 *   4. `gh issue view <N> --json closedByPullRequestsReferences`
 *   5. `git log --all --grep="#<N>" --format="%H%x09%D%x09%s"`
 *   6. for each commit SHA: `git branch -a --contains <sha>`
 *
 * Failures from any of the above are re-thrown — fail-loud per the design
 * note. The classifier never sees partial data.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { REVERT_SUBJECT_RE } from './reality-check.js';
import type {
  CommitSignal,
  PrSignal,
  RealityCheckInput,
  SideBranchKind,
  TrunkBranch,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conventional-Commits closure keywords. Case-insensitive. */
const CLOSE_KEYWORD_RE = (issueNumber: number): RegExp =>
  new RegExp(`\\b(?:Closes|Fixes|Resolves)\\s+#${issueNumber}\\b`, 'i');

/** Word-boundary digit-safe issue-reference regex. */
const ISSUE_REF_RE = (issueNumber: number): RegExp =>
  new RegExp(`#${issueNumber}\\b`);

// ---------------------------------------------------------------------------
// gh response shapes
// ---------------------------------------------------------------------------

/**
 * `gh search prs --json number,body` — the only fields `gh search prs --json`
 * supports that we need for discovery + closure-keyword detection. Other
 * fields (`headRefName`, `mergedAt`, `mergeCommit`) are not exposed by
 * `gh search prs` and must be fetched via `gh pr view`.
 */
interface GhSearchPrLite {
  number: number;
  body: string;
}

/** `gh pr view <n> --json …` — the per-PR detail call supports all fields. */
interface GhPrView {
  number: number;
  state: string; // "OPEN" | "MERGED" | "CLOSED" — gh normalises uppercase
  title: string;
  headRefName: string;
  body: string;
  mergeCommit: { oid: string } | null;
  mergedAt: string | null;
  closedAt: string | null;
}

/**
 * `gh issue view <n> --json closedByPullRequestsReferences` returns the
 * field as a flat array of PR refs, not the GraphQL `{nodes: […]}` wrapper.
 * Live shape:
 *
 *   {"closedByPullRequestsReferences":[{"id":"…","number":613,"repository":{…},"url":"…"}]}
 */
interface GhIssueViewClosedByRefs {
  closedByPullRequestsReferences?: { number: number }[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function gatherRealityCheckSignals(
  issueNumber: number,
  runner: CommandRunner,
): Promise<RealityCheckInput> {
  // Defense-in-depth: the CLI shim already validates the issue number, but
  // any future programmatic caller that bypasses it would otherwise let a
  // bogus value through into shell-command argv. Fail closed instead.
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `gatherRealityCheckSignals: issueNumber must be a positive integer, got ${String(issueNumber)}`,
    );
  }

  // 1. Refresh local refs once. Fail-loud on error (git fetch never throws
  //    for transient network blips when --quiet is set; an exit code here
  //    means something genuinely wrong).
  await runner('git', ['fetch', '--all', '--quiet']);

  // 2. PR numbers via search. The search API supports a narrow set of JSON
  //    fields; per-PR detail (headRefName / mergeCommit / mergedAt /
  //    closedAt) comes from `gh pr view` in step 3.
  const prsSearchRaw = await runner('gh', [
    'search', 'prs',
    `#${issueNumber} in:body`,
    '--repo', REPO,
    '--json', 'number,body',
    '--limit', '50',
  ]);
  const prsLite: GhSearchPrLite[] = parseJsonArray(prsSearchRaw);

  // 3. Per-PR detail for each unique PR number found in the search. Dedup
  //    defensively in case the search ever returns duplicates.
  const seenPrNums = new Set<number>();
  const prsDetail: GhPrView[] = [];
  for (const lite of prsLite) {
    if (seenPrNums.has(lite.number)) continue;
    seenPrNums.add(lite.number);
    const viewRaw = await runner('gh', [
      'pr', 'view', String(lite.number),
      '--repo', REPO,
      '--json', 'number,state,title,headRefName,mergedAt,closedAt,body,mergeCommit',
    ]);
    prsDetail.push(safeJsonObject<GhPrView>(viewRaw));
  }

  // 4. closedByPullRequestsReferences via gh issue view.
  const issueViewRaw = await runner('gh', [
    'issue', 'view', String(issueNumber),
    '--repo', REPO,
    '--json', 'closedByPullRequestsReferences',
  ]);
  const issueView: GhIssueViewClosedByRefs = safeJsonObject(issueViewRaw);
  const closedByPrNumbers: number[] =
    issueView.closedByPullRequestsReferences?.map((n) => n.number) ?? [];
  const closedBySet = new Set<number>(closedByPrNumbers);

  // 5. Commits via git log.
  const logRaw = await runner('git', [
    'log', '--all',
    `--grep=#${issueNumber}`,
    '--format=%H%x09%D%x09%s',
  ]);
  const rawCommits = parseGitLog(logRaw);
  // Digit-boundary filter — drop subjects whose only reference is something
  // like (#5721) when we're looking for #572.
  const issueRe = ISSUE_REF_RE(issueNumber);
  const relevantCommits = rawCommits.filter((c) => issueRe.test(c.subject));

  // 6. For each commit, list containing branches.
  const commits: CommitSignal[] = [];
  for (const c of relevantCommits) {
    const branchOut = await runner('git', ['branch', '-a', '--contains', c.sha]);
    const reachableFrom = bucketBranches(branchOut);
    commits.push({
      sha: c.sha,
      subject: c.subject,
      isRevert: REVERT_SUBJECT_RE.test(c.subject),
      reachableFrom,
    });
  }

  // Convert PRs to PrSignals.
  const closeRe = CLOSE_KEYWORD_RE(issueNumber);
  const prs: PrSignal[] = prsDetail.map((p) => ({
    number: p.number,
    state: normalisePrState(p.state),
    mergeCommitOid: p.mergeCommit?.oid ?? null,
    bodyClosesIssue: closedBySet.has(p.number) || closeRe.test(p.body ?? ''),
    headRefName: p.headRefName,
    title: p.title,
  }));

  return {
    issueNumber,
    closedByPrNumbers,
    prs,
    commits,
  };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function normalisePrState(s: string): PrSignal['state'] {
  const up = s.toUpperCase();
  if (up === 'OPEN' || up === 'MERGED' || up === 'CLOSED') return up;
  // Unknown state — treat as CLOSED so we don't accidentally classify an
  // odd value as OPEN.
  return 'CLOSED';
}

function parseJsonArray<T>(raw: string): T[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array; got: ${typeof parsed}`);
  }
  return parsed as T[];
}

function safeJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  if (trimmed === '') return {} as T;
  return JSON.parse(trimmed) as T;
}

interface RawCommit {
  sha: string;
  subject: string;
}

function parseGitLog(raw: string): RawCommit[] {
  const out: RawCommit[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    // Format: %H<TAB>%D<TAB>%s — we only keep sha and subject; the
    // decoration (%D) is ignored because containment is recomputed via
    // `git branch -a --contains <sha>`.
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [sha, , ...subjectParts] = parts;
    out.push({
      sha: sha.trim(),
      // Subject may itself contain tabs (rare but possible); rejoin them.
      subject: subjectParts.join('\t').trim(),
    });
  }
  return out;
}

/**
 * Reduce `git branch -a --contains <sha>` output to the buckets the
 * classifier cares about.
 *
 * Real shape (one branch per line, leading `*` for the current branch,
 * plus two spaces of indent):
 *
 *     * main
 *       feat/local-thing
 *       remotes/origin/next
 *       remotes/origin/release/v2026.05.25
 *
 * Only remote branches under `origin/` are considered — local branches are
 * the operator's working state and shouldn't determine whether the fix has
 * landed.
 */
function bucketBranches(raw: string): CommitSignal['reachableFrom'] {
  const trunkSet = new Set<TrunkBranch>();
  const side: { kind: SideBranchKind; name: string }[] = [];

  for (const line of raw.split('\n')) {
    const branch = line.replace(/^\*?\s+/, '').trim();
    if (branch === '') continue;
    // Strip the "remotes/origin/" prefix if present; ignore non-origin refs.
    const m = branch.match(/^remotes\/origin\/(.+)$/);
    if (m == null) continue;
    const remote = m[1];

    if (remote === 'next') {
      trunkSet.add('next');
    } else if (remote === 'main') {
      trunkSet.add('main');
    } else if (remote.startsWith('release/')) {
      side.push({ kind: 'release', name: remote });
    } else if (remote.startsWith('hotfix/')) {
      side.push({ kind: 'hotfix', name: remote });
    }
    // All other refs (feat/*, refs/pull/*, etc.) are ignored.
  }

  return {
    trunk: Array.from(trunkSet),
    side,
  };
}
