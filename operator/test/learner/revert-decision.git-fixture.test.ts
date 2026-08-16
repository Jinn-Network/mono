import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashImplStateDir } from '../../src/harnesses/freeze.js';
import { LEARNER_PUBLIC_V1 } from '../../src/harnesses/hash-profile.js';
import {
  decideRevert,
  DEFAULT_REVERT_POLICY,
  type CodeDigestAggregate,
} from '../../src/learner/revert-decision.js';

// Mirrors production's `codeDigestForCommit`, which hashes under the learner's
// registered profile as of #2118 — not an ad hoc ignore list.
const PROFILE = LEARNER_PUBLIC_V1;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Export a commit's tree (no .git) and hash it the way production does. */
async function codeDigestAt(repoDir: string, sha: string): Promise<string> {
  const exportDir = await mkdtemp(join(tmpdir(), 'cd-export-'));
  try {
    // `git archive <sha> | tar -x -C exportDir` — tree only, no .git.
    const tar = execFileSync('git', ['archive', sha], { cwd: repoDir, maxBuffer: 1 << 28 });
    execFileSync('tar', ['-x', '-C', exportDir], { input: tar });
    const hex = await hashImplStateDir(exportDir, { profile: PROFILE });
    return `sha256:${hex}`;
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
}

describe('per-codeDigest revert selection over a synthetic git history (#764 AC5)', () => {
  it('reverts the significantly-worse commit and leaves the under-threshold one', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'implstate-'));
    try {
      git(repo, 'init', '--initial-branch=main', '--quiet');
      git(repo, 'config', 'user.email', 'test@example.invalid');
      git(repo, 'config', 'user.name', 'test');

      // init commit
      await mkdir(join(repo, 'skills'), { recursive: true });
      await writeFile(join(repo, 'skills', 'base.md'), 'base', 'utf8');
      git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'init');
      const c0 = git(repo, 'rev-parse', 'HEAD');

      // Improve commit 1 — will be the BIG regression (revert this)
      await writeFile(join(repo, 'skills', 'a.md'), 'change-a', 'utf8');
      git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'improve: a');
      const c1 = git(repo, 'rev-parse', 'HEAD');

      // Improve commit 2 — slightly worse but under significance (do NOT revert)
      await writeFile(join(repo, 'skills', 'b.md'), 'change-b', 'utf8');
      git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'improve: b');
      const c2 = git(repo, 'rev-parse', 'HEAD');

      // Distinct codeDigests per commit (real hasher).
      const [d0, d1, d2] = await Promise.all([
        codeDigestAt(repo, c0),
        codeDigestAt(repo, c1),
        codeDigestAt(repo, c2),
      ]);
      expect(new Set([d0, d1, d2]).size).toBe(3);

      // Seeded aggregates: c1-with-commit is much worse than its parent c0;
      // c2-with-commit is marginally worse than its parent c1 (not significant).
      const seeded: Record<string, CodeDigestAggregate> = {
        [d0]: { codeDigest: d0, attempts: 100, passes: 85, passRate: 0.85, gradedScores: [] },
        [d1]: { codeDigest: d1, attempts: 100, passes: 45, passRate: 0.45, gradedScores: [] }, // big drop vs d0
        [d2]: { codeDigest: d2, attempts: 100, passes: 42, passRate: 0.42, gradedScores: [] }, // ~same as d1
      };

      const decideForCommit = (childDigest: string, parentDigest: string) =>
        decideRevert(
          { withCommit: seeded[childDigest]!, atParent: seeded[parentDigest]! },
          DEFAULT_REVERT_POLICY,
        );

      const toRevert: string[] = [];
      for (const { sha, child, parent } of [
        { sha: c1, child: d1, parent: d0 },
        { sha: c2, child: d2, parent: d1 },
      ]) {
        if (decideForCommit(child, parent).recommendRevert) toRevert.push(sha);
      }

      expect(toRevert).toEqual([c1]); // only the significant regression
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
