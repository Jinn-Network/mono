import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createGitCommitEchoDeps,
  splitGoldAndTestPatch,
} from '../../src/solver-types/_swe-rebench-v2-commit-echo-git.js';
import { discoverCommitEchoCandidates } from '../../src/solver-types/_swe-rebench-v2-commit-echo.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000 });
  return stdout;
}

describe('splitGoldAndTestPatch', () => {
  it('splits test hunks from code hunks', () => {
    const diff = [
      'diff --git a/src/widget.py b/src/widget.py',
      '--- a/src/widget.py',
      '+++ b/src/widget.py',
      '@@ -1 +1 @@',
      '-bad',
      '+good',
      'diff --git a/tests/test_widget.py b/tests/test_widget.py',
      '--- a/tests/test_widget.py',
      '+++ b/tests/test_widget.py',
      '@@ -1 +1 @@',
      '+def test_widget(): pass',
      '',
    ].join('\n');
    const { goldPatch, testPatch } = splitGoldAndTestPatch(diff);
    expect(goldPatch).toContain('widget.py');
    expect(goldPatch).not.toContain('tests/test_widget.py');
    expect(testPatch).toContain('tests/test_widget.py');
  });
});

describe('createGitCommitEchoDeps', () => {
  let dir: string;
  let snapshot: string;
  let fixCommit: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'commit-echo-'));
    await git(dir, ['init']);
    await git(dir, ['config', 'user.email', 'test@example.com']);
    await git(dir, ['config', 'user.name', 'Test']);
    await git(dir, ['checkout', '-b', 'main']);

    // initial broken state
    await execFileAsync('bash', ['-c', `mkdir -p src tests
cat > src/widget.py <<'EOF'
def run():
    return 0
EOF
cat > tests/test_widget.py <<'EOF'
def test_run():
    assert run() == 1
EOF`], { cwd: dir });
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', 'initial']);

    snapshot = (await git(dir, ['rev-parse', 'HEAD'])).trim();

    // fix commit — touches both code and test (fix-shaped heuristic)
    await execFileAsync('bash', ['-c', `cat > src/widget.py <<'EOF'
def run():
    return 1
EOF
cat > tests/test_widget.py <<'EOF'
def test_run():
    assert run() == 1  # fixed assertion
EOF`], { cwd: dir });
    await git(dir, ['add', 'src/widget.py', 'tests/test_widget.py']);
    await git(dir, ['commit', '-m', 'fix: correct widget return value']);
    fixCommit = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('discovers fix-shaped commit with parent base_commit', async () => {
    const deps = createGitCommitEchoDeps({
      path: dir,
      repo: 'acme/widget',
    });
    const candidates = await discoverCommitEchoCandidates(
      [{ repo: 'acme/widget', snapshotCommit: snapshot }],
      deps,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.fix_commit).toBe(fixCommit);
    expect(candidates[0]!.base_commit).toBe(snapshot);
    expect(candidates[0]!.gold_patch).toContain('return 1');
    expect(candidates[0]!.problem_statement).toContain('fix:');
  });
});
