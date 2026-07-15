import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import type { ReadyIssue, DispatcherConfig, InFlightSession, Effort } from './types.js';
import type { CommandRunner } from './issue-source.js';
import { sessionSpawnEnv } from './identity.js';
import {
  fetchFieldIds,
  isStaleFieldError,
  resetFieldCache,
  type FieldCache,
} from './field-cache.js';
import { buildHeadlessPrompt } from '../headless.js';
import { sessionLogPath } from './session-log.js';
import { resolveImplementer } from './implementer-policy.js';

// ---------------------------------------------------------------------------
// Repo root + canonical worktree base
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
// src/dispatcher → src → packages/autopilot → packages → repo root
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

/**
 * Per CLAUDE.md AI rule #1, multi-agent worktrees live in
 * `../jinn-mono_worktrees/<name>` — sibling of the main repo checkout.
 *
 * When the dispatcher itself runs *inside* that sibling dir (i.e. its own
 * REPO_ROOT is already a worktree under `jinn-mono_worktrees/`, common while
 * `packages/autopilot` lives on an unmerged branch), the canonical base IS the
 * parent of REPO_ROOT — not `<REPO_ROOT>/../jinn-mono_worktrees`, which would
 * nest one level too deep. We detect that case and short-circuit.
 */
function computeWorktreesBase(repoRoot: string): string {
  const parent = dirname(repoRoot);
  if (basename(parent) === 'jinn-mono_worktrees') {
    return parent;
  }
  return join(repoRoot, '..', 'jinn-mono_worktrees');
}
export const WORKTREES_BASE = computeWorktreesBase(REPO_ROOT);

// ---------------------------------------------------------------------------
// GitHub Project constants (from file-issue/references/gh-taxonomy.md)
//
// Owner + number are no longer referenced here — `gh project field-list` moved
// to `./field-cache.ts` (jinn-mono#599) which holds its own copies. The
// project id used by the `item-edit` call below comes from
// `deps.fieldCache.projectId`, the same source pause-session.ts reads from —
// keeping both call sites symmetric so a future project-id migration only
// has to touch field-cache.ts. (Stage 5 Finding 5 on jinn-mono#599.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SpawnFn — injectable spawn so tests create no real processes
// ---------------------------------------------------------------------------

/**
 * The result of spawning a process — at minimum a pid.
 * (Mirrors the subset of ChildProcess that dispatch.ts needs.)
 */
export interface SpawnResult {
  pid: number | undefined;
}

/**
 * Injectable spawn function. In production this wraps Node's `spawn`;
 * in tests it is a fake that records calls and returns a fake pid.
 */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    detached: boolean;
    // `number` allows file descriptors (the log fd) as stdio targets;
    // `'ignore'` is retained for the fallback / review path. (#533)
    stdio: 'ignore' | Array<string | number | null>;
    /**
     * Absolute path to the per-session log file (#533). The production
     * lambda opens this in append mode and wires it to stdout+stderr;
     * the fake spawn in tests just records it.
     */
    logPath?: string;
    [key: string]: unknown;
  },
) => SpawnResult;

// ---------------------------------------------------------------------------
// Branch-slug derivation
// ---------------------------------------------------------------------------

const MAX_SLUG_LEN = 60;

/**
 * Derive the branch slug from an issue title:
 * lowercase, non-alphanumerics → hyphens, collapse runs, trim edges,
 * capped at MAX_SLUG_LEN characters.
 */
function titleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/, '');
}

// Field-id parsing + caching live in `./field-cache.ts` (jinn-mono#599).
// Pre-#585 a `getProjectItemId` helper called `gh project item-list --limit 500`
// here (~96 GraphQL points/dispatch); pre-#599 a per-dispatch `gh project
// field-list` call resolved the Status field id and "In Progress" option id.
// Both have been replaced by snapshot + cache reads.

// ---------------------------------------------------------------------------
// Canon loading
// ---------------------------------------------------------------------------

/**
 * Load the canon files (CLAUDE.md + engineering handbook) from the repo root.
 * These are always prepended to the session prompt because `-p` mode does not
 * auto-load CLAUDE.md (spec Appendix).
 */
export function loadCanon(): string {
  const claudeMd = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8').trim();
  const handbook = readFileSync(
    join(REPO_ROOT, 'docs', 'engineering', 'handbook.md'),
    'utf8',
  ).trim();
  return [
    '# CLAUDE.md (canonical)\n',
    claudeMd,
    '',
    '# Engineering handbook (canonical)\n',
    handbook,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Effort → --effort flag
// ---------------------------------------------------------------------------

/**
 * Map a board Effort value to the `claude` CLI `--effort` flag args (#1673).
 * Unset (null) → [] so the CLI default applies. Board casing lowercases to the
 * exact CLI tier: Low→low, Medium→medium, High→high, XHigh→xhigh, Max→max — a
 * single `.toLowerCase()` covers all five (no lookup table needed).
 */
export function effortFlag(effort: Effort | null): string[] {
  return effort == null ? [] : ['--effort', effort.toLowerCase()];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Dispatch one ready issue:
 *
 * 1. Derive the branch name: `<shape>/<N>-<slug>`
 * 2. Set the issue's Project Status to "In Progress" FIRST — so any subsequent
 *    partial failure leaves the issue In Progress (not Todo), which prevents
 *    selectReady from re-queuing it into an infinite retry loop.
 * 3. Create a git worktree at `<jinn-mono_worktrees>/<N>` off `origin/next`
 *    (sibling of the main repo per CLAUDE.md AI rule #1).
 *    Idempotent: if the worktree path already exists, reuse it rather than
 *    failing (handles the case where a previous run created the worktree but
 *    then crashed before spawning).
 * 4. Assemble the coordinating-session prompt:
 *    canon (CLAUDE.md + handbook) + headless-override block + implement-issue task
 * 5. Spawn `claude -p <prompt>` in the worktree, detached, no plan-posture flags
 * 6. Return the InFlightSession
 */
export async function dispatchIssue(
  issue: ReadyIssue,
  cfg: DispatcherConfig,
  deps: { runner: CommandRunner; spawn: SpawnFn; fieldCache: FieldCache },
): Promise<InFlightSession> {
  const { runner, spawn } = deps;
  const { number, title, shape } = issue;

  // 1. Branch name
  const slug = titleSlug(title);
  let branch = `${shape}/${number}-${slug}`;
  // Absolute path so git resolves correctly regardless of process cwd.
  const worktreePath = join(WORKTREES_BASE, String(number));

  // 2. Set Status → In Progress FIRST.
  //    This must happen before the worktree is created. If anything fails
  //    after this point, the issue stays In Progress (not Todo), so
  //    selectReady skips it — no infinite retry loop.
  //    Field id + "In Progress" option id come from the boot-time cache
  //    (jinn-mono#599 — see `./field-cache.ts`); item id arrives on
  //    ReadyIssue.projectItemId from the per-cycle snapshot (jinn-mono#585).
  const itemId = issue.projectItemId;

  // Wrap item-edit in a narrow stale-id retry: if the cached field id is
  // stale (rare — happens when the Project field is rebuilt mid-run), `gh`
  // fails with a stale-id error (see `isStaleFieldError` for the matched
  // phrasings). We reset + refetch the cache once and retry exactly once
  // before propagating.
  //
  // Propagation model (Stage 5 Finding 1 on jinn-mono#599):
  //   - The cache module in `./field-cache.ts` owns a singleton.
  //     `fetchFieldIds` rebinds it; `getFieldCache()` returns the current
  //     value.
  //   - Cross-cycle propagation happens via that singleton: run-autopilot.ts
  //     re-reads `getFieldCache()` at the top of every cycle, so the next
  //     cycle picks up the refreshed value automatically.
  //   - Within the in-flight dispatch we also mutate `deps.fieldCache = fresh`
  //     — this is intra-call only, scoping the refresh to any consumer that
  //     shares this `deps` reference for the rest of the current dispatch.
  //     It does NOT propagate across cycles; the singleton re-read does.
  const itemEditOnce = async (cache: FieldCache): Promise<void> => {
    await runner('gh', [
      'project', 'item-edit',
      '--id', itemId,
      '--project-id', cache.projectId,
      '--field-id', cache.status.fieldId,
      '--single-select-option-id', cache.status.options['In Progress'],
    ]);
  };

  try {
    await itemEditOnce(deps.fieldCache);
  } catch (err) {
    if (!isStaleFieldError(err)) throw err;
    resetFieldCache();
    const fresh = await fetchFieldIds(runner);
    // Deliberate mutation: propagate the refreshed cache to the call site so
    // any other consumer holding the same `deps.fieldCache` reference picks
    // up the new ids on its next read.
    deps.fieldCache = fresh;
    await itemEditOnce(fresh);
  }

  // 3. Create the worktree — idempotent.
  //    If the path already exists (e.g. a pre-created worktree from the
  //    dispatcher, or a previous partial run), reuse it instead of throwing.
  //    We detect this by running `git worktree list --porcelain` and checking
  //    whether any entry's path ends with the expected suffix.
  //
  //    Base branch: normally `origin/next`. When this issue was admitted
  //    *stacked* on its blocker's open PR (`ReadyIssue.stackBase`, a bare
  //    branch name), branch off that PR's head instead, so B builds on A's
  //    unmerged work (spec 2026-07-13). The blocker branch is not a local ref
  //    yet, so fetch it first — mirrors `review-dispatch.ts`.
  const stackBase = issue.stackBase;
  const baseRef = stackBase != null ? `origin/${stackBase}` : 'origin/next';
  const worktreeListRaw = await runner('git', ['worktree', 'list', '--porcelain']);
  const worktreeAlreadyExists = worktreeListRaw
    .split('\n')
    .some((line) => line.startsWith('worktree ') && line.trim() === `worktree ${worktreePath}`);

  if (!worktreeAlreadyExists) {
    if (stackBase != null) {
      // `--` terminates option parsing so a branch name that happens to start
      // with `-` can't be misread as a git option. (The sibling `worktree add
      // origin/${stackBase}` is already safe — the `origin/` prefix defuses a
      // leading dash.) (review 2026-07-13)
      await runner('git', ['fetch', '--quiet', 'origin', '--', stackBase]);
    }
    // A dangling local ref with this deterministic name (a prior worktree
    // removed without its ref — e.g. manual cleanup predating the drift
    // sweep) makes `worktree add -b` fatal, which used to abort the whole
    // dispatch loop (review 2026-07-15, observed live on #1664). Never reuse
    // or force-reset the old ref — it may carry unpushed strand commits —
    // pick the first free suffixed name instead (`-r2`…`-r9`; the label
    // sweep's `<shape>/<N>-` fingerprint still matches). If all are somehow
    // taken, fall through and let `-b` fail loudly.
    const base = branch;
    for (let i = 2; i <= 9; i++) {
      const taken = await runner('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
        .then(() => true)
        .catch(() => false);
      if (!taken) break;
      branch = `${base}-r${i}`;
    }
    await runner('git', [
      'worktree', 'add',
      worktreePath,
      '-b', branch,
      baseRef,
    ]);
  }

  // 4. Assemble the prompt.
  //    Canon is prepended because -p mode does not auto-load CLAUDE.md (spec Appendix).
  //    The scenario explicitly tells the session that the worktree is pre-created
  //    so the implement-issue skill's Step 2 skips worktree creation.
  const canon = loadCanon();
  const implementer = resolveImplementer(issue, cfg);
  const scenario = [
    `Use the implement-issue skill on issue #${number}.`,
    `The default implementer for the inner pipeline is: ${implementer}.`,
    `Issue: #${number} — ${title}`,
    `A git worktree for this issue already exists at \`${worktreePath}\` on branch \`${branch}\` — use it; do not create a new worktree.`,
    ...(stackBase != null
      ? [
          `This issue is stacked on its blocker: the worktree is already branched off \`${stackBase}\` (the blocker's open PR). Open your PR with base branch \`${stackBase}\`, NOT \`next\`. GitHub auto-retargets it to \`next\` when the blocker's PR merges.`,
        ]
      : []),
  ].join('\n');
  const headlessPart = buildHeadlessPrompt('implement-issue', scenario);
  const fullPrompt = [canon, '', headlessPart].join('\n');

  // 5. Spawn — NO plan-posture flags (spec Appendix).
  //    Per #533 we capture the session's stdout+stderr to a per-session log
  //    file. `dispatchIssue` stays I/O-free: it only computes the (stable,
  //    deterministic) log path and hands it to the injected spawn via opts.
  //    The production lambda (run-autopilot.ts) does the actual mkdir + append-
  //    mode openSync and wires the fd to stdout+stderr; the test fake just
  //    records the opts. `stdio` is the placeholder the lambda overrides with
  //    [ 'ignore', fd, fd ]; it must not be 'ignore' so the captured-stdio
  //    test holds. We send stdin to 'ignore' (the session is headless) and
  //    inherit for 1/2 as a safe default the lambda replaces.
  const logPath = sessionLogPath(number);
  const result = spawn('claude', ['-p', ...effortFlag(issue.effort), fullPrompt], {
    cwd: worktreePath,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    logPath,
    // Author this PR as the implementer identity (DR-2026-06-15); inherits the
    // ambient gh account when no token is configured. Also disables the
    // print-mode background-wait ceiling so the session reaches its PR stage.
    ...sessionSpawnEnv(cfg.implGhToken),
  });

  // AC#2: surface pid + log path on the dispatch log line so an operator can
  // tail the session straight from the cycle output.
  console.log(`[dispatch] #${number} impl=${implementer} pid=${result.pid ?? 'unknown'} log=${logPath}`);

  // 6. Return InFlightSession (logPath surfaced for downstream visibility).
  return {
    issueNumber: number,
    branch,
    worktreePath,
    pid: result.pid ?? null,
    startedAt: Date.now(),
    logPath,
  };
}
