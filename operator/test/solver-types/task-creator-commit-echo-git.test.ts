import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createGitCommitEchoDeps,
  extractCommitEchoPatchesAtBase,
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

describe('source-derived patch extraction (Jinn #1422 shape)', () => {
  // Hermetic fixture reproducing the shape of the real #1422 fix pair
  // (two source files + two regression-test files in one fix commit).
  // Built in a throwaway repo so the test never depends on host-repo
  // history — CI checks out pull/N/merge with fetch-depth 1.
  const codePaths = [
    'operator/src/daemon/daemon.ts',
    'operator/src/harnesses/engine/engine.ts',
  ];
  const testPaths = [
    'operator/test/daemon/daemon-recovery-nonblocking.test.ts',
    'operator/test/harnesses/engine/recovery.test.ts',
  ];
  let dir: string;
  let baseCommit: string;
  let fixCommit: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'commit-echo-extract-'));
    await git(dir, ['init']);
    await git(dir, ['config', 'user.email', 'test@example.com']);
    await git(dir, ['config', 'user.name', 'Test']);

    const writeAll = async (marker: string) => {
      for (const path of [...codePaths, ...testPaths]) {
        await mkdir(join(dir, dirname(path)), { recursive: true });
        await writeFile(join(dir, path), `// ${marker} ${path}\n`);
      }
    };

    await writeAll('base');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', 'initial']);
    baseCommit = (await git(dir, ['rev-parse', 'HEAD'])).trim();

    await writeAll('fixed');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', 'fix: bound recovery scope']);
    fixCommit = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('uses the exact parent/fix pair and keeps both regression files out of the gold patch', async () => {
    const patches = await extractCommitEchoPatchesAtBase(dir, { baseCommit, fixCommit });

    expect(patches.testPaths).toEqual(testPaths);
    expect(patches.goldPatch).toContain('operator/src/daemon/daemon.ts');
    expect(patches.goldPatch).toContain('operator/src/harnesses/engine/engine.ts');
    for (const path of testPaths) {
      expect(patches.goldPatch).not.toContain(`diff --git a/${path} b/${path}`);
      expect(patches.testPatch).toContain(`diff --git a/${path} b/${path}`);
    }
  });

  it('rejects a declared base that is not the fix commit exact parent', async () => {
    await expect(
      extractCommitEchoPatchesAtBase(dir, { baseCommit: fixCommit, fixCommit }),
    ).rejects.toThrow(/exact parent/);
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
    expect(candidates[0]!.test_patch).toContain('tests/test_widget.py');
    expect(candidates[0]!.test_paths).toEqual(['tests/test_widget.py']);
    expect(candidates[0]!.language).toBe('python');
    expect(candidates[0]!.problem_statement).toContain('fix:');
  });
});
