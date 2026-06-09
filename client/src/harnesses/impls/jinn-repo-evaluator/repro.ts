/**
 * Repo-native repro for the jinn-repo SolverType.
 *
 * Clones Jinn-Network/mono at a task's `base_commit` into a throwaway dir,
 * applies a candidate patch, and overwrites the PR's gold test files. The
 * caller (eval-runner) then installs deps and runs the targeted test to
 * grade the patch (SWE-bench FAIL_TO_PASS pattern).
 *
 * Deliberately does NOT install or run anything — that is the eval-runner's
 * job, so it can classify install failure as `unscorable` separately from a
 * test failure (FAIL).
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const sh = promisify(execFile);

export interface PreparedRepro {
  dir: string;
  cleanup: () => Promise<void>;
}

export async function prepareRepro(args: {
  monoRepoUrl: string;
  baseCommit: string;
  patch: string;
  goldTestFiles: Record<string, string>; // relpath (from repo root) -> contents
}): Promise<PreparedRepro> {
  const dir = await mkdtemp(join(tmpdir(), 'jinn-repo-eval-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    // Shallow single-commit fetch keeps the clone tractable even though the
    // mono history is large. Works against both https and file:// remotes.
    await sh('git', ['init', '-q', dir]);
    await sh('git', ['-C', dir, 'remote', 'add', 'origin', args.monoRepoUrl]);
    await sh('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', args.baseCommit]);
    await sh('git', ['-C', dir, 'checkout', '-q', args.baseCommit]);

    // Apply the candidate patch (skip when empty — an empty patch is a valid
    // "no-op" candidate that must still be graded, and `git apply` errors on
    // empty input).
    if (args.patch.trim().length > 0) {
      const patchPath = join(dir, '.candidate.patch');
      await writeFile(patchPath, args.patch);
      await sh('git', ['-C', dir, 'apply', '--3way', patchPath]);
    }

    // Overwrite the gold tests last so a candidate patch can never weaken
    // them. relpath is from the repo root (e.g. client/test/...).
    for (const [rel, contents] of Object.entries(args.goldTestFiles)) {
      const dest = join(dir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, contents);
    }

    return { dir, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
