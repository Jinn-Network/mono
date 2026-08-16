import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTestPath,
  stripTestPathHunks,
  gitApplyParseCheck,
} from '../../../../src/harnesses/impls/learner/restoration-patch.js';

describe('isTestPath', () => {
  it('flags conventional test directories', () => {
    expect(isTestPath('pkg/tests/test_x.py')).toBe(true);
    expect(isTestPath('a/test/foo.c')).toBe(true);
    expect(isTestPath('src/__tests__/x.test.ts')).toBe(true);
    expect(isTestPath('src/main/java/com/x/Foo.java')).toBe(false);
    expect(isTestPath('src/test/java/com/x/FooTest.java')).toBe(true);
  });

  it('flags conventional test filenames', () => {
    expect(isTestPath('pkg/test_graph.py')).toBe(true);
    expect(isTestPath('pkg/graph_test.py')).toBe(true);
    expect(isTestPath('pkg/conftest.py')).toBe(true);
    expect(isTestPath('internal/foo_test.go')).toBe(true);
    expect(isTestPath('src/foo.test.tsx')).toBe(true);
    expect(isTestPath('src/foo.spec.js')).toBe(true);
    expect(isTestPath('com/x/FooTests.java')).toBe(true);
  });

  it('does not flag plain source files', () => {
    expect(isTestPath('pkg/graph.py')).toBe(false);
    expect(isTestPath('src/index.ts')).toBe(false);
    expect(isTestPath('internal/foo.go')).toBe(false);
    expect(isTestPath('contrib/latest.py')).toBe(false); // not test_*; not *_test
  });
});

describe('stripTestPathHunks', () => {
  it('removes whole diff sections for test paths but keeps source sections', () => {
    const patch = [
      'diff --git a/src/foo.py b/src/foo.py',
      'index 1111111..2222222 100644',
      '--- a/src/foo.py',
      '+++ b/src/foo.py',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/tests/test_foo.py b/tests/test_foo.py',
      'index 3333333..4444444 100644',
      '--- a/tests/test_foo.py',
      '+++ b/tests/test_foo.py',
      '@@ -10,3 +10,9 @@',
      ' def test_existing():',
      '     pass',
      '+',
      '+def test_new():',
      '+    assert True',
      '',
    ].join('\n');
    const out = stripTestPathHunks(patch);
    expect(out).toContain('a/src/foo.py');
    expect(out).not.toContain('tests/test_foo.py');
    expect(out).not.toContain('def test_new');
  });

  it('returns empty string when only test sections remain', () => {
    const patch = [
      'diff --git a/tests/test_foo.py b/tests/test_foo.py',
      '--- a/tests/test_foo.py',
      '+++ b/tests/test_foo.py',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    expect(stripTestPathHunks(patch)).toBe('');
  });

  it('drops a rename whose old or new side is a test path', () => {
    const patch = [
      'diff --git a/src/old_name.py b/tests/test_relocated.py',
      'similarity index 100%',
      'rename from src/old_name.py',
      'rename to tests/test_relocated.py',
      'diff --git a/src/keep.py b/src/keep.py',
      '--- a/src/keep.py',
      '+++ b/src/keep.py',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    const out = stripTestPathHunks(patch);
    expect(out).toContain('src/keep.py');
    expect(out).not.toContain('test_relocated');
  });

  it('is idempotent and leaves an all-source patch untouched', () => {
    const patch = [
      'diff --git a/src/a.py b/src/a.py',
      '--- a/src/a.py',
      '+++ b/src/a.py',
      '@@ -1 +1 @@',
      '-1',
      '+2',
      '',
    ].join('\n');
    const once = stripTestPathHunks(patch);
    expect(once).toContain('src/a.py');
    expect(stripTestPathHunks(once)).toBe(once);
  });

  it('passes through a non-git-format patch unchanged', () => {
    const patch = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
    expect(stripTestPathHunks(patch)).toBe(patch);
  });

  it('appends a trailing newline when the source patch ends mid-line', () => {
    const patch = [
      'diff --git a/src/a.py b/src/a.py',
      '--- a/src/a.py',
      '+++ b/src/a.py',
      '@@ -1 +1 @@',
      '-1',
      '+2',
    ].join('\n');
    expect(patch.endsWith('\n')).toBe(false);
    const out = stripTestPathHunks(patch);
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('src/a.py');
  });

  it('preserves a single trailing newline (does not double-add)', () => {
    const patch = [
      'diff --git a/src/a.py b/src/a.py',
      '--- a/src/a.py',
      '+++ b/src/a.py',
      '@@ -1 +1 @@',
      '-1',
      '+2',
      '',
    ].join('\n');
    const out = stripTestPathHunks(patch);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('gitApplyParseCheck', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'restoration-patch-test-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@e.x'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.py'), 'old = True\nkeep = 1\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
    return dir;
  }

  it('accepts a well-formed diff', async () => {
    const dir = makeRepo();
    const patch = [
      'diff --git a/src/a.py b/src/a.py',
      '--- a/src/a.py',
      '+++ b/src/a.py',
      '@@ -1,2 +1,2 @@',
      '-old = True',
      '+old = False',
      ' keep = 1',
      '',
    ].join('\n');
    expect(await gitApplyParseCheck(dir, patch)).toEqual({ ok: true });
  });

  it('rejects a malformed diff (context line missing its leading space)', async () => {
    const dir = makeRepo();
    const patch = [
      'diff --git a/src/a.py b/src/a.py',
      '--- a/src/a.py',
      '+++ b/src/a.py',
      '@@ -1,2 +1,2 @@',
      '-old = True',
      '+old = False',
      'keep = 1', // <-- should be ' keep = 1' — corruption
      '',
    ].join('\n');
    const r = await gitApplyParseCheck(dir, patch);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty patch', async () => {
    const dir = makeRepo();
    expect((await gitApplyParseCheck(dir, '   ')).ok).toBe(false);
  });
});
