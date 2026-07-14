/**
 * Production git adapter for the commit-echo miner (spec §5.2).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitEchoDeps } from './_swe-rebench-v2-commit-echo.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

const FIX_SHAPED_SUBJECT =
  /\b(fix|bug|patch|repair|resolve|correct|hotfix|regression)\b/i;

const DEFAULT_TEST_PATH = /(^|\/)(tests?|test|testing)(\/|$)|\.test\.|_test\.|\/spec\//i;

export interface GitCommitEchoRepoConfig {
  /** Absolute path to a local git clone. */
  path: string;
  /** GitHub `owner/repo` slug used in minted instance ids. */
  repo: string;
  /** Optional remote name for `git fetch` before scanning. */
  remote?: string;
  /** Override test-file path heuristic. */
  testPathRe?: RegExp;
}

export interface CreateGitCommitEchoDepsOpts extends GitCommitEchoRepoConfig {
  execFileAsync?: typeof execFileAsync;
}

async function git(
  repoPath: string,
  args: string[],
  exec: typeof execFileAsync,
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export function splitGoldAndTestPatch(
  unifiedDiff: string,
  testPathRe: RegExp = DEFAULT_TEST_PATH,
): { goldPatch: string; testPatch: string } {
  const hunks = unifiedDiff.split(/(?=^diff --git )/m).filter(Boolean);
  const gold: string[] = [];
  const test: string[] = [];
  for (const hunk of hunks) {
    const pathMatch = hunk.match(/^diff --git a\/(.+?) b\//m);
    const path = pathMatch?.[1] ?? '';
    if (testPathRe.test(path)) test.push(hunk);
    else gold.push(hunk);
  }
  return { goldPatch: gold.join(''), testPatch: test.join('') };
}

export function createGitCommitEchoDeps(
  opts: CreateGitCommitEchoDepsOpts,
): CommitEchoDeps {
  const exec = opts.execFileAsync ?? execFileAsync;
  const testPathRe = opts.testPathRe ?? DEFAULT_TEST_PATH;
  const repoPath = opts.path;
  const repoSlug = opts.repo;

  return {
    listCommitsAfter: async (_repo, sinceCommit) => {
      if (opts.remote) {
        try {
          await git(repoPath, ['fetch', '--quiet', opts.remote], exec);
        } catch (err) {
          console.warn(
            `[commit-echo] git fetch ${opts.remote} failed for ${repoSlug}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      const range = sinceCommit ? `${sinceCommit}..HEAD` : 'HEAD';
      const out = await git(repoPath, ['log', '--reverse', '--format=%H', range], exec);
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{40}$/i.test(l));
    },

    extractGoldPatch: async (_repo, fixCommit) => {
      const parent = (await git(repoPath, ['rev-parse', `${fixCommit}^`], exec)).trim();
      const diff = await git(repoPath, ['diff', '--binary', parent, fixCommit], exec);
      return splitGoldAndTestPatch(diff, testPathRe).goldPatch;
    },

    parentOf: async (_repo, fixCommit) =>
      (await git(repoPath, ['rev-parse', `${fixCommit}^`], exec)).trim(),

    isFixShapedCommit: async (_repo, fixCommit) => {
      const parents = (await git(repoPath, ['rev-list', '--parents', '-n', '1', fixCommit], exec))
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (parents.length < 2) return false;
      if (parents.length > 2) return false;

      const numstat = await git(repoPath, ['diff', '--numstat', `${fixCommit}^`, fixCommit], exec);
      const lines = numstat.split('\n').filter(Boolean);
      if (lines.length === 0 || lines.length > 40) return false;

      let touchesCode = false;
      let touchesTest = false;
      let totalChanged = 0;
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const path = parts[2] ?? '';
        const added = Number(parts[0]);
        const removed = Number(parts[1]);
        if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
        totalChanged += added + removed;
        if (testPathRe.test(path)) touchesTest = true;
        else touchesCode = true;
      }
      if (!touchesCode || !touchesTest || totalChanged > 2000) return false;

      const subject = (
        await git(repoPath, ['log', '-1', '--format=%s', fixCommit], exec)
      ).trim();
      return FIX_SHAPED_SUBJECT.test(subject);
    },

    problemStatementFor: async (_repo, fixCommit) => {
      const subject = (
        await git(repoPath, ['log', '-1', '--format=%s', fixCommit], exec)
      ).trim();
      const body = (
        await git(repoPath, ['log', '-1', '--format=%b', fixCommit], exec)
      ).trim();
      return body ? `${subject}\n\n${body}` : subject;
    },
  };
}

/** Parse `owner/repo` from a GitHub-style remote URL. */
export function repoSlugFromRemoteUrl(url: string): string | null {
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(url.trim());
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

export async function resolveHarvestRepoSlug(
  repoPath: string,
  remote = 'origin',
  exec: typeof execFileAsync = execFileAsync,
): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', repoPath, 'remote', 'get-url', remote], {
      timeout: GIT_TIMEOUT_MS,
    });
    return repoSlugFromRemoteUrl(stdout.trim());
  } catch {
    return null;
  }
}

/** Parent commit of `fixCommit` in a local clone — used as pre-fix base_commit. */
export async function resolveFixParentCommit(
  repoPath: string,
  fixCommit: string,
  exec: typeof execFileAsync = execFileAsync,
): Promise<string> {
  const { stdout } = await exec('git', ['-C', repoPath, 'rev-parse', `${fixCommit}^`], {
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout.trim();
}
