import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ReviewablePr, DispatcherConfig, InFlightReview } from './types.js';
import type { CommandRunner } from './issue-source.js';
import type { SpawnFn } from './dispatch.js';
import { WORKTREES_BASE } from './dispatch.js';
import { buildHeadlessPrompt } from '../headless.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// src/dispatcher → src → packages/eng-loop → packages → repo root
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
  _cfg: DispatcherConfig,
  deps: { runner: CommandRunner; spawn: SpawnFn },
): Promise<InFlightReview> {
  const { runner, spawn } = deps;
  const worktreePath = join(WORKTREES_BASE, `pr-${pr.number}`);

  await runner('git', ['fetch', 'origin', pr.headRefName, '--quiet']);

  const listRaw = await runner('git', ['worktree', 'list', '--porcelain']);
  const exists = listRaw
    .split('\n')
    .some((line) => line.startsWith('worktree ') && line.trim() === `worktree ${worktreePath}`);
  if (!exists) {
    await runner('git', ['worktree', 'add', worktreePath, '-B', pr.headRefName, `origin/${pr.headRefName}`]);
  }

  const canon = loadCanon();
  const scenario = [
    `Use the review-pr skill on PR #${pr.number}.`,
    `PR: #${pr.number} — ${pr.title} (head branch \`${pr.headRefName}\`, head ${pr.headRefOid}).`,
    `A git worktree for this PR already exists at \`${worktreePath}\`, checked out on the PR head branch — use it; do not create a new worktree.`,
  ].join('\n');
  const fullPrompt = [canon, '', buildHeadlessPrompt('review-pr', scenario)].join('\n');

  const result = spawn('claude', ['-p', fullPrompt], { cwd: worktreePath, detached: true, stdio: 'ignore' });

  return {
    prNumber: pr.number,
    branch: pr.headRefName,
    worktreePath,
    pid: result.pid ?? null,
    startedAt: Date.now(),
  };
}
