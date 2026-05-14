import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PythonEvalRunner,
  EvalCouldNotGradeError,
  DEFAULT_EVAL_IMAGE_CACHE_MAX,
  resolveImageCacheMax,
  matchInfraSignature,
} from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';

const tempDirs: string[] = [];

/**
 * Build a fake upstream `scripts.eval` repo. The fake `eval.py` writes a report
 * item shaped like the *real* upstream output:
 *   success     : { instance_id, from_fail_to_pass[], failed_from_pass_to_pass[],
 *                   passed_match, exit_code, log_path, error: "" }
 *   setup error : { instance_id, from_fail_to_pass: [], failed_from_pass_to_pass:
 *                   [...PASS_TO_PASS...], error: "<message>" }   (no exit_code etc.)
 *
 * `reportItem` overrides fields on the success shape; passing `{ error: "..." }`
 * switches to the setup-error shape.
 */
function makeUpstreamFixture(opts: {
  reportItem?: Record<string, unknown>;
  logBody?: string;
} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'swe-rebench-eval-runner-test-'));
  tempDirs.push(dir);
  const scriptsDir = join(dir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, '__init__.py'), '');
  const itemOverride = JSON.stringify(opts.reportItem ?? {});
  const logBody = opts.logBody ?? 'test session starts\ntest_a PASSED\ntest_b PASSED\n2 passed';
  writeFileSync(join(scriptsDir, 'eval.py'), `
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--json", required=True)
parser.add_argument("--patches", required=True)
parser.add_argument("--max-workers")
parser.add_argument("--report-json", required=True)
args = parser.parse_args()

tasks = json.loads(Path(args.json).read_text())
Path("observed-task.json").write_text(json.dumps(tasks[0]))
Path("observed-patches.json").write_text(Path(args.patches).read_text())
Path("observed-env.txt").write_text(os.environ.get("DOCKER_DEFAULT_PLATFORM", ""))
Path("observed-log.txt").write_text(${JSON.stringify(logBody)})

override = json.loads(${JSON.stringify(itemOverride)})
if isinstance(override.get("error"), str) and override.get("error"):
  item = {
    "instance_id": tasks[0]["instance_id"],
    "from_fail_to_pass": [],
    "failed_from_pass_to_pass": list(tasks[0].get("PASS_TO_PASS", [])),
    "error": override["error"],
  }
else:
  item = {
    "instance_id": tasks[0]["instance_id"],
    "from_fail_to_pass": list(tasks[0].get("FAIL_TO_PASS", [])),
    "failed_from_pass_to_pass": [],
    "passed_match": True,
    "exit_code": 0,
    "log_path": str(Path("observed-log.txt").resolve()),
    "error": "",
  }
  item.update(override)
  item["instance_id"] = tasks[0]["instance_id"]

Path(args.report_json).write_text(json.dumps({"total": 1, "items": [item]}))
`);
  chmodSync(join(scriptsDir, 'eval.py'), 0o755);
  return dir;
}

const REQUEST = {
  instance_id: 'astronomer__astronomer-cosmos-2332',
  repo: 'astronomer/astronomer-cosmos',
  image: 'swerebench/sweb.eval.x86_64.astronomer_1776_astronomer-cosmos-2332:latest',
  patch: 'diff --git a/a b/a\n',
  test_patch: 'diff --git a/t b/t\n',
  install: 'pip install -e .',
  test_cmd: 'pytest tests/dbt/test_graph.py',
  log_parser: 'parse_log_pytest',
  fail_to_pass: ['test_a'],
  pass_to_pass: ['test_b'],
} as const;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('PythonEvalRunner', () => {
  it('passes the real instance id and uses the SWE-rebench /testbed container workdir slug', async () => {
    const upstreamRepoDir = makeUpstreamFixture();
    const runner = new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 });
    const result = await runner.runEval(REQUEST);

    const observedTask = JSON.parse(readFileSync(join(upstreamRepoDir, 'observed-task.json'), 'utf8'));
    expect(observedTask.instance_id).toBe('astronomer__astronomer-cosmos-2332');
    expect(observedTask.repo).toBe('jinn/testbed');
    expect(result.passed_match).toBe(true);
    expect(result.passed).toEqual(['test_a']);
  });

  it('overrides test_cmd to run exactly the FAIL_TO_PASS ∪ PASS_TO_PASS node ids for pytest instances', async () => {
    const upstreamRepoDir = makeUpstreamFixture();
    await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval({
      ...REQUEST,
      fail_to_pass: ['tests/a.py::test_x'],
      pass_to_pass: ['tests/a.py::test_y', 'tests/a.py::test_z[0]'],
    });
    const observedTask = JSON.parse(readFileSync(join(upstreamRepoDir, 'observed-task.json'), 'utf8'));
    expect(observedTask.install_config.test_cmd).toEqual([
      'pip install -e .',
      `python -m pytest --no-header -rA --tb=no -p no:cacheprovider 'tests/a.py::test_x' 'tests/a.py::test_y' 'tests/a.py::test_z[0]'`,
    ]);
    // The dataset's broad/`-v` test command is not used.
    expect(observedTask.install_config.test_cmd.join('\n')).not.toContain('tests/dbt/test_graph.py');
  });

  it('falls back to the dataset test_cmd verbatim for non-pytest log parsers', async () => {
    const upstreamRepoDir = makeUpstreamFixture();
    await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval({
      ...REQUEST,
      log_parser: 'parse_log_go',
      test_cmd: 'go test ./...',
    });
    const observedTask = JSON.parse(readFileSync(join(upstreamRepoDir, 'observed-task.json'), 'utf8'));
    expect(observedTask.install_config.test_cmd).toEqual(['pip install -e .', 'go test ./...']);
  });

  it('pins the docker platform to linux/amd64 for the eval subprocess', async () => {
    const upstreamRepoDir = makeUpstreamFixture();
    await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval(REQUEST);
    expect(readFileSync(join(upstreamRepoDir, 'observed-env.txt'), 'utf8')).toBe('linux/amd64');
  });

  it('resolves a relative report log_path against the upstream repo dir', async () => {
    const upstreamRepoDir = makeUpstreamFixture({
      reportItem: { log_path: 'observed-log.txt' },
      logBody: 'PYTEST OUTPUT HERE',
    });
    const result = await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval(REQUEST);
    expect(result.log).toContain('PYTEST OUTPUT HERE');
  });

  it('re-derives a PASS verdict (SWE-bench resolved semantics) even when upstream passed_match is false', async () => {
    // FAIL_TO_PASS passed, no PASS_TO_PASS broke — the fix is good. Upstream's
    // `passed_match` is false only because the run also passed many other
    // (unlisted) tests; we re-derive the correct verdict.
    const upstreamRepoDir = makeUpstreamFixture({
      reportItem: {
        from_fail_to_pass: ['test_a'],
        failed_from_pass_to_pass: [],
        passed_match: false,            // upstream's exact-set comparison
        exit_code: 1,                   // pytest exits non-zero — unlisted tests failed
      },
      logBody: 'test session starts\ntest_a PASSED\ntest_b PASSED\nunrelated_x FAILED\n1 failed, 1729 passed',
    });
    const result = await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval(REQUEST);
    expect(result.passed_match).toBe(true);
  });

  it('returns passed_match=false (a genuine wrong-answer) when the FAIL_TO_PASS test still fails — not an infra abort', async () => {
    const upstreamRepoDir = makeUpstreamFixture({
      reportItem: {
        from_fail_to_pass: [],          // FAIL_TO_PASS did not pass
        failed_from_pass_to_pass: [],   // PASS_TO_PASS still pass
        passed_match: false,
        exit_code: 1,
      },
      logBody: 'test session starts\ntest_a FAILED\ntest_b PASSED\n1 failed, 1 passed',
    });
    const result = await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval(REQUEST);
    expect(result.passed_match).toBe(false);
    expect(result.passed).toEqual([]);
  });

  it('throws EvalCouldNotGradeError when Docker is unreachable (no test passed, non-zero exit, infra signature)', async () => {
    const upstreamRepoDir = makeUpstreamFixture({
      reportItem: {
        from_fail_to_pass: [],
        failed_from_pass_to_pass: ['test_b'], // every PASS_TO_PASS "broke" → nothing ran
        passed_match: false,
        exit_code: 125,
      },
      logBody: 'docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    });
    const err = await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalCouldNotGradeError);
    expect((err as EvalCouldNotGradeError).reason).toBe('docker_unavailable');
  });

  it('throws EvalCouldNotGradeError when the model patch failed to apply (git apply aborted before tests)', async () => {
    const upstreamRepoDir = makeUpstreamFixture({
      reportItem: {
        from_fail_to_pass: [],
        failed_from_pass_to_pass: ['test_b'],
        passed_match: false,
        exit_code: 1,
      },
      logBody: 'Checking patch src/foo.py...\nerror: corrupt patch at line 30',
    });
    const err = await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalCouldNotGradeError);
    expect((err as EvalCouldNotGradeError).reason).toBe('patch_corrupt');
  });

  it('throws EvalCouldNotGradeError on the upstream setup-error report shape (e.g. missing image_name)', async () => {
    const upstreamRepoDir = makeUpstreamFixture({
      reportItem: { error: 'Task astronomer__astronomer-cosmos-2332 missing top-level image_name.' },
    });
    const err = await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalCouldNotGradeError);
    expect((err as EvalCouldNotGradeError).reason).toBe('eval_setup_error');
  });

  it('throws EvalCouldNotGradeError when the report file is missing/unparseable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-rebench-eval-runner-test-'));
    tempDirs.push(dir);
    const scriptsDir = join(dir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, '__init__.py'), '');
    writeFileSync(join(scriptsDir, 'eval.py'), 'import sys\nsys.exit(2)\n');
    chmodSync(join(scriptsDir, 'eval.py'), 0o755);
    await expect(new PythonEvalRunner({ upstreamRepoDir: dir, maxWorkers: 1 }).runEval(REQUEST))
      .rejects.toBeInstanceOf(EvalCouldNotGradeError);
  });

  // jinn-mono-uy6v.11 — bound the per-instance Docker image cache so a
  // long-running operator daemon does not accumulate ~3 GB/image until the
  // disk fills. The runner keeps an in-process LRU of image names; when more
  // than `imageCacheMax` distinct images have been used, the least-recently
  // used ones are removed via the injected `cleanupImage` hook (which
  // defaults to `docker rmi <image>` in production).
  describe('LRU image cache GC (jinn-mono-uy6v.11)', () => {
    it('does NOT remove any image while distinct usages ≤ cap (keeps repeat-evals fast)', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const removed: string[] = [];
      const runner = new PythonEvalRunner({
        upstreamRepoDir,
        maxWorkers: 1,
        imageCacheMax: 3,
        cleanupImage: async (image) => { removed.push(image); },
      });
      await runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-1:latest' });
      await runner.runEval({ ...REQUEST, instance_id: 'i2', image: 'img-2:latest' });
      await runner.runEval({ ...REQUEST, instance_id: 'i3', image: 'img-3:latest' });
      // Cache is full but not over capacity — nothing should be GC'd yet.
      expect(removed).toEqual([]);
    });

    it('evicts the least-recently-used image once usage exceeds the cap', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const removed: string[] = [];
      const runner = new PythonEvalRunner({
        upstreamRepoDir,
        maxWorkers: 1,
        imageCacheMax: 2,
        cleanupImage: async (image) => { removed.push(image); },
      });
      await runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-1:latest' });
      await runner.runEval({ ...REQUEST, instance_id: 'i2', image: 'img-2:latest' });
      // Third distinct image — must evict the oldest (img-1).
      await runner.runEval({ ...REQUEST, instance_id: 'i3', image: 'img-3:latest' });
      expect(removed).toEqual(['img-1:latest']);
      // Fourth — must evict the now-oldest (img-2).
      await runner.runEval({ ...REQUEST, instance_id: 'i4', image: 'img-4:latest' });
      expect(removed).toEqual(['img-1:latest', 'img-2:latest']);
    });

    it('refreshes LRU order on repeat-eval — re-using an image protects it from eviction', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const removed: string[] = [];
      const runner = new PythonEvalRunner({
        upstreamRepoDir,
        maxWorkers: 1,
        imageCacheMax: 2,
        cleanupImage: async (image) => { removed.push(image); },
      });
      await runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-1:latest' });
      await runner.runEval({ ...REQUEST, instance_id: 'i2', image: 'img-2:latest' });
      // Re-use img-1 — now img-2 is the oldest.
      await runner.runEval({ ...REQUEST, instance_id: 'i1-repeat', image: 'img-1:latest' });
      expect(removed).toEqual([]);
      // A new distinct image evicts img-2, not img-1.
      await runner.runEval({ ...REQUEST, instance_id: 'i3', image: 'img-3:latest' });
      expect(removed).toEqual(['img-2:latest']);
    });

    it('records the image in the LRU even when the eval throws EvalCouldNotGradeError', async () => {
      // Cap of 1 — every new distinct image evicts the previous one. This
      // proves cleanup runs in the failure path too (acceptance: cleanup must
      // not be conditional on the success path).
      const failingFixture = makeUpstreamFixture({
        reportItem: { error: 'Task missing top-level image_name.' },
      });
      const removed: string[] = [];
      const runner = new PythonEvalRunner({
        upstreamRepoDir: failingFixture,
        maxWorkers: 1,
        imageCacheMax: 1,
        cleanupImage: async (image) => { removed.push(image); },
      });
      await expect(runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-1:latest' }))
        .rejects.toBeInstanceOf(EvalCouldNotGradeError);
      // A second distinct image — even after a failure — must evict the first.
      await expect(runner.runEval({ ...REQUEST, instance_id: 'i2', image: 'img-2:latest' }))
        .rejects.toBeInstanceOf(EvalCouldNotGradeError);
      expect(removed).toEqual(['img-1:latest']);
    });

    it('also records the image in the LRU when the report is missing/unparseable (no-report failure path)', async () => {
      // eval.py exits non-zero with no report file — runEval throws
      // EvalCouldNotGradeError('eval_no_report'). The image must still be
      // tracked for GC, otherwise pull-and-crash failures leak the cache.
      const dir = mkdtempSync(join(tmpdir(), 'swe-rebench-eval-runner-test-'));
      tempDirs.push(dir);
      const scriptsDir = join(dir, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(join(scriptsDir, '__init__.py'), '');
      writeFileSync(join(scriptsDir, 'eval.py'), 'import sys\nsys.exit(2)\n');
      chmodSync(join(scriptsDir, 'eval.py'), 0o755);

      const removed: string[] = [];
      const runner = new PythonEvalRunner({
        upstreamRepoDir: dir,
        maxWorkers: 1,
        imageCacheMax: 1,
        cleanupImage: async (image) => { removed.push(image); },
      });
      await expect(runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-1:latest' }))
        .rejects.toBeInstanceOf(EvalCouldNotGradeError);
      await expect(runner.runEval({ ...REQUEST, instance_id: 'i2', image: 'img-2:latest' }))
        .rejects.toBeInstanceOf(EvalCouldNotGradeError);
      expect(removed).toEqual(['img-1:latest']);
    });

    it('swallows cleanupImage errors so a failing docker rmi never escapes runEval', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const runner = new PythonEvalRunner({
        upstreamRepoDir,
        maxWorkers: 1,
        imageCacheMax: 1,
        cleanupImage: async () => { throw new Error('rmi blew up'); },
      });
      await runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-1:latest' });
      // The second call would trigger cleanupImage(img-1). It must complete
      // normally and return the graded result.
      const result = await runner.runEval({ ...REQUEST, instance_id: 'i2', image: 'img-2:latest' });
      expect(result.passed_match).toBe(true);
    });

    it('reads the default cap from JINN_EVAL_IMAGE_CACHE_MAX when neither imageCacheMax nor cleanupImage is configured', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const prev = process.env['JINN_EVAL_IMAGE_CACHE_MAX'];
      const prevPath = process.env['PATH'];
      // Stub `docker` on PATH with a script that records the rmi target and
      // returns 0. Cap=1 → second distinct image triggers rmi of the first.
      const stubDir = mkdtempSync(join(tmpdir(), 'swe-rebench-docker-stub-'));
      tempDirs.push(stubDir);
      const logPath = join(stubDir, 'rmi.log');
      writeFileSync(join(stubDir, 'docker'), `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(logPath)}\nexit 0\n`);
      chmodSync(join(stubDir, 'docker'), 0o755);

      process.env['JINN_EVAL_IMAGE_CACHE_MAX'] = '1';
      process.env['PATH'] = `${stubDir}:${prevPath}`;
      try {
        const runner = new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 });
        await runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-1:latest' });
        await runner.runEval({ ...REQUEST, instance_id: 'i2', image: 'img-2:latest' });
      } finally {
        if (prev === undefined) delete process.env['JINN_EVAL_IMAGE_CACHE_MAX'];
        else process.env['JINN_EVAL_IMAGE_CACHE_MAX'] = prev;
        if (prevPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = prevPath;
      }
      const log = readFileSync(logPath, 'utf8');
      expect(log).toContain('rmi');
      expect(log).toContain('img-1:latest');
      expect(log).not.toContain('img-2:latest');
    });

    it('falls back to DEFAULT_EVAL_IMAGE_CACHE_MAX when the env var is invalid (0 / negative / non-numeric / empty)', () => {
      const prev = process.env['JINN_EVAL_IMAGE_CACHE_MAX'];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const invalidInputs = ['0', '-5', 'garbage', '', '  ', '1e3oops'];
        for (const garbage of invalidInputs) {
          warn.mockClear();
          process.env['JINN_EVAL_IMAGE_CACHE_MAX'] = garbage;
          expect(resolveImageCacheMax(undefined)).toBe(DEFAULT_EVAL_IMAGE_CACHE_MAX);
          // Operators who mistype the env var get a loud signal — silent
          // fallback was the original review finding here. The literal value
          // is interpolated so trailing whitespace / empty-string typos are
          // unambiguous in the log.
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining(`JINN_EVAL_IMAGE_CACHE_MAX=${JSON.stringify(garbage)}`),
          );
        }
        // Sanity: a valid positive integer is honored and does NOT warn.
        warn.mockClear();
        process.env['JINN_EVAL_IMAGE_CACHE_MAX'] = '7';
        expect(resolveImageCacheMax(undefined)).toBe(7);
        expect(warn).not.toHaveBeenCalled();
        // Explicit option always wins over env (positive option short-circuits).
        process.env['JINN_EVAL_IMAGE_CACHE_MAX'] = '999';
        expect(resolveImageCacheMax(3)).toBe(3);
        // Invalid explicit option falls through to the env.
        expect(resolveImageCacheMax(0)).toBe(999);
        expect(resolveImageCacheMax(-1)).toBe(999);
      } finally {
        if (prev === undefined) delete process.env['JINN_EVAL_IMAGE_CACHE_MAX'];
        else process.env['JINN_EVAL_IMAGE_CACHE_MAX'] = prev;
        warn.mockRestore();
      }
    });

    it('warns when the production docker rmi cleanup exits non-zero so a flaky daemon is visible (jinn-mono-uy6v.11)', async () => {
      // Stub `docker` on PATH with a script that exits non-zero — simulating
      // "image is in use by container", "permission denied", or a daemon
      // restart. Pre-fix, `defaultCleanupImage` swallowed errors silently, so
      // operators had zero visibility into a persistently-failing `docker rmi`
      // until the disk filled.
      const upstreamRepoDir = makeUpstreamFixture();
      const prevPath = process.env['PATH'];
      const prevCacheMax = process.env['JINN_EVAL_IMAGE_CACHE_MAX'];
      const stubDir = mkdtempSync(join(tmpdir(), 'swe-rebench-docker-rmi-fail-stub-'));
      tempDirs.push(stubDir);
      writeFileSync(join(stubDir, 'docker'), '#!/usr/bin/env bash\nexit 1\n');
      chmodSync(join(stubDir, 'docker'), 0o755);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env['PATH'] = `${stubDir}:${prevPath ?? ''}`;
      process.env['JINN_EVAL_IMAGE_CACHE_MAX'] = '1';
      let warnCalls: string[] = [];
      try {
        const runner = new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 });
        await runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-1:latest' });
        // Second distinct image → triggers cleanup of img-1 → docker stub exits 1.
        await runner.runEval({ ...REQUEST, instance_id: 'i2', image: 'img-2:latest' });
        warnCalls = warn.mock.calls.map((c) => String(c[0]));
      } finally {
        if (prevPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = prevPath;
        if (prevCacheMax === undefined) delete process.env['JINN_EVAL_IMAGE_CACHE_MAX'];
        else process.env['JINN_EVAL_IMAGE_CACHE_MAX'] = prevCacheMax;
        warn.mockRestore();
      }
      // Warn fired with the image tag + non-zero exit code. (Captured before
      // mockRestore so a captures-after-restore quirk can't be the failure.)
      const cleanupWarn = warnCalls.find((m) => m.includes('docker rmi img-1:latest'));
      expect(cleanupWarn).toBeTruthy();
      expect(cleanupWarn).toContain('exited 1');
    });
  });
});

// ---------------------------------------------------------------------------
// matchInfraSignature — 2026-05-14 triage fingerprints (jinn-mono-fufn)
// ---------------------------------------------------------------------------

// Real fingerprints from the 2026-05-14 triage on Base Sepolia.
const VENV_COLLISION = [
  'error: Failed to create virtual environment.',
  '  Caused by: A virtual environment already exists at /testbed/.venv',
  '  Use --clear to replace it',
].join('\n');

const MISSING_PYTEST =
  '/opt/conda/bin/python: No module named pytest';

const REQUESTS_DEP_WARNING =
  'requests.exceptions.RequestsDependencyWarning: urllib3 (2.2.2) or chardet (7.4.3)/charset_normalizer (3.3.2) doesn\'t match a supported version!';

const CONFTEST_IMPORT_ERROR =
  'ImportError while loading conftest \'/testbed/tests/conftest.py\'.';

describe('matchInfraSignature — 2026-05-14 triage fingerprints', () => {
  it('classifies venv-collision (jinn-mono-xw6i)', () => {
    expect(matchInfraSignature(VENV_COLLISION)).toBe('venv_collision');
  });
  it('classifies missing pytest in /opt/conda (jinn-mono-xw6i)', () => {
    expect(matchInfraSignature(MISSING_PYTEST)).toBe('pytest_missing');
  });
  it('classifies the urllib3/charset_normalizer dependency warning (jinn-mono-y4ah)', () => {
    expect(matchInfraSignature(REQUESTS_DEP_WARNING)).toBe('requests_dep_mismatch');
  });
  it('classifies conftest ImportError (jinn-mono-y4ah)', () => {
    expect(matchInfraSignature(CONFTEST_IMPORT_ERROR)).toBe('conftest_import_error');
  });

  it('still leaves a normal pytest FAIL session alone (returns null)', () => {
    const normalFail = [
      '=================== test session starts ===================',
      'tests/test_x.py::test_foo FAILED',
      '=================== 1 failed in 0.42s ===================',
    ].join('\n');
    expect(matchInfraSignature(normalFail)).toBeNull();
  });
});
