# Autopilot `review-pr` Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an additive, PR-triggered `review-pr` coordinator to Autopilot (the `eng-loop` dispatcher) that independently reviews and auto-fixes every PR carrying the opt-in `engine:review` label, leaving `implement-issue` essentially untouched.

**Architecture:** A second dispatch pass in `packages/eng-loop`. A new `PrSource` (mirrors `GhIssueSource`) polls labelled open PRs and computes which need (re)review; a new `runReviewCycle` (mirrors `runCycle` in `loop.ts`, no gh/git calls) filters and dispatches; a new `dispatchReview` (mirrors `dispatchIssue`) creates a `pr-<N>` worktree on the PR's head branch and spawns `claude -p` running a new `review-pr` skill. `implement-issue` gains exactly two edits: a `/simplify`→`/code-review` stage rename and a `--label engine:review` flag at PR creation.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, `gh` CLI (REST + Projects), git worktrees. Same seam discipline as the existing dispatcher: all `gh`/`git` I/O behind injected `CommandRunner` / `SpawnFn`; orchestration modules stay I/O-free and unit-tested with call-recording fakes.

**Spec:** `docs/superpowers/specs/2026-05-29-pr-review-loop-design.md`. **Issue:** #889.

**Scope note:** Per the spec's build phasing, this plan is Phase 1 + the `implement-issue` edits. It does NOT change `implement-issue`'s pipeline beyond the two trivial edits, and does NOT touch the deferred follow-ups (#886 per-type recipes, #887 agent routing, #890 headless-session dispatch).

---

## File Structure

**New files:**
- `packages/eng-loop/src/dispatcher/pr-source.ts` — `PrSource` interface + `GhPrSource` (polls labelled PRs, computes `needsReview`). Mirrors `issue-source.ts`.
- `packages/eng-loop/src/dispatcher/review-state.ts` — `deriveReviewInFlight` (finds `pr-<N>` worktrees). Mirrors the worktree-parsing half of `state.ts`.
- `packages/eng-loop/src/dispatcher/review-ready-filter.ts` — `selectReviewable` (label + needsReview + not-in-flight). Mirrors `ready-filter.ts`.
- `packages/eng-loop/src/dispatcher/review-dispatch.ts` — `dispatchReview` (pr-`N` worktree on the head branch, spawn `review-pr`). Mirrors `dispatch.ts`.
- `packages/eng-loop/src/dispatcher/review-loop.ts` — `runReviewCycle` (orchestration, no gh/git). Mirrors `loop.ts`.
- `.claude/skills/review-pr/SKILL.md` — the `review-pr` coordinator skill (prose; mirrors `implement-issue`).
- Tests: `test/dispatcher/pr-source.test.ts`, `review-state.test.ts`, `review-ready-filter.test.ts`, `review-dispatch.test.ts`, `review-loop.test.ts`.

**Modified files:**
- `packages/eng-loop/src/dispatcher/types.ts` — add `PolledPr`, `ReviewablePr`, `InFlightReview`; add `reviewCap`, `engineReviewLabel`, `reviewBotLogin` to `DispatcherConfig` + `DEFAULT_CONFIG`.
- `packages/eng-loop/scripts/run-eng-loop.ts` — wire `runReviewCycle` as a second pass after the issue cycle; read `JINN_REVIEW_BOT_LOGIN`.
- `.claude/skills/implement-issue/SKILL.md` — Stage 4 `/simplify`→`/code-review`; Stage 8 `gh pr create` gains `--label engine:review`.

**Conventions to follow (observed in the codebase):**
- ESM imports use `.js` specifiers even for `.ts` files (e.g. `from './types.js'`).
- Orchestration modules (`loop.ts`, `review-loop.ts`) contain **no** `gh`/`git` calls — all I/O is injected.
- Tests use call-recording fakes: a `CommandRunner` that switches on `(cmd, args)` and returns canned stdout, and a `SpawnFn` that records calls and returns `{ pid }`.
- Run a single test file with: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/<file>.test.ts`.

---

## Task 1: `implement-issue` edits (rename + opt-in label)

**Files:**
- Modify: `.claude/skills/implement-issue/SKILL.md`

This is the entire change to `implement-issue` — two surgical edits, no flow change.

- [ ] **Step 1: Rename the Stage 4 heading and body from `/simplify` to `/code-review`**

In `.claude/skills/implement-issue/SKILL.md`, change the Stage 4 heading (currently `### Stage 4 — \`/simplify\``) and its body to reference `/code-review` instead of `/simplify`. Replace:

```markdown
### Stage 4 — `/simplify`

**Dispatcher:** dispatch a simplify subagent.

**Prompt the subagent to:** run the `/simplify` skill on the diff — tighten it for reuse, clarity, and minimal surface area. If simplifying reveals a structural problem (not just style), the subagent raises it as a finding (routes back through Stage 5 finding handling).
```

with:

```markdown
### Stage 4 — `/code-review`

**Dispatcher:** dispatch a code-review subagent.

**Prompt the subagent to:** run the `/code-review` skill on the diff — tighten it for reuse, clarity, and minimal surface area, and self-review the change. If the pass reveals a structural problem (not just style), the subagent raises it as a finding (routes back through Stage 5 finding handling).
```

Also update the two other references to `/simplify` in the file: in the Step 4 "Computing the change's diff" paragraph (`The \`/simplify\`, review, and security stages need…` → `The \`/code-review\`, review, and security stages need…`) and in the §Composition list (`\`/simplify\`` → `\`/code-review\``).

- [ ] **Step 2: Add `--label engine:review` to the Stage 8 `gh pr create`**

In Stage 8, the `gh pr create` command currently is:

```bash
gh pr create \
  --draft \
  --base next \
  --title "<shape>(scope): <title>" \
  --body "$(cat <<'EOF'
...
EOF
)"
```

Add a `--label engine:review` flag so the engine opts its own PRs into the `review-pr` loop:

```bash
gh pr create \
  --draft \
  --base next \
  --label engine:review \
  --title "<shape>(scope): <title>" \
  --body "$(cat <<'EOF'
...
EOF
)"
```

Add one sentence after the command: "The `--label engine:review` opt-in flag enrols this PR in the independent `review-pr` loop (Autopilot's PR-triggered review). See `docs/superpowers/specs/2026-05-29-pr-review-loop-design.md`."

- [ ] **Step 3: Verify no stray `/simplify` references remain**

Run: `grep -n "simplify" .claude/skills/implement-issue/SKILL.md`
Expected: no matches (all replaced by `/code-review`).

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/implement-issue/SKILL.md
git commit -m "feat(autopilot): implement-issue opts PRs into review-pr; rename Stage 4 to /code-review (#889)"
```

---

## Task 2: Types for the review loop

**Files:**
- Modify: `packages/eng-loop/src/dispatcher/types.ts`
- Test: `packages/eng-loop/test/dispatcher/types.test.ts` (new — a compile-time/shape guard)

- [ ] **Step 1: Write a shape test that pins the new types**

Create `packages/eng-loop/test/dispatcher/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import type { PolledPr, ReviewablePr, InFlightReview } from '../../src/dispatcher/types.js';

describe('review-loop types', () => {
  it('DEFAULT_CONFIG carries review-loop fields', () => {
    expect(DEFAULT_CONFIG.reviewCap).toBe(3);
    expect(DEFAULT_CONFIG.engineReviewLabel).toBe('engine:review');
    expect(DEFAULT_CONFIG.reviewBotLogin).toBe('');
  });

  it('ReviewablePr narrows PolledPr', () => {
    const pr: ReviewablePr = {
      number: 42, title: 't', headRefName: 'feat/42-x', headRefOid: 'abc',
      isDraft: true, author: 'alice', hasReviewLabel: true, needsReview: true,
    };
    const widened: PolledPr = pr;
    expect(widened.number).toBe(42);
  });

  it('InFlightReview is PR-keyed', () => {
    const s: InFlightReview = { prNumber: 42, branch: 'feat/42-x', worktreePath: '/p/pr-42', pid: 1, startedAt: 0 };
    expect(s.prNumber).toBe(42);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/types.test.ts`
Expected: FAIL — `PolledPr` / `ReviewablePr` / `InFlightReview` not exported; `reviewCap` etc. undefined.

- [ ] **Step 3: Add the types and config fields**

In `packages/eng-loop/src/dispatcher/types.ts`, append after the `SessionResult` interface:

```ts
/** A PR as polled from the PR source, with the fields the review loop needs. */
export interface PolledPr {
  number: number;
  title: string;
  /** Head branch name, e.g. "feat/418-foo" — the branch the review worktree checks out. */
  headRefName: string;
  /** Head commit oid (full SHA). */
  headRefOid: string;
  isDraft: boolean;
  /** GitHub login of the PR author. */
  author: string;
  /** True iff the PR carries the engine-review opt-in label. */
  hasReviewLabel: boolean;
  /**
   * True iff the PR needs a (re)review: no review by `reviewBotLogin` has been
   * submitted at or after the PR's latest commit. Once a current review exists
   * this is false, so the dispatcher stops re-spawning for an unchanged PR.
   */
  needsReview: boolean;
}

/** A PR that passed the review-ready filter — safe to dispatch a review-pr session for. */
export interface ReviewablePr extends PolledPr {
  hasReviewLabel: true;
  needsReview: true;
}

/** A review-pr session the dispatcher has spawned and is tracking (PR-keyed). */
export interface InFlightReview {
  prNumber: number;
  branch: string;
  worktreePath: string;
  pid: number | null;
  startedAt: number;
}
```

In the `DispatcherConfig` interface, add three fields after `authorAllowlist`:

```ts
  /** Max simultaneous review-pr sessions. Separate from concurrencyCap so a PR
   *  flood cannot starve new implementation work (or vice-versa). */
  reviewCap: number;
  /** The opt-in label that gates review-pr participation. */
  engineReviewLabel: string;
  /**
   * GitHub login of the engine review bot. Used to detect whether a *current*
   * review already exists (review by this login at/after the latest commit).
   * Empty (the default) = skip all review dispatch — fail-safe, mirroring
   * `authorAllowlist`. Source: `JINN_REVIEW_BOT_LOGIN` (runner-read).
   */
  reviewBotLogin: string;
```

In `DEFAULT_CONFIG`, add:

```ts
  reviewCap: 3,
  engineReviewLabel: 'engine:review',
  reviewBotLogin: '',
```

- [ ] **Step 4: Run it to verify it passes**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/dispatcher/types.ts packages/eng-loop/test/dispatcher/types.test.ts
git commit -m "feat(autopilot): review-loop types + config fields (#889)"
```

---

## Task 3: `PrSource` — poll labelled PRs, compute `needsReview`

**Files:**
- Create: `packages/eng-loop/src/dispatcher/pr-source.ts`
- Test: `packages/eng-loop/test/dispatcher/pr-source.test.ts`

`GhPrSource` mirrors `GhIssueSource`: an injected `CommandRunner`, REST `gh` calls, maps to `PolledPr[]`. It (1) lists open PRs carrying the label, then (2) for each, fetches `reviews` + `commits` to compute `needsReview` (no review by `reviewBotLogin` at/after the latest commit's `committedDate`).

- [ ] **Step 1: Write the failing test**

Create `packages/eng-loop/test/dispatcher/pr-source.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GhPrSource } from '../../src/dispatcher/pr-source.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const LABEL = 'engine:review';
const BOT = 'jinn-bot';

// `gh pr list --label engine:review --json number,title,headRefName,headRefOid,isDraft,author`
const PR_LIST = JSON.stringify([
  { number: 10, title: 'feat: a', headRefName: 'feat/10-a', headRefOid: 'sha10', isDraft: true, author: { login: 'jinn-bot' } },
  { number: 11, title: 'fix: b',  headRefName: 'fix/11-b',  headRefOid: 'sha11', isDraft: false, author: { login: 'alice' } },
]);

// `gh pr view 10 --json reviews,commits` — bot reviewed AFTER the latest commit → current → needsReview:false
const PR10_VIEW = JSON.stringify({
  reviews: [{ author: { login: 'jinn-bot' }, state: 'APPROVED', submittedAt: '2026-05-29T12:00:00Z' }],
  commits: [{ committedDate: '2026-05-29T10:00:00Z' }],
});
// `gh pr view 11 --json reviews,commits` — no bot review → needsReview:true
const PR11_VIEW = JSON.stringify({
  reviews: [],
  commits: [{ committedDate: '2026-05-29T09:00:00Z' }],
});

function makeRunner() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === 'pr' && args[1] === 'list') return PR_LIST;
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '10') return PR10_VIEW;
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '11') return PR11_VIEW;
    throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
  };
  return { runner, calls };
}

describe('GhPrSource.poll', () => {
  it('lists PRs by the opt-in label and computes needsReview from reviews vs latest commit', async () => {
    const { runner, calls } = makeRunner();
    const polled = await new GhPrSource(runner, LABEL, BOT).poll();

    // Listed with the label filter
    const list = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'list');
    expect(list!.args).toContain('--label');
    expect(list!.args[list!.args.indexOf('--label') + 1]).toBe(LABEL);

    const pr10 = polled.find((p) => p.number === 10)!;
    const pr11 = polled.find((p) => p.number === 11)!;

    expect(pr10.hasReviewLabel).toBe(true);
    expect(pr10.headRefName).toBe('feat/10-a');
    expect(pr10.headRefOid).toBe('sha10');
    expect(pr10.author).toBe('jinn-bot');
    expect(pr10.needsReview).toBe(false); // bot review newer than latest commit

    expect(pr11.needsReview).toBe(true);  // no bot review at all
    expect(pr11.author).toBe('alice');
  });

  it('treats a bot review OLDER than the latest commit as stale → needsReview:true', async () => {
    const STALE_VIEW = JSON.stringify({
      reviews: [{ author: { login: BOT }, state: 'APPROVED', submittedAt: '2026-05-29T08:00:00Z' }],
      commits: [{ committedDate: '2026-05-29T11:00:00Z' }],
    });
    const runner: CommandRunner = async (cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'list')
        return JSON.stringify([{ number: 12, title: 't', headRefName: 'x', headRefOid: 's', isDraft: false, author: { login: 'bob' } }]);
      if (args[0] === 'pr' && args[1] === 'view') return STALE_VIEW;
      throw new Error('unexpected');
    };
    const polled = await new GhPrSource(runner, LABEL, BOT).poll();
    expect(polled[0].needsReview).toBe(true);
  });

  it('returns empty when reviewBotLogin is empty (fail-safe, no view calls)', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: CommandRunner = async (cmd, args) => { calls.push({ cmd, args }); return '[]'; };
    const polled = await new GhPrSource(runner, LABEL, '').poll();
    expect(polled).toEqual([]);
    expect(calls).toHaveLength(0); // no gh calls at all when bot login unset
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/pr-source.test.ts`
Expected: FAIL — `pr-source.js` / `GhPrSource` not found.

- [ ] **Step 3: Implement `GhPrSource`**

Create `packages/eng-loop/src/dispatcher/pr-source.ts`:

```ts
import type { CommandRunner } from './issue-source.js';
import { defaultRunner } from './issue-source.js';
import type { PolledPr } from './types.js';

const REPO = 'Jinn-Network/mono';

/** SEAM: where reviewable PRs come from. Local impl polls `gh`. */
export interface PrSource {
  poll(): Promise<PolledPr[]>;
}

/** One entry from `gh pr list --json number,title,headRefName,headRefOid,isDraft,author`. */
interface GhPrListEntry {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  author?: { login?: string };
}

/** `gh pr view <n> --json reviews,commits`. */
interface GhPrView {
  reviews: Array<{ author?: { login?: string }; state: string; submittedAt: string }>;
  commits: Array<{ committedDate: string }>;
}

/**
 * True iff a review by `botLogin` was submitted at or after the PR's latest
 * commit. Used to decide `needsReview = !currentReviewExists`.
 */
function hasCurrentReview(view: GhPrView, botLogin: string): boolean {
  if (view.commits.length === 0) return false; // no commits → nothing to review against
  const latestCommitMs = Math.max(...view.commits.map((c) => Date.parse(c.committedDate)));
  return view.reviews.some(
    (r) =>
      (r.author?.login ?? '') === botLogin &&
      Date.parse(r.submittedAt) >= latestCommitMs,
  );
}

export class GhPrSource implements PrSource {
  constructor(
    private readonly run: CommandRunner = defaultRunner,
    private readonly label: string = 'engine:review',
    private readonly botLogin: string = '',
  ) {}

  async poll(): Promise<PolledPr[]> {
    // Fail-safe: with no bot login we cannot detect a current review, so we'd
    // re-review forever. Mirror the authorAllowlist fail-safe: do nothing.
    if (this.botLogin.length === 0) return [];

    const listRaw = await this.run('gh', [
      'pr', 'list',
      '--repo', REPO,
      '--state', 'open',
      '--label', this.label,
      '--json', 'number,title,headRefName,headRefOid,isDraft,author',
      '--limit', '200',
    ]);
    const list: GhPrListEntry[] = JSON.parse(listRaw) as GhPrListEntry[];

    const out: PolledPr[] = [];
    for (const pr of list) {
      const viewRaw = await this.run('gh', [
        'pr', 'view', String(pr.number),
        '--repo', REPO,
        '--json', 'reviews,commits',
      ]);
      const view: GhPrView = JSON.parse(viewRaw) as GhPrView;
      out.push({
        number: pr.number,
        title: pr.title,
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        isDraft: pr.isDraft,
        author: pr.author?.login ?? '',
        hasReviewLabel: true, // listed under --label, so always true here
        needsReview: !hasCurrentReview(view, this.botLogin),
      });
    }
    return out;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/pr-source.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/dispatcher/pr-source.ts packages/eng-loop/test/dispatcher/pr-source.test.ts
git commit -m "feat(autopilot): GhPrSource polls labelled PRs + computes needsReview (#889)"
```

---

## Task 4: `deriveReviewInFlight` — find `pr-<N>` worktrees

**Files:**
- Create: `packages/eng-loop/src/dispatcher/review-state.ts`
- Test: `packages/eng-loop/test/dispatcher/review-state.test.ts`

Mirrors the worktree-parsing logic in `state.ts`, but matches `jinn-mono_worktrees/pr-<N>` and keys results by PR number. Review sessions have no Project status (PRs aren't board items), so in-flight = "a `pr-<N>` worktree exists."

- [ ] **Step 1: Write the failing test**

Create `packages/eng-loop/test/dispatcher/review-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveReviewInFlight } from '../../src/dispatcher/review-state.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const PORCELAIN = [
  'worktree /repo/jinn-mono',
  'HEAD aaaa',
  'branch refs/heads/next',
  '',
  'worktree /repo/jinn-mono_worktrees/pr-42',
  'HEAD bbbb',
  'branch refs/heads/feat/42-thing',
  '',
  'worktree /repo/jinn-mono_worktrees/55',          // an *issue* worktree — must be ignored
  'HEAD cccc',
  'branch refs/heads/fix/55-bug',
  '',
].join('\n');

describe('deriveReviewInFlight', () => {
  it('returns InFlightReview for each pr-<N> worktree, ignoring issue worktrees', async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return PORCELAIN;
      throw new Error('unexpected');
    };
    const { inFlight } = await deriveReviewInFlight(runner);
    expect(inFlight.map((s) => s.prNumber)).toEqual([42]);
    expect(inFlight[0].branch).toBe('feat/42-thing');
    expect(inFlight[0].worktreePath).toBe('/repo/jinn-mono_worktrees/pr-42');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/review-state.test.ts`
Expected: FAIL — `review-state.js` not found.

- [ ] **Step 3: Implement `deriveReviewInFlight`**

Create `packages/eng-loop/src/dispatcher/review-state.ts`:

```ts
import { statSync } from 'node:fs';
import type { CommandRunner } from './issue-source.js';
import type { InFlightReview } from './types.js';

const WORKTREE_PARENT_COMPONENT = 'jinn-mono_worktrees';
const PR_PREFIX = 'pr-';

interface ParsedWorktree { worktreePath: string; branchRef: string | null; }

function parsePorcelain(output: string): ParsedWorktree[] {
  const result: ParsedWorktree[] = [];
  for (const block of output.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    if (lines.length === 0 || lines[0] === '') continue;
    let worktreePath: string | null = null;
    let branchRef: string | null = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) branchRef = line.slice('branch '.length);
    }
    if (worktreePath != null) result.push({ worktreePath, branchRef });
  }
  return result;
}

/** Extract the PR number from a `jinn-mono_worktrees/pr-<N>` path; null otherwise. */
function extractPrNumber(worktreePath: string): number | null {
  const parts = worktreePath.split('/').filter((p, i) => i > 0 || p !== '');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === WORKTREE_PARENT_COMPONENT) {
      const candidate = parts[i + 1];
      if (candidate == null || i + 2 !== parts.length) return null;
      if (!candidate.startsWith(PR_PREFIX)) return null;
      const digits = candidate.slice(PR_PREFIX.length);
      const n = parseInt(digits, 10);
      if (isNaN(n) || String(n) !== digits) return null;
      return n;
    }
  }
  return null;
}

function shortBranch(ref: string): string {
  const p = 'refs/heads/';
  return ref.startsWith(p) ? ref.slice(p.length) : ref;
}

function recoverStartedAt(worktreePath: string): number {
  try { const st = statSync(worktreePath); return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs; }
  catch { return 0; }
}

/**
 * Re-derive in-flight review sessions from `git worktree list` — one
 * InFlightReview per `jinn-mono_worktrees/pr-<N>` worktree. Crash-safe: a
 * restart re-derives from disk. No drift bucket: unlike issues, review sessions
 * have no board status to cross-check against.
 */
export async function deriveReviewInFlight(
  runner: CommandRunner,
): Promise<{ inFlight: InFlightReview[]; drift: string[] }> {
  const raw = await runner('git', ['worktree', 'list', '--porcelain']);
  const inFlight: InFlightReview[] = [];
  for (const wt of parsePorcelain(raw)) {
    const prNumber = extractPrNumber(wt.worktreePath);
    if (prNumber == null) continue;
    inFlight.push({
      prNumber,
      branch: wt.branchRef != null ? shortBranch(wt.branchRef) : '',
      worktreePath: wt.worktreePath,
      pid: null,
      startedAt: recoverStartedAt(wt.worktreePath),
    });
  }
  return { inFlight, drift: [] };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/review-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/dispatcher/review-state.ts packages/eng-loop/test/dispatcher/review-state.test.ts
git commit -m "feat(autopilot): deriveReviewInFlight finds pr-<N> worktrees (#889)"
```

---

## Task 5: `selectReviewable` — the review-ready filter

**Files:**
- Create: `packages/eng-loop/src/dispatcher/review-ready-filter.ts`
- Test: `packages/eng-loop/test/dispatcher/review-ready-filter.test.ts`

Mirrors `ready-filter.ts`. A PR is reviewable when `hasReviewLabel && needsReview` and it is not already in flight. Ordered FIFO by PR number.

- [ ] **Step 1: Write the failing test**

Create `packages/eng-loop/test/dispatcher/review-ready-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { selectReviewable } from '../../src/dispatcher/review-ready-filter.js';
import type { PolledPr } from '../../src/dispatcher/types.js';

function pr(number: number, over: Partial<PolledPr> = {}): PolledPr {
  return {
    number, title: `pr ${number}`, headRefName: `b/${number}`, headRefOid: 's',
    isDraft: false, author: 'a', hasReviewLabel: true, needsReview: true, ...over,
  };
}

describe('selectReviewable', () => {
  it('keeps labelled PRs needing review, drops in-flight, orders FIFO by number', () => {
    const polled = [pr(30), pr(10), pr(20, { needsReview: false }), pr(40)];
    const inFlight = new Set<number>([40]);
    const ready = selectReviewable(polled, inFlight);
    expect(ready.map((p) => p.number)).toEqual([10, 30]); // 20 not-needed, 40 in-flight
  });

  it('drops PRs without the label (defensive — source should already filter)', () => {
    const ready = selectReviewable([pr(1, { hasReviewLabel: false })], new Set());
    expect(ready).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/review-ready-filter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `selectReviewable`**

Create `packages/eng-loop/src/dispatcher/review-ready-filter.ts`:

```ts
import type { PolledPr, ReviewablePr } from './types.js';

/**
 * Filter polled PRs down to those a `review-pr` session should be dispatched
 * for: carry the opt-in label, need a (re)review, and are not already in
 * flight. Ordered FIFO by PR number (oldest first).
 */
export function selectReviewable(
  polled: PolledPr[],
  inFlight: ReadonlySet<number>,
): ReviewablePr[] {
  return polled
    .filter((p): p is ReviewablePr => p.hasReviewLabel && p.needsReview && !inFlight.has(p.number))
    .sort((a, b) => a.number - b.number);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/review-ready-filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/dispatcher/review-ready-filter.ts packages/eng-loop/test/dispatcher/review-ready-filter.test.ts
git commit -m "feat(autopilot): selectReviewable review-ready filter (#889)"
```

---

## Task 6: `dispatchReview` — pr-`N` worktree + spawn `review-pr`

**Files:**
- Create: `packages/eng-loop/src/dispatcher/review-dispatch.ts`
- Test: `packages/eng-loop/test/dispatcher/review-dispatch.test.ts`

Mirrors `dispatch.ts` but: the worktree is `<WORKTREES_BASE>/pr-<N>` checked out on the PR's **head branch** (so the in-session fix subagent can commit + push), and the prompt invokes the `review-pr` skill. No Project-status mutation (PRs have no board status). Reuses `WORKTREES_BASE`, `loadCanon`-equivalent, and `buildHeadlessPrompt` patterns from `dispatch.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/eng-loop/test/dispatcher/review-dispatch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { dispatchReview } from '../../src/dispatcher/review-dispatch.js';
import { WORKTREES_BASE } from '../../src/dispatcher/dispatch.js';
import type { ReviewablePr, DispatcherConfig } from '../../src/dispatcher/types.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type { SpawnFn } from '../../src/dispatcher/dispatch.js';

const PR: ReviewablePr = {
  number: 42, title: 'feat: thing', headRefName: 'feat/42-thing', headRefOid: 'sha42',
  isDraft: true, author: 'jinn-bot', hasReviewLabel: true, needsReview: true,
};
const CFG: DispatcherConfig = {
  concurrencyCap: 3, openPrBackpressure: 30, wallClockMs: 1, defaultImplementer: 'claude',
  authorAllowlist: [], reviewCap: 3, engineReviewLabel: 'engine:review', reviewBotLogin: 'jinn-bot',
};
const EXPECTED_WT = join(WORKTREES_BASE, 'pr-42');

function makeRunner(worktreeList = `worktree /x\nHEAD a\nbranch refs/heads/next\n`) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return worktreeList;
    if (cmd === 'git') return '';
    throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
  };
  return { runner, calls };
}
function makeSpawn(pid = 4242) {
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  const spawn: SpawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts: opts as Record<string, unknown> }); return { pid }; };
  return { spawn, calls };
}

describe('dispatchReview', () => {
  it('creates a pr-<N> worktree on the PR head branch off origin/<headRefName>', async () => {
    const { runner, calls } = makeRunner();
    const { spawn } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn });

    const add = calls.find((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(add).toBeDefined();
    expect(add!.args[2]).toBe(EXPECTED_WT);
    expect(add!.args).toContain('-B');
    expect(add!.args[add!.args.indexOf('-B') + 1]).toBe('feat/42-thing');
    expect(add!.args[add!.args.length - 1]).toBe('origin/feat/42-thing');
    // fetched the head branch first
    expect(calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(true);
  });

  it('is idempotent — skips git worktree add when pr-<N> already exists', async () => {
    const list = `worktree /x\nHEAD a\nbranch refs/heads/next\n\nworktree ${EXPECTED_WT}\nHEAD b\nbranch refs/heads/feat/42-thing\n`;
    const { runner, calls } = makeRunner(list);
    const { spawn } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn });
    expect(calls.find((c) => c.cmd === 'git' && c.args[1] === 'add')).toBeUndefined();
  });

  it('spawns claude -p with a review-pr prompt naming the PR and the pre-created worktree', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn });
    expect(calls).toHaveLength(1);
    const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1];
    expect(prompt).toContain('review-pr');
    expect(prompt).toContain('#42');
    expect(prompt).toContain(EXPECTED_WT);
    expect(prompt).toContain('already exists');
    expect(prompt).toContain('CLAUDE.md');      // canon prepended
    expect(prompt).toContain('non-interactive'); // headless override
    expect(calls[0].opts.cwd).toBe(EXPECTED_WT);
    expect(calls[0].opts.detached).toBe(true);
  });

  it('does NOT pass plan-posture flags', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn });
    expect(calls[0].args).not.toContain('--mode');
    expect(calls[0].args).not.toContain('--permission-mode');
  });

  it('returns an InFlightReview with prNumber, branch, worktree, pid', async () => {
    const { runner } = makeRunner();
    const { spawn } = makeSpawn(7777);
    const s = await dispatchReview(PR, CFG, { runner, spawn });
    expect(s.prNumber).toBe(42);
    expect(s.branch).toBe('feat/42-thing');
    expect(s.worktreePath).toBe(EXPECTED_WT);
    expect(s.pid).toBe(7777);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/review-dispatch.test.ts`
Expected: FAIL — `review-dispatch.js` not found.

- [ ] **Step 3: Implement `dispatchReview`**

Create `packages/eng-loop/src/dispatcher/review-dispatch.ts`. It reuses `WORKTREES_BASE` and the canon-loading + prompt-assembly approach from `dispatch.ts`; extract `loadCanon` into a shared spot if convenient, or re-read the two files here (mirror `dispatch.ts`'s `loadCanon`).

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ReviewablePr, DispatcherConfig, InFlightReview } from './types.js';
import type { CommandRunner } from './issue-source.js';
import type { SpawnFn } from './dispatch.js';
import { WORKTREES_BASE } from './dispatch.js';
import { buildHeadlessPrompt } from '../headless.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

function loadCanon(): string {
  const claudeMd = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8').trim();
  const handbook = readFileSync(join(REPO_ROOT, 'docs', 'engineering', 'handbook.md'), 'utf8').trim();
  return ['# CLAUDE.md (canonical)\n', claudeMd, '', '# Engineering handbook (canonical)\n', handbook].join('\n');
}

/**
 * Dispatch one reviewable PR:
 * 1. Fetch the PR head branch.
 * 2. Create a `pr-<N>` worktree CHECKED OUT ON the head branch (so the in-session
 *    fix subagent can commit + push). Idempotent: reuse if it already exists.
 * 3. Assemble the prompt: canon + headless-override + `review-pr` task.
 * 4. Spawn `claude -p` detached, no plan-posture flags.
 */
export async function dispatchReview(
  pr: ReviewablePr,
  cfg: DispatcherConfig,
  deps: { runner: CommandRunner; spawn: SpawnFn },
): Promise<InFlightReview> {
  const { runner, spawn } = deps;
  const worktreePath = join(WORKTREES_BASE, `pr-${pr.number}`);

  // 1. Fetch the head branch so origin/<headRefName> is current.
  await runner('git', ['fetch', 'origin', pr.headRefName, '--quiet']);

  // 2. Create the worktree on the head branch — idempotent.
  const listRaw = await runner('git', ['worktree', 'list', '--porcelain']);
  const exists = listRaw
    .split('\n')
    .some((line) => line.startsWith('worktree ') && line.trim() === `worktree ${worktreePath}`);
  if (!exists) {
    // -B force-(re)creates the local branch at the remote head and checks it out
    // in the new worktree; the fix subagent pushes with `git push origin HEAD:<branch>`.
    await runner('git', ['worktree', 'add', worktreePath, '-B', pr.headRefName, `origin/${pr.headRefName}`]);
  }

  // 3. Prompt.
  const canon = loadCanon();
  const scenario = [
    `Use the review-pr skill on PR #${pr.number}.`,
    `PR: #${pr.number} — ${pr.title} (head branch \`${pr.headRefName}\`, head ${pr.headRefOid}).`,
    `A git worktree for this PR already exists at \`${worktreePath}\`, checked out on the PR head branch — use it; do not create a new worktree.`,
  ].join('\n');
  const fullPrompt = [canon, '', buildHeadlessPrompt('review-pr', scenario)].join('\n');

  // 4. Spawn — NO plan-posture flags.
  const result = spawn('claude', ['-p', fullPrompt], { cwd: worktreePath, detached: true, stdio: 'ignore' });

  return {
    prNumber: pr.number,
    branch: pr.headRefName,
    worktreePath,
    pid: result.pid ?? null,
    startedAt: Date.now(),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/review-dispatch.test.ts`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/dispatcher/review-dispatch.ts packages/eng-loop/test/dispatcher/review-dispatch.test.ts
git commit -m "feat(autopilot): dispatchReview spawns review-pr on a pr-<N> worktree (#889)"
```

---

## Task 7: `runReviewCycle` — the review-loop orchestrator

**Files:**
- Create: `packages/eng-loop/src/dispatcher/review-loop.ts`
- Test: `packages/eng-loop/test/dispatcher/review-loop.test.ts`

Mirrors `loop.ts`: no gh/git calls, all I/O injected. Polls the PR source, derives in-flight reviews, filters reviewable, dispatches up to `reviewCap − inFlight`.

- [ ] **Step 1: Write the failing test**

Create `packages/eng-loop/test/dispatcher/review-loop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runReviewCycle } from '../../src/dispatcher/review-loop.js';
import type { PrSource } from '../../src/dispatcher/pr-source.js';
import type { PolledPr, ReviewablePr, InFlightReview, DispatcherConfig } from '../../src/dispatcher/types.js';

const CFG: DispatcherConfig = {
  concurrencyCap: 3, openPrBackpressure: 30, wallClockMs: 1, defaultImplementer: 'claude',
  authorAllowlist: [], reviewCap: 2, engineReviewLabel: 'engine:review', reviewBotLogin: 'jinn-bot',
};
function pr(n: number, over: Partial<PolledPr> = {}): PolledPr {
  return { number: n, title: `t${n}`, headRefName: `b/${n}`, headRefOid: 's', isDraft: false, author: 'a', hasReviewLabel: true, needsReview: true, ...over };
}

describe('runReviewCycle', () => {
  it('dispatches reviewable PRs up to reviewCap − inFlight, FIFO', async () => {
    const polled = [pr(3), pr(1), pr(2)];
    const source: PrSource = { poll: async () => polled };
    const dispatched: number[] = [];
    const report = await runReviewCycle({
      prSource: source,
      cfg: CFG,
      deriveReviewInFlight: async () => ({ inFlight: [] as InFlightReview[], drift: [] }),
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: `/pr-${p.number}`, pid: 1, startedAt: 0 }; },
    });
    expect(dispatched).toEqual([1, 2]);          // FIFO, capped at reviewCap=2
    expect(report.dispatched).toEqual([1, 2]);
    expect(report.skippedForCap).toBe(1);        // #3 left for next cycle
  });

  it('respects in-flight reviews against the cap', async () => {
    const source: PrSource = { poll: async () => [pr(5), pr(6)] };
    const dispatched: number[] = [];
    await runReviewCycle({
      prSource: source,
      cfg: CFG,
      deriveReviewInFlight: async () => ({ inFlight: [{ prNumber: 9, branch: 'x', worktreePath: '/pr-9', pid: 1, startedAt: 0 }], drift: [] }),
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: '/x', pid: 1, startedAt: 0 }; },
    });
    expect(dispatched).toEqual([5]); // cap 2 − 1 in-flight = budget 1
  });

  it('does not re-dispatch a PR already in flight', async () => {
    const source: PrSource = { poll: async () => [pr(7)] };
    const dispatched: number[] = [];
    await runReviewCycle({
      prSource: source,
      cfg: CFG,
      deriveReviewInFlight: async () => ({ inFlight: [{ prNumber: 7, branch: 'b/7', worktreePath: '/pr-7', pid: 1, startedAt: 0 }], drift: [] }),
      dispatchReview: async (p: ReviewablePr) => { dispatched.push(p.number); return { prNumber: p.number, branch: p.headRefName, worktreePath: '/x', pid: 1, startedAt: 0 }; },
    });
    expect(dispatched).toEqual([]); // #7 is in flight → filtered out
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/review-loop.test.ts`
Expected: FAIL — `review-loop.js` not found.

- [ ] **Step 3: Implement `runReviewCycle`**

Create `packages/eng-loop/src/dispatcher/review-loop.ts`:

```ts
import type { PrSource } from './pr-source.js';
import type { DispatcherConfig, InFlightReview, ReviewablePr } from './types.js';
import { selectReviewable } from './review-ready-filter.js';

export interface ReviewCycleReport {
  /** PR numbers dispatched this cycle, in dispatch order. */
  dispatched: number[];
  /** Reviewable PRs left undispatched because the cap was reached. */
  skippedForCap: number;
  /** Drift strings from deriveReviewInFlight (currently always empty). */
  drift: string[];
}

export interface ReviewCycleDeps {
  prSource: PrSource;
  cfg: DispatcherConfig;
  deriveReviewInFlight(): Promise<{ inFlight: InFlightReview[]; drift: string[] }>;
  dispatchReview(pr: ReviewablePr): Promise<InFlightReview>;
}

/**
 * One tick of the review loop (mirrors runCycle): poll PRs, derive in-flight
 * reviews, filter reviewable, dispatch up to `reviewCap − inFlight`. Contains
 * NO gh/git calls — all I/O is injected (seam discipline).
 */
export async function runReviewCycle(deps: ReviewCycleDeps): Promise<ReviewCycleReport> {
  const { prSource, cfg, deriveReviewInFlight, dispatchReview } = deps;

  const [polled, { inFlight, drift }] = await Promise.all([
    prSource.poll(),
    deriveReviewInFlight(),
  ]);

  const inFlightSet = new Set<number>(inFlight.map((s) => s.prNumber));
  const reviewable = selectReviewable(polled, inFlightSet);

  const budget = Math.max(0, cfg.reviewCap - inFlight.length);
  const toDispatch = reviewable.slice(0, budget);

  const dispatched: number[] = [];
  for (const pr of toDispatch) {
    await dispatchReview(pr);
    dispatched.push(pr.number);
  }

  return { dispatched, skippedForCap: reviewable.length - toDispatch.length, drift };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/dispatcher/review-loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/dispatcher/review-loop.ts packages/eng-loop/test/dispatcher/review-loop.test.ts
git commit -m "feat(autopilot): runReviewCycle review-loop orchestrator (#889)"
```

---

## Task 8: The `review-pr` skill

**Files:**
- Create: `.claude/skills/review-pr/SKILL.md`

This is a prose artifact (no unit tests). It mirrors `implement-issue/SKILL.md`'s structure and lifts the proven review→fix loop, re-rooted on a PR. Author the full file with these required sections and content; the dispatch/finding-handling/headless mechanics mirror `implement-issue` verbatim where noted.

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/review-pr/SKILL.md` with this frontmatter and these sections:

````markdown
---
name: review-pr
description: Use when asked to review a specific GitHub PR through Autopilot — e.g. "review PR #N", "run review-pr on this PR". The coordinating agent for one open PR carrying the `engine:review` label: dispatches independent review subagents (code-review + security + app-test), then owns the review→fix→re-review loop on the PR branch until the PR is approved or escalated. Mirrors implement-issue.
---

# review-pr

You are the coordinating agent for exactly one open GitHub PR that carries the `engine:review` label. Your job: run an independent review, and if there are blocking findings, drive fixes on the PR branch until the PR is clean (approve + un-draft) or a human is needed (escalate). You dispatch a fresh subagent per stage; you never review or fix directly. This mirrors implement-issue — the review→fix loop is the same machinery, re-rooted on a PR.

## Read first
- `docs/engineering/handbook.md`, `CLAUDE.md`
- `docs/superpowers/specs/2026-05-29-pr-review-loop-design.md` — this skill's design.
- `.claude/skills/implement-issue/SKILL.md` §Step 4 (subagent-dispatch discipline) and §Step 5 (finding handling) — reused verbatim here.

## Step 1 — Read the PR
Input: a PR number (`#N`). Fetch it:
```bash
gh pr view <N> --repo Jinn-Network/mono --json number,title,headRefName,headRefOid,isDraft,files,body
```
The dispatcher's prompt states the pre-created worktree path (on the PR head branch). Compute the diff from the merge-base:
```bash
git diff $(git merge-base origin/next HEAD)..HEAD
```

## Step 2 — Dispatch the review subagents (in parallel)
Dispatch fresh subagents — each different from any fix subagent (independence invariant, as implement-issue Stage 3 ≠ Stage 5):
- **code-review** — run `superpowers:requesting-code-review` with the code-reviewer template, given the diff + PR body.
- **security** — run `/security-review` on the diff.
- **app-test** — ONLY if the diff touches `client/src/dashboard/` (or other operator-visible surface): run `testing-jinn-app`.

Collect findings; classify each **blocking** vs **advisory/nit** (reuse implement-issue's two-finding-kind table).

## Step 3 — Verdict + loop
- **No blocking findings** → post an approving review and the verdict label, then un-draft:
  ```bash
  gh pr review <N> --repo Jinn-Network/mono --approve --body "<summary>"
  gh pr edit <N> --repo Jinn-Network/mono --add-label "review:approved" --remove-label "review:changes-requested"
  gh pr ready <N> --repo Jinn-Network/mono   # un-draft → enters the merge queue
  ```
  Done.
- **Blocking findings** → post a request-changes review with inline findings + the changes-requested label:
  ```bash
  gh pr review <N> --repo Jinn-Network/mono --request-changes --body "<findings>"
  gh pr edit <N> --repo Jinn-Network/mono --add-label "review:changes-requested" --remove-label "review:approved"
  ```
  Then dispatch a **fix subagent** (different from the reviewers) seeded with the findings. It implements fixes on the PR branch, commits, and pushes:
  ```bash
  git push origin HEAD:<headRefName>
  ```
  Then **re-run Step 2** on the new diff. Loop. There is **no round-count bound** — escalate on judgment (see Step 4).

## Step 4 — Finding handling & escalation
Reuse implement-issue §Step 5 verbatim: fixable findings → fix subagent + re-run; scope/design findings, non-converging findings, or an unpushable branch (e.g. a fork PR you cannot push to) → escalate. Escalation = post the structured note as a PR comment and set the PR's linked issue (if any) `Blocked on: Human`; for a PR with no linked issue, post the note and stop (the request-changes review stands as advisory). Never force-merge.

## Step 5 — Subagent-dispatch discipline & headless mode
Identical to implement-issue §Step 4 and §Step 7: curated prompts (never forward coordinator history), the independence invariant (reviewer ≠ fixer), the headless-override block injected by the dispatcher, no plan-posture flags.

## Failure modes
| Failure | Action |
|---|---|
| PR lacks the `engine:review` label | Stop — not in scope (the dispatcher should not have spawned this). |
| Cannot push to the PR branch (fork) | Post advisory review; escalate `Blocked on: Human`. |
| Fix subagent reports done but no new commit | Re-dispatch; verify with `git log origin/<headRefName>..HEAD`. |
| Findings not converging | Escalate `stuck`. |

## Composition
Composes: `superpowers:requesting-code-review` + code-reviewer template, `/security-review`, `testing-jinn-app`. Downstream of: the engine's draft PR (or any human PR labelled `engine:review`). Upstream of: the merge skill (consumes `review:approved`). Dispatched by: Autopilot's `eng-loop` review pass (the headless-override block is injected by the dispatcher).
````

- [ ] **Step 2: Verify the file parses as a skill (frontmatter present, name matches dir)**

Run: `head -5 .claude/skills/review-pr/SKILL.md`
Expected: frontmatter with `name: review-pr`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/review-pr/SKILL.md
git commit -m "feat(autopilot): review-pr coordinator skill (#889)"
```

---

## Task 9: Wire the review pass into `run-eng-loop.ts`

**Files:**
- Modify: `packages/eng-loop/scripts/run-eng-loop.ts`
- Test: `packages/eng-loop/test/run-eng-loop-review.test.ts` (new)

Add a review pass that runs after the issue cycle each tick. Read `JINN_REVIEW_BOT_LOGIN` into `cfg.reviewBotLogin`. Build the `GhPrSource`, run `runReviewCycle`, print its report. The real `dispatchReview`/`deriveReviewInFlight` are injected with the real runner/spawn (mirroring the issue path).

- [ ] **Step 1: Add the env constant + config wiring**

Near `AUTHOR_ALLOWLIST_ENV`, add:

```ts
const REVIEW_BOT_LOGIN_ENV = 'JINN_REVIEW_BOT_LOGIN';
```

In `main()`, where `cfg` is built, add `reviewBotLogin`:

```ts
  const cfg: DispatcherConfig = {
    ...DEFAULT_CONFIG,
    ...(capOk ? { concurrencyCap: capOverride } : {}),
    ...(bpOk ? { openPrBackpressure: bpOverride } : {}),
    authorAllowlist,
    reviewBotLogin: process.env[REVIEW_BOT_LOGIN_ENV] ?? '',
  };
```

After the `authorAllowlist` warn/log block, add a parallel one:

```ts
  if (cfg.reviewBotLogin.length === 0) {
    console.warn(
      `[eng:loop] WARNING: ${REVIEW_BOT_LOGIN_ENV} unset — the review-pr loop is disabled ` +
        `(cannot detect a current review without the bot login). Set ${REVIEW_BOT_LOGIN_ENV}=<login> to enable.`,
    );
  } else {
    console.log(`[eng:loop] review-pr enabled (bot=${cfg.reviewBotLogin}, label=${cfg.engineReviewLabel}, cap=${cfg.reviewCap})`);
  }
```

- [ ] **Step 2: Add a `runReviewPass` helper and call it from `runOneCycle`**

Add imports at the top:

```ts
import { GhPrSource } from '../src/dispatcher/pr-source.js';
import { deriveReviewInFlight } from '../src/dispatcher/review-state.js';
import { dispatchReview } from '../src/dispatcher/review-dispatch.js';
import { runReviewCycle } from '../src/dispatcher/review-loop.js';
import type { ReviewablePr } from '../src/dispatcher/types.js';
```

Add an exported helper (so it is unit-testable in isolation, mirroring `runDryRun`):

```ts
export async function runReviewPass(
  cfg: DispatcherConfig,
  runner: CommandRunner = realRunner,
  spawnFn?: SpawnFn,
): Promise<void> {
  if (cfg.reviewBotLogin.length === 0) return; // disabled — fail-safe
  const spawnImpl: SpawnFn =
    spawnFn ??
    ((cmd, args, opts) => {
      const child = spawn(cmd, args, opts as SpawnOptions);
      if (child.pid != null) child.unref();
      return { pid: child.pid };
    });
  const prSource = new GhPrSource(runner, cfg.engineReviewLabel, cfg.reviewBotLogin);
  const report = await runReviewCycle({
    prSource,
    cfg,
    deriveReviewInFlight: () => deriveReviewInFlight(runner),
    dispatchReview: (pr: ReviewablePr) => dispatchReview(pr, cfg, { runner, spawn: spawnImpl }),
  });
  if (report.dispatched.length > 0) {
    console.log(`[eng:loop] review-pr dispatched: PR #${report.dispatched.join(', #')}`);
  }
}
```

(Import `SpawnFn` from `../src/dispatcher/dispatch.js` and `CommandRunner` is already imported.)

In `runOneCycle`, after `printReport(result, 'Cycle report')` and before `return intervalMs;`, add:

```ts
      // Second pass: PR-triggered review (independent of the issue cycle).
      await runReviewPass(cfg, realRunner);
```

Wrap it so a review-pass failure does not kill the issue loop:

```ts
      try {
        await runReviewPass(cfg, realRunner);
      } catch (err) {
        console.error('[eng:loop] review pass error (issue cycle unaffected):', err);
      }
```

- [ ] **Step 3: Write the failing test**

Create `packages/eng-loop/test/run-eng-loop-review.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runReviewPass } from '../scripts/run-eng-loop.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';
import type { CommandRunner } from '../src/dispatcher/issue-source.js';
import type { SpawnFn } from '../src/dispatcher/dispatch.js';

const PR_LIST = JSON.stringify([
  { number: 50, title: 'feat: x', headRefName: 'feat/50-x', headRefOid: 's50', isDraft: true, author: { login: 'jinn-bot' } },
]);
const PR_VIEW = JSON.stringify({ reviews: [], commits: [{ committedDate: '2026-05-29T09:00:00Z' }] });

it('runReviewPass is a no-op when reviewBotLogin is empty', async () => {
  const calls: string[] = [];
  const runner: CommandRunner = async (cmd) => { calls.push(cmd); return ''; };
  await runReviewPass({ ...DEFAULT_CONFIG, reviewBotLogin: '' }, runner);
  expect(calls).toEqual([]);
});

it('runReviewPass dispatches a review session for a labelled PR needing review', async () => {
  const spawnCalls: Array<{ args: string[] }> = [];
  const spawn: SpawnFn = (_cmd, args) => { spawnCalls.push({ args }); return { pid: 1 }; };
  const runner: CommandRunner = async (cmd, args) => {
    if (args[0] === 'pr' && args[1] === 'list') return PR_LIST;
    if (args[0] === 'pr' && args[1] === 'view') return PR_VIEW;
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return 'worktree /x\nHEAD a\nbranch refs/heads/next\n';
    if (cmd === 'git') return '';
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  await runReviewPass({ ...DEFAULT_CONFIG, reviewBotLogin: 'jinn-bot' }, runner, spawn);
  expect(spawnCalls).toHaveLength(1);
  const prompt = spawnCalls[0].args[spawnCalls[0].args.indexOf('-p') + 1];
  expect(prompt).toContain('review-pr');
  expect(prompt).toContain('#50');
});
```

- [ ] **Step 4: Run it to verify it fails, then passes**

Run: `yarn workspace @jinn-network/eng-loop vitest run test/run-eng-loop-review.test.ts`
Expected: FAIL first (`runReviewPass` not exported), then PASS after Steps 1–2.

- [ ] **Step 5: Run the full eng-loop suite to confirm no regression**

Run: `yarn workspace @jinn-network/eng-loop test`
Expected: all pass (existing dry-run/loop/dispatch tests unaffected — the review pass is additive and guarded).

- [ ] **Step 6: Commit**

```bash
git add packages/eng-loop/scripts/run-eng-loop.ts packages/eng-loop/test/run-eng-loop-review.test.ts
git commit -m "feat(autopilot): wire review-pr pass into the dispatcher loop (#889)"
```

---

## Task 10: Typecheck, full suite, and the `engine:review` label

**Files:** none (verification + a one-time GitHub label).

- [ ] **Step 1: Typecheck the package**

Run: `yarn workspace @jinn-network/eng-loop typecheck` (or `tsc --noEmit` per the package's script).
Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `yarn workspace @jinn-network/eng-loop test`
Expected: all pass.

- [ ] **Step 3: Create the `engine:review` label on the repo (one-time)**

The label must exist before `gh pr create --label engine:review` (Task 1) or `gh pr edit --add-label` will succeed.

Run:
```bash
gh label create engine:review --repo Jinn-Network/mono --color 5319e7 --description "Opt in to Autopilot's independent PR review loop" || true
gh label create review:approved --repo Jinn-Network/mono --color 0e8a16 --description "Autopilot review-pr approved at current head" || true
gh label create review:changes-requested --repo Jinn-Network/mono --color d93f0b --description "Autopilot review-pr requested changes" || true
```
Expected: labels created (or already exist).

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(autopilot): verify review-pr loop typecheck + suite green (#889)"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** PrSource (label filter + SHA-proxy idempotency via review-vs-commit timestamps), review-state (pr-`N` worktrees), review-ready-filter, review-dispatch (head-branch worktree + spawn), review-loop (cap), review-pr skill (review→fix→re-review + verdict + escalation), run-eng-loop wiring, implement-issue edits, labels — all map to spec sections.
- **Idempotency caveat:** the spec describes "no bot review at the head SHA". This plan implements the SHA-proxy via *timestamps* (bot review submitted at/after the latest commit). A SHA-exact variant (GraphQL `reviews.nodes.commit.oid` vs `headRefOid`) is a follow-up hardening if timestamp skew ever causes a missed re-review — note it in the PR description.
- **Not in scope:** the auto-fix loop's *internal* mechanics live in the `review-pr` skill (prose), reusing implement-issue's proven loop — no new dispatcher code drives fix rounds. Per-type recipes (#886), agent routing (#887), headless-session dispatch (#890) are deferred.
