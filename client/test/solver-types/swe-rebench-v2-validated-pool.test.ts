import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ValidatedPoolStore,
  filterToScorablePool,
  validatePoolInstances,
  EVAL_SEMANTICS_VERSION,
} from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { computeRowHash } from '../../src/solver-types/_swe-rebench-v2-substrate.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'swe-validated-pool-test-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function poolTask(id: string, overrides: Partial<PoolTask> = {}): PoolTask {
  return {
    instance_id: id,
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: '2026_02',
    repo: 'acme/widget',
    base_commit: 'deadbeef',
    language: 'python',
    patch: 'diff --git a/src/x.py b/src/x.py\n--- a/src/x.py\n+++ b/src/x.py\n@@ -1 +1 @@\n-a\n+b\n',
    test_patch: 'diff --git a/tests/test_x.py b/tests/test_x.py\n--- a/tests/test_x.py\n+++ b/tests/test_x.py\n@@ -1 +1 @@\n-c\n+d\n',
    ...overrides,
  };
}

describe('ValidatedPoolStore', () => {
  it('records entries and round-trips them via getEntry / getScorableIds', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('a__1', { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-13T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    await store.record('a__2', { scorable: false, reason: 'ungradeable:docker_unavailable', checkedAt: '2026-05-13T00:00:01Z' }, EVAL_SEMANTICS_VERSION);
    expect((await store.getEntry('a__1', EVAL_SEMANTICS_VERSION))?.scorable).toBe(true);
    expect((await store.getEntry('a__2', EVAL_SEMANTICS_VERSION))?.scorable).toBe(false);
    expect(await store.getEntry('a__3', EVAL_SEMANTICS_VERSION)).toBeNull();
    const scorable = await store.getScorableIds(EVAL_SEMANTICS_VERSION);
    expect(scorable).toEqual(new Set(['a__1']));
    expect(existsSync(join(dir, 'validated-pool.json'))).toBe(true);
  });

  it('getScorableIds returns null when the file is absent or built for a different semantics version', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    expect(await store.getScorableIds(EVAL_SEMANTICS_VERSION)).toBeNull();
    await store.record('a__1', { scorable: true, reason: 'ok', checkedAt: '2026-05-13T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    expect(await store.getScorableIds(EVAL_SEMANTICS_VERSION)).toEqual(new Set(['a__1']));
    // Same file, different semantics version → treated as no data.
    expect(await store.getScorableIds('999')).toBeNull();
  });

  it('treats entries from a stale semantics version as not-yet-validated (re-validatable)', async () => {
    const dir = tmpDir();
    // Hand-write a file built for an old semantics version.
    writeFileSync(join(dir, 'validated-pool.json'), JSON.stringify({
      schemaVersion: 'swe-rebench-v2-validated-pool.v1',
      evalSemanticsVersion: 'OLD',
      updatedAt: '2026-01-01T00:00:00Z',
      entries: { a__1: { scorable: true, reason: 'ok', checkedAt: '2026-01-01T00:00:00Z' } },
    }));
    const store = new ValidatedPoolStore({ stateDir: dir });
    expect(await store.getEntry('a__1', EVAL_SEMANTICS_VERSION)).toBeNull();
    expect(await store.getScorableIds(EVAL_SEMANTICS_VERSION)).toBeNull();
  });
});

describe('filterToScorablePool', () => {
  const pool: PoolTask[] = [
    poolTask('a__1'),
    poolTask('a__2'),
    poolTask('go__1', { language: 'go' }),
    poolTask('rust__1', { language: 'rust' }),
  ];

  it('restricts to validated-scorable instances when validation data is present', () => {
    const { pool: out, mode } = filterToScorablePool(pool, new Set(['a__1', 'go__1']));
    expect(mode).toBe('validated');
    expect(out.map((t) => t.instance_id)).toEqual(['a__1', 'go__1']);
  });

  it('falls back to Python-only instances when no validation data exists (python-floor mode)', () => {
    const { pool: out, mode } = filterToScorablePool(pool, null, 'python-floor');
    expect(mode).toBe('python-floor');
    expect(out.map((t) => t.instance_id)).toEqual(['a__1', 'a__2']);
  });

  it('returns empty pool when no validation data exists in required mode (default)', () => {
    const { pool: out, mode } = filterToScorablePool(pool, null);
    expect(mode).toBe('admission-required-no-data');
    expect(out).toHaveLength(0);
  });

  it('infers Python from .py paths in the patch when the language field is unset (as the leaderboard rows are)', () => {
    const inferred: PoolTask[] = [
      poolTask('a__inferred_py', { language: undefined, patch: 'diff --git a/src/foo.py b/src/foo.py\n--- a/src/foo.py\n+++ b/src/foo.py\n@@ -1 +1 @@\n-a\n+b\n' }),
      poolTask('a__inferred_go', { language: undefined, patch: 'diff --git a/x.go b/x.go\n--- a/x.go\n+++ b/x.go\n@@ -1 +1 @@\n-a\n+b\n', test_patch: undefined }),
    ];
    const { pool: out } = filterToScorablePool(inferred, null, 'python-floor');
    expect(out.map((t) => t.instance_id)).toEqual(['a__inferred_py']);
  });
});

describe('validatePoolInstances', () => {
  function makeRunner(byId: Record<string, { passed_match: boolean; passed?: string[]; failed?: string[] } | Error>) {
    return {
      runEval: vi.fn(async (args: { instance_id: string }) => {
        const v = byId[args.instance_id];
        if (v instanceof Error) throw v;
        if (!v) throw new Error(`no stub for ${args.instance_id}`);
        return { passed_match: v.passed_match, passed: v.passed ?? [], failed: v.failed ?? [], log: '', exitCode: v.passed_match ? 0 : 1 };
      }),
    };
  }
  function makeFetcher() {
    return {
      fetchTaskRow: vi.fn(async (a: { instance_id: string }) => ({
        instance_id: a.instance_id, repo: 'acme/widget',
        image_name: `swerebench/sweb.eval.x86_64.acme_1776_${a.instance_id}:latest`,
        FAIL_TO_PASS: ['tests/test_x.py::test_new'], PASS_TO_PASS: ['tests/test_x.py::test_old'],
        test_patch: 'diff --git a/tests/test_x.py b/tests/test_x.py\n',
        install_config: { install: 'pip install -e .', test_cmd: 'pytest tests/', log_parser: 'parse_log_pytest' },
      })),
    };
  }

  it('marks an instance scorable when the gold patch resolves, unscorable otherwise', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const runner = makeRunner({
      a__pass: { passed_match: true, passed: ['tests/test_x.py::test_new'] },
      a__fail: { passed_match: false, passed: [], failed: [] },
      a__ungradeable: Object.assign(new Error('eval could not grade'), { name: 'EvalCouldNotGradeError', reason: 'docker_unavailable' }),
    });
    // commandRunner: docker returns a valid digest so substrate fields resolve;
    // git returns exitCode 1 so upstreamEvalCommit is omitted (non-fatal).
    const commandRunner = async (bin: string, args: string[]) => {
      if (bin === 'docker' && args[0] === 'image') {
        return { exitCode: 0, stdout: '["acme/widget@sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    const summary = await validatePoolInstances(
      [poolTask('a__pass'), poolTask('a__fail'), poolTask('a__ungradeable')],
      { fetcher: makeFetcher(), runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary).toMatchObject({ checked: 3, scorable: 1, unscorable: 2, skipped: 0 });
    expect((await store.getEntry('a__pass', EVAL_SEMANTICS_VERSION))?.scorable).toBe(true);
    expect((await store.getEntry('a__fail', EVAL_SEMANTICS_VERSION))?.scorable).toBe(false);
    const ung = await store.getEntry('a__ungradeable', EVAL_SEMANTICS_VERSION);
    expect(ung?.scorable).toBe(false);
    expect(ung?.reason).toMatch(/docker_unavailable/);
  });

  it('skips non-Python instances (records them unscorable, never invokes the runner)', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const runner = makeRunner({});
    // Non-Python instance exits before substrate resolution. upstreamRepoDir is
    // required but resolveUpstreamEvalCommit runs before the loop; use a stub
    // commandRunner so the test doesn't spawn real git.
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });
    const summary = await validatePoolInstances(
      [poolTask('go__1', { language: 'go' })],
      { fetcher: makeFetcher(), runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary).toMatchObject({ checked: 0, skipped: 1 });
    expect(runner.runEval).not.toHaveBeenCalled();
    expect((await store.getEntry('go__1', EVAL_SEMANTICS_VERSION))?.scorable).toBe(false);
  });

  it('skips already-validated instances unless force is set', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('a__1', { scorable: true, reason: 'ok', checkedAt: '2026-05-13T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    const runner = makeRunner({ a__1: { passed_match: false } });
    // Minimal stub: git returns null commit (non-fatal), docker returns exitCode 1
    // so imageDigest is unresolvable → entry is scorable:false regardless.
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });
    const s1 = await validatePoolInstances([poolTask('a__1')], { fetcher: makeFetcher(), runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner });
    expect(s1.checked).toBe(0);
    expect(runner.runEval).not.toHaveBeenCalled();
    const s2 = await validatePoolInstances([poolTask('a__1')], { fetcher: makeFetcher(), runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner }, { force: true });
    expect(s2.checked).toBe(1);
    expect(runner.runEval).toHaveBeenCalledTimes(1);
    expect((await store.getEntry('a__1', EVAL_SEMANTICS_VERSION))?.scorable).toBe(false);
  });

  it('honors the limit on how many instances it validates in one run', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const runner = makeRunner({ a__1: { passed_match: true }, a__2: { passed_match: true }, a__3: { passed_match: true } });
    // Minimal stub: digest fails → unresolvable-image-digest (scorable:false) but
    // checked still increments correctly — the limit assertion is unaffected.
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });
    const summary = await validatePoolInstances(
      [poolTask('a__1'), poolTask('a__2'), poolTask('a__3')],
      { fetcher: makeFetcher(), runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
      { limit: 2 },
    );
    expect(summary.checked).toBe(2);
    expect(runner.runEval).toHaveBeenCalledTimes(2);
  });
});

describe('ValidatedPoolStore — extended substrate fields (semantics v3)', () => {
  it('persists rowHash, imageName, imageDigest, upstreamEvalCommit alongside scorable/reason/checkedAt', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record(
      'a__1',
      {
        scorable: true,
        reason: 'gold-patch-resolves',
        checkedAt: '2026-05-14T00:00:00Z',
        rowHash: 'sha256:abc123',
        imageName: 'swerebenchv2/sweb.eval.x86_64.a__1:latest',
        imageDigest: 'sha256:def456',
        upstreamEvalCommit: '0123456789abcdef',
      },
      EVAL_SEMANTICS_VERSION,
    );
    const entry = await store.getEntry('a__1', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: true,
      rowHash: 'sha256:abc123',
      imageName: 'swerebenchv2/sweb.eval.x86_64.a__1:latest',
      imageDigest: 'sha256:def456',
      upstreamEvalCommit: '0123456789abcdef',
    });
  });

  it('round-trips an entry that omits the optional substrate fields, returning them as undefined', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record(
      'a__nosubstrate',
      {
        scorable: true,
        reason: 'gold-patch-resolves',
        checkedAt: '2026-05-14T00:00:00Z',
      },
      EVAL_SEMANTICS_VERSION,
    );
    const entry = await store.getEntry('a__nosubstrate', EVAL_SEMANTICS_VERSION);
    expect(entry).not.toBeNull();
    expect(entry!.scorable).toBe(true);
    expect(entry!.rowHash).toBeUndefined();
    expect(entry!.imageName).toBeUndefined();
    expect(entry!.imageDigest).toBeUndefined();
    expect(entry!.upstreamEvalCommit).toBeUndefined();
  });

  it('is "3" — bump this when grading semantics change, and update the JSDoc history block above', () => {
    expect(EVAL_SEMANTICS_VERSION).toBe('3');
  });
});

describe('ValidatedPoolStore — concurrent record() does not lose entries', () => {
  it('two concurrent record() calls for different instance ids leave both in the file', async () => {
    const dir = tmpDir();
    const storeA = new ValidatedPoolStore({ stateDir: dir });
    const storeB = new ValidatedPoolStore({ stateDir: dir });
    // Both stores load (empty), then both record concurrently.
    await Promise.all([
      storeA.record('a__1', { scorable: true, reason: 'ok', checkedAt: '2026-05-14T00:00:00Z' }, EVAL_SEMANTICS_VERSION),
      storeB.record('a__2', { scorable: true, reason: 'ok', checkedAt: '2026-05-14T00:00:01Z' }, EVAL_SEMANTICS_VERSION),
    ]);
    // A fresh store sees both entries on disk.
    const storeC = new ValidatedPoolStore({ stateDir: dir });
    expect(await storeC.getEntry('a__1', EVAL_SEMANTICS_VERSION)).not.toBeNull();
    expect(await storeC.getEntry('a__2', EVAL_SEMANTICS_VERSION)).not.toBeNull();
  });
});

describe('validatePoolInstances — base_commit sentinel alignment', () => {
  it('uses the 40-hex sentinel when PoolTask.base_commit is undefined', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await validatePoolInstances(
      [poolTask('a__nobase', { base_commit: undefined })],
      {
        fetcher: {
          fetchTaskRow: async () => ({
            instance_id: 'a__nobase', repo: 'r', image_name: 'img:latest',
            FAIL_TO_PASS: ['t::a'], PASS_TO_PASS: ['t::b'], test_patch: 'tp',
            install_config: { install: ['x'], test_cmd: ['y'], log_parser: 'parse_log_pytest' },
          }),
        },
        runner: { runEval: async () => ({ passed_match: true, passed: ['t::a'], failed: [], log: '', exitCode: 0 }) },
        store,
        semanticsVersion: EVAL_SEMANTICS_VERSION,
        upstreamRepoDir: '/fake',
        commandRunner: async (bin, args) => {
          if (bin === 'docker') return { exitCode: 0, stdout: '["img@sha256:' + 'a'.repeat(64) + '"]', stderr: '' };
          if (bin === 'git') return { exitCode: 0, stdout: '0'.repeat(40) + '\n', stderr: '' };
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      },
    );
    const entry = await store.getEntry('a__nobase', EVAL_SEMANTICS_VERSION);
    // The entry must have been persisted.
    expect(entry?.rowHash).toBeDefined();
    // Recomputing with the sentinel must reproduce the stored hash.
    // If the fallback had used '' instead, this would produce a different hash.
    // repo: validatePoolInstances uses task.repo ?? row.repo; poolTask defaults to 'acme/widget'.
    const expected = computeRowHash({
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      instance_id: 'a__nobase',
      repo: 'acme/widget',
      base_commit: '0000000000000000000000000000000000000000',
      image_name: 'img:latest',
      patch: poolTask('a__nobase').patch!,
      test_patch: 'tp',
      install_config: { install: ['x'], test_cmd: ['y'], log_parser: 'parse_log_pytest' },
      FAIL_TO_PASS: ['t::a'],
      PASS_TO_PASS: ['t::b'],
    });
    expect(entry?.rowHash).toBe(expected);
  });
});

describe('validatePoolInstances — populates substrate fields', () => {
  it('records rowHash, imageName, imageDigest, upstreamEvalCommit on a successful validation', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const summary = await validatePoolInstances(
      [poolTask('a__1')],
      {
        fetcher: {
          fetchTaskRow: async () => ({
            instance_id: 'a__1',
            repo: 'acme/widget',
            image_name: 'acme/widget:latest',
            FAIL_TO_PASS: ['t::a'],
            PASS_TO_PASS: ['t::b'],
            test_patch: 'diff b',
            install_config: { install: ['pip install .'], test_cmd: ['pytest'], log_parser: 'parse_log_pytest' },
          }),
        },
        runner: {
          runEval: async () => ({ passed_match: true, passed: ['t::a'], failed: [], log: '', exitCode: 0 }),
        },
        store,
        semanticsVersion: EVAL_SEMANTICS_VERSION,
        upstreamRepoDir: '/fake/upstream',
        commandRunner: async (bin, args) => {
          if (bin === 'docker' && args[0] === 'image') {
            return { exitCode: 0, stdout: '["acme/widget@sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]', stderr: '' };
          }
          if (bin === 'git' && args[0] === 'rev-parse') {
            return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: 'unexpected' };
        },
      },
    );
    expect(summary.scorable).toBe(1);
    const entry = await store.getEntry('a__1', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: true,
      imageName: 'acme/widget:latest',
      imageDigest: 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      upstreamEvalCommit: '0123456789abcdef0123456789abcdef01234567',
    });
    expect(entry!.rowHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('records the entry as unscorable when imageDigest cannot be resolved (required mode)', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await validatePoolInstances(
      [poolTask('a__1')],
      {
        fetcher: {
          fetchTaskRow: async () => ({
            instance_id: 'a__1', repo: 'acme/widget', image_name: 'acme/widget:latest',
            FAIL_TO_PASS: ['t::a'], PASS_TO_PASS: ['t::b'], test_patch: 'diff b',
            install_config: { install: ['pip install .'], test_cmd: ['pytest'], log_parser: 'parse_log_pytest' },
          }),
        },
        runner: { runEval: async () => ({ passed_match: true, passed: ['t::a'], failed: [], log: '', exitCode: 0 }) },
        store,
        semanticsVersion: EVAL_SEMANTICS_VERSION,
        upstreamRepoDir: '/fake/upstream',
        commandRunner: async (bin, args) => {
          if (bin === 'docker') return { exitCode: 1, stdout: '', stderr: 'no such image' };
          if (bin === 'git') return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      },
    );
    const entry = await store.getEntry('a__1', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({ scorable: false, reason: 'unresolvable-image-digest' });
    expect(entry!.rowHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry!.imageName).toBe('acme/widget:latest');
    expect(entry!.upstreamEvalCommit).toBe('0123456789abcdef0123456789abcdef01234567');
  });
});
