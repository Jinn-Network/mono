/**
 * Commit-echo miner — walk fresh upstream commits in repos with admitted images.
 * Spec §5.2, D4 (plumbing proof).
 */

import type { PoolTask } from './_swe-rebench-v2-pool.js';

export interface CommitEchoCandidate {
  instance_id: string;
  repo: string;
  base_commit: string;
  fix_commit: string;
  gold_patch: string;
  /** Regression tests introduced or changed by this exact fix commit. */
  test_patch: string;
  /** Repository-relative paths carried by `test_patch` (never source-row paths). */
  test_paths: string[];
  /** Language inferred from this commit's own changed paths. */
  language: string;
  problem_statement: string;
}

export interface CommitEchoPatches {
  goldPatch: string;
  testPatch: string;
  testPaths: string[];
  language: string;
}

export interface CommitEchoDeps {
  /** List commit SHAs on repo after snapshotCommit, oldest first. */
  listCommitsAfter: (repo: string, snapshotCommit: string) => Promise<string[]>;
  /** Parent of fixCommit (pre-fix state). */
  parentOf: (repo: string, fixCommit: string) => Promise<string>;
  /** Return unified diff for fix_commit vs parent. */
  extractGoldPatch: (repo: string, fixCommit: string) => Promise<string>;
  /**
   * Return source and regression-test material from the same commit.  This is
   * optional only to preserve older callers while they upgrade; candidates
   * without it intentionally carry an empty test patch and are not allowed to
   * borrow one from a benchmark source row downstream.
   */
  extractPatches?: (repo: string, fixCommit: string) => Promise<CommitEchoPatches>;
  /** Heuristic: commit looks like a test-fixing change. */
  isFixShapedCommit: (repo: string, fixCommit: string) => Promise<boolean>;
  problemStatementFor: (repo: string, fixCommit: string) => Promise<string>;
}

export function commitEchoInstanceId(repo: string, fixCommit: string): string {
  const slug = repo.replace(/\//g, '__');
  return `${slug}__echo-${fixCommit.slice(0, 12)}`;
}

export async function discoverCommitEchoCandidates(
  repos: Array<{ repo: string; snapshotCommit: string }>,
  deps: CommitEchoDeps,
  opts: { limitPerRepo?: number } = {},
): Promise<CommitEchoCandidate[]> {
  const out: CommitEchoCandidate[] = [];
  for (const { repo, snapshotCommit } of repos) {
    const commits = await deps.listCommitsAfter(repo, snapshotCommit);
    let taken = 0;
    for (const fixCommit of commits) {
      if (opts.limitPerRepo != null && taken >= opts.limitPerRepo) break;
      if (!(await deps.isFixShapedCommit(repo, fixCommit))) continue;
      const patches = deps.extractPatches
        ? await deps.extractPatches(repo, fixCommit)
        : {
            goldPatch: await deps.extractGoldPatch(repo, fixCommit),
            testPatch: '',
            testPaths: [],
            language: 'unknown',
          };
      const base_commit = await deps.parentOf(repo, fixCommit);
      out.push({
        instance_id: commitEchoInstanceId(repo, fixCommit),
        repo,
        base_commit,
        fix_commit: fixCommit,
        gold_patch: patches.goldPatch,
        test_patch: patches.testPatch,
        test_paths: patches.testPaths,
        language: patches.language,
        problem_statement: await deps.problemStatementFor(repo, fixCommit),
      });
      taken += 1;
    }
  }
  return out;
}

export function commitEchoToPoolTask(
  candidate: CommitEchoCandidate,
  row: {
    hf_dataset: string;
    hf_split: string;
    patch: string;
    test_patch: string;
    language?: string;
  },
): PoolTask {
  return {
    instance_id: candidate.instance_id,
    hf_dataset: row.hf_dataset,
    hf_split: row.hf_split,
    repo: candidate.repo,
    base_commit: candidate.base_commit,
    patch: row.patch,
    test_patch: row.test_patch,
    language: row.language ?? 'python',
    problem_statement: candidate.problem_statement,
  };
}
