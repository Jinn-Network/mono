/**
 * Production git adapter for the commit-echo miner (spec §5.2).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitEchoDeps, CommitEchoPatches } from './_swe-rebench-v2-commit-echo.js';

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
  const { stdout } = await exec('git', ['-C', repoPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export interface CommitEchoPatchRange {
  /** The exact pre-fix parent to evaluate. */
  baseCommit: string;
  /** The single-parent source fix whose diff is split into code/test material. */
  fixCommit: string;
}

/**
 * Extract a commit-echo patch only when the declared base is the fix's exact
 * parent.  A range such as a GitHub merge commit can otherwise silently
 * produce unrelated documentation or accumulated changes as "gold".
 */
export async function extractCommitEchoPatchesAtBase(
  repoPath: string,
  range: CommitEchoPatchRange,
  exec: typeof execFileAsync = execFileAsync,
  testPathRe: RegExp = DEFAULT_TEST_PATH,
): Promise<CommitEchoPatches> {
  if (!/^[0-9a-f]{40}$/i.test(range.baseCommit) || !/^[0-9a-f]{40}$/i.test(range.fixCommit)) {
    throw new Error('commit-echo patch extraction requires full 40-hex base and fix commits');
  }
  const parent = (await git(repoPath, ['rev-parse', `${range.fixCommit}^`], exec)).trim();
  if (parent !== range.baseCommit) {
    throw new Error(
      `commit-echo fix ${range.fixCommit} must have declared base ${range.baseCommit} as its exact parent (got ${parent})`,
    );
  }
  const diff = await git(repoPath, ['diff', '--binary', range.baseCommit, range.fixCommit], exec);
  const split = splitGoldAndTestPatch(diff, testPathRe);
  return {
    goldPatch: split.goldPatch,
    testPatch: split.testPatch,
    testPaths: split.testPaths,
    language: inferLanguageFromPaths(split.paths),
  };
}

export function splitGoldAndTestPatch(
  unifiedDiff: string,
  testPathRe: RegExp = DEFAULT_TEST_PATH,
): { goldPatch: string; testPatch: string; testPaths: string[]; paths: string[] } {
  const hunks = unifiedDiff.split(/(?=^diff --git )/m).filter(Boolean);
  const gold: string[] = [];
  const test: string[] = [];
  const testPaths: string[] = [];
  const paths: string[] = [];
  for (const hunk of hunks) {
    const pathMatch = hunk.match(/^diff --git a\/(.+?) b\//m);
    const path = pathMatch?.[1] ?? '';
    if (path && !path.includes('..')) paths.push(path);
    // A supplied RegExp can be global; reset its cursor so paths cannot
    // alternate between test/non-test classifications.
    testPathRe.lastIndex = 0;
    if (testPathRe.test(path)) {
      test.push(hunk);
      if (path && !path.includes('..')) testPaths.push(path);
    } else gold.push(hunk);
  }
  return {
    goldPatch: gold.join(''),
    testPatch: test.join(''),
    testPaths: [...new Set(testPaths)],
    paths: [...new Set(paths)],
  };
}

/** Conservative, commit-local language inference for a public code task. */
export function inferLanguageFromPaths(paths: readonly string[]): string {
  const extensions = paths
    .map((path) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase())
    .filter((extension): extension is string => Boolean(extension));
  const counts = new Map<string, number>();
  const byExtension: Record<string, string> = {
    py: 'python', pyw: 'python',
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    rb: 'ruby', php: 'php', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c',
  };
  for (const extension of extensions) {
    const language = byExtension[extension];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best?.[0] ?? 'unknown';
}

export function createGitCommitEchoDeps(
  opts: CreateGitCommitEchoDepsOpts,
): CommitEchoDeps {
  const exec = opts.execFileAsync ?? execFileAsync;
  const testPathRe = opts.testPathRe ?? DEFAULT_TEST_PATH;
  const repoPath = opts.path;
  const repoSlug = opts.repo;

  const extractPatches = async (_repo: string, fixCommit: string): Promise<CommitEchoPatches> => {
    const parent = (await git(repoPath, ['rev-parse', `${fixCommit}^`], exec)).trim();
    return extractCommitEchoPatchesAtBase(repoPath, {
      baseCommit: parent,
      fixCommit,
    }, exec, testPathRe);
  };

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

    extractGoldPatch: async (repo, fixCommit) => (await extractPatches(repo, fixCommit)).goldPatch,

    extractPatches,

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
