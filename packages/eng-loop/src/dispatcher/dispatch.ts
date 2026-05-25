import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import type { ReadyIssue, DispatcherConfig, InFlightSession } from './types.js';
import type { CommandRunner } from './issue-source.js';
import { buildHeadlessPrompt } from '../headless.js';

// ---------------------------------------------------------------------------
// Repo root + canonical worktree base
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
// src/dispatcher → src → packages/eng-loop → packages → repo root
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

/**
 * Per CLAUDE.md AI rule #1, multi-agent worktrees live in
 * `../jinn-mono_worktrees/<name>` — sibling of the main repo checkout.
 *
 * When the dispatcher itself runs *inside* that sibling dir (i.e. its own
 * REPO_ROOT is already a worktree under `jinn-mono_worktrees/`, common while
 * `packages/eng-loop` lives on an unmerged branch), the canonical base IS the
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
// ---------------------------------------------------------------------------

const PROJECT_OWNER = 'Jinn-Network';
const PROJECT_NUMBER = '1';
const PROJECT_ID = 'PVT_kwDODh3-Ac4BXYaI';

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
    stdio: 'ignore' | Array<string | null>;
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

// ---------------------------------------------------------------------------
// gh project field helpers
// ---------------------------------------------------------------------------

interface GhFieldOption {
  id: string;
  name: string;
}

interface GhField {
  id: string;
  name: string;
  options?: GhFieldOption[];
}

interface GhFieldListResponse {
  fields: GhField[];
}

/**
 * Look up the "In Progress" option id from the Status field in the project
 * field-list response. Returns both the field id and option id.
 */
function parseStatusField(
  data: GhFieldListResponse,
): { fieldId: string; inProgressOptionId: string } {
  const statusField = data.fields.find((f) => f.name === 'Status');
  if (statusField == null) {
    throw new Error('Status field not found in gh project field-list response');
  }
  const inProgressOpt = (statusField.options ?? []).find(
    (o) => o.name === 'In Progress',
  );
  if (inProgressOpt == null) {
    throw new Error('"In Progress" option not found in Status field');
  }
  return { fieldId: statusField.id, inProgressOptionId: inProgressOpt.id };
}

// Note: pre-#585 a `getProjectItemId(runner, issueNumber)` helper called
// `gh project item-list --limit 500` here (~96 GraphQL points per dispatch).
// `ReadyIssue.projectItemId` is now populated from the per-cycle snapshot
// (jinn-mono#585) so the dispatcher can read the item id directly.

// ---------------------------------------------------------------------------
// Canon loading
// ---------------------------------------------------------------------------

/**
 * Load the canon files (CLAUDE.md + engineering handbook) from the repo root.
 * These are always prepended to the session prompt because `-p` mode does not
 * auto-load CLAUDE.md (spec Appendix).
 */
function loadCanon(): string {
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
  deps: { runner: CommandRunner; spawn: SpawnFn },
): Promise<InFlightSession> {
  const { runner, spawn } = deps;
  const { number, title, shape } = issue;

  // 1. Branch name
  const slug = titleSlug(title);
  const branch = `${shape}/${number}-${slug}`;
  // Absolute path so git resolves correctly regardless of process cwd.
  const worktreePath = join(WORKTREES_BASE, String(number));

  // 2. Set Status → In Progress FIRST.
  //    This must happen before the worktree is created. If anything fails
  //    after this point, the issue stays In Progress (not Todo), so
  //    selectReady skips it — no infinite retry loop.
  //    a) discover field id + option id
  const fieldListRaw = await runner('gh', [
    'project', 'field-list', PROJECT_NUMBER,
    '--owner', PROJECT_OWNER,
    '--format', 'json',
  ]);
  const fieldListData = JSON.parse(fieldListRaw) as GhFieldListResponse;
  const { fieldId, inProgressOptionId } = parseStatusField(fieldListData);

  //    b) read the project item id from the snapshot-populated field on
  //       ReadyIssue (jinn-mono#585) — no extra `gh project item-list` call.
  const itemId = issue.projectItemId;

  //    c) set the field
  await runner('gh', [
    'project', 'item-edit',
    '--id', itemId,
    '--project-id', PROJECT_ID,
    '--field-id', fieldId,
    '--single-select-option-id', inProgressOptionId,
  ]);

  // 3. Create the worktree — idempotent.
  //    If the path already exists (e.g. a pre-created worktree from the
  //    dispatcher, or a previous partial run), reuse it instead of throwing.
  //    We detect this by running `git worktree list --porcelain` and checking
  //    whether any entry's path ends with the expected suffix.
  const worktreeListRaw = await runner('git', ['worktree', 'list', '--porcelain']);
  const worktreeAlreadyExists = worktreeListRaw
    .split('\n')
    .some((line) => line.startsWith('worktree ') && line.trim() === `worktree ${worktreePath}`);

  if (!worktreeAlreadyExists) {
    await runner('git', [
      'worktree', 'add',
      worktreePath,
      '-b', branch,
      'origin/next',
    ]);
  }

  // 4. Assemble the prompt.
  //    Canon is prepended because -p mode does not auto-load CLAUDE.md (spec Appendix).
  //    The scenario explicitly tells the session that the worktree is pre-created
  //    so the implement-issue skill's Step 2 skips worktree creation.
  const canon = loadCanon();
  const implementer = cfg.defaultImplementer;
  const scenario = [
    `Use the implement-issue skill on issue #${number}.`,
    `The default implementer for the inner pipeline is: ${implementer}.`,
    `Issue: #${number} — ${title}`,
    `A git worktree for this issue already exists at \`${worktreePath}\` on branch \`${branch}\` — use it; do not create a new worktree.`,
  ].join('\n');
  const headlessPart = buildHeadlessPrompt('implement-issue', scenario);
  const fullPrompt = [canon, '', headlessPart].join('\n');

  // 5. Spawn — NO plan-posture flags (spec Appendix)
  const result = spawn('claude', ['-p', fullPrompt], {
    cwd: worktreePath,
    detached: true,
    stdio: 'ignore',
  });

  // 6. Return InFlightSession
  return {
    issueNumber: number,
    branch,
    worktreePath,
    pid: result.pid ?? null,
    startedAt: Date.now(),
  };
}
