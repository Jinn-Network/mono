import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PythonEvalRunner,
  EvalCouldNotGradeError,
  InsufficientDiskError,
  matchInfraSignature,
} from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';

const tempDirs: string[] = [];

// #515 — the default disk floor is 20 GB (set in #476 for the real eval
// runner). Tests that don't explicitly inject `diskFloorBytes` / `freeDiskBytes`
// fall through to the real `statvfs`-based disk check on the CI runner,
// which typically has ~19 GB free → `InsufficientDiskError` on unrelated PRs.
// Lower the floor to 1 GB for this file so the real disk check still runs
// but is effectively a no-op on any plausible runner; the dedicated
// `disk-floor guard (#476)` describe-block below overrides this via the
// constructor option (explicit option > env > default) so its assertions
// remain intact.
let savedDiskFloorEnv: string | undefined;
beforeAll(() => {
  savedDiskFloorEnv = process.env['JINN_EVAL_DISK_FLOOR_GB'];
  process.env['JINN_EVAL_DISK_FLOOR_GB'] = '1';
});
afterAll(() => {
  if (savedDiskFloorEnv === undefined) {
    delete process.env['JINN_EVAL_DISK_FLOOR_GB'];
  } else {
    process.env['JINN_EVAL_DISK_FLOOR_GB'] = savedDiskFloorEnv;
  }
});

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

  it('times out a wedged eval subprocess and reports it as ungradeable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-rebench-eval-runner-test-'));
    tempDirs.push(dir);
    const scriptsDir = join(dir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, '__init__.py'), '');
    writeFileSync(join(scriptsDir, 'eval.py'), [
      'import time',
      'time.sleep(60)',
    ].join('\n'));
    chmodSync(join(scriptsDir, 'eval.py'), 0o755);
    const pruned: string[] = [];

    const err = await new PythonEvalRunner({
      upstreamRepoDir: dir,
      maxWorkers: 1,
      evalTimeoutMs: 50,
      pruneRound: async (image) => { pruned.push(image); },
    }).runEval(REQUEST).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvalCouldNotGradeError);
    expect((err as EvalCouldNotGradeError).reason).toBe('eval_timeout');
    expect(pruned).toEqual([REQUEST.image]);
  });

  // #476 — replace the LRU with per-round pruning so eval disk usage never
  // accumulates across instances. Each runEval call prunes its own Docker
  // footprint immediately after the eval (success or failure).
  describe('prune-after-every-round (#476)', () => {
    it('prunes the round image after a successful eval', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const pruned: string[] = [];
      const runner = new PythonEvalRunner({
        upstreamRepoDir,
        maxWorkers: 1,
        pruneRound: async (image) => { pruned.push(image); },
      });
      await runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-A' });
      expect(pruned).toEqual(['img-A']);
    });

    it('carries the image digest resolved before pruning removes the local image', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const events: string[] = [];
      const digest = 'sha256:' + 'a'.repeat(64);
      const runner = new PythonEvalRunner({
        upstreamRepoDir,
        maxWorkers: 1,
        resolveImageDigest: async (image) => {
          events.push(`digest:${image}`);
          return digest;
        },
        pruneRound: async (image) => {
          events.push(`prune:${image}`);
        },
      });

      const result = await runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-A' });

      expect(result.imageDigest).toBe(digest);
      expect(events).toEqual(['digest:img-A', 'prune:img-A']);
    });

    it('prunes the round image even when the eval throws EvalCouldNotGradeError', async () => {
      // eval.py exits non-zero without writing a report — runEval throws
      // EvalCouldNotGradeError('eval_no_report'). The image must still be
      // pruned, otherwise pull-and-crash failures leave images on disk.
      const dir = mkdtempSync(join(tmpdir(), 'swe-rebench-eval-runner-test-'));
      tempDirs.push(dir);
      const scriptsDir = join(dir, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(join(scriptsDir, '__init__.py'), '');
      writeFileSync(join(scriptsDir, 'eval.py'), 'import sys\nsys.exit(2)\n');
      chmodSync(join(scriptsDir, 'eval.py'), 0o755);

      const pruned: string[] = [];
      const runner = new PythonEvalRunner({
        upstreamRepoDir: dir,
        maxWorkers: 1,
        pruneRound: async (image) => { pruned.push(image); },
      });
      await expect(runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-B' }))
        .rejects.toBeInstanceOf(EvalCouldNotGradeError);
      expect(pruned).toEqual(['img-B']);
    });

    it('a throwing pruneRound never escapes runEval', async () => {
      // pruneRound throwing must not propagate — cleanup failures should be
      // swallowed so a flaky `docker` never breaks the eval loop.
      const upstreamRepoDir = makeUpstreamFixture();
      const runner = new PythonEvalRunner({
        upstreamRepoDir,
        maxWorkers: 1,
        pruneRound: async () => { throw new Error('docker rmi blew up'); },
      });
      // runEval must still resolve with the graded result.
      const result = await runner.runEval({ ...REQUEST, instance_id: 'i1', image: 'img-C' });
      expect(result.passed_match).toBe(true);
    });
  });

  // #476 — pre-eval disk-floor guard: probe free disk before each eval; if
  // below the floor, broad-prune and re-probe; if still below, abort cleanly
  // with InsufficientDiskError (distinct from EvalCouldNotGradeError).
  describe('disk-floor guard (#476)', () => {
    const GB = 1_000_000_000;

    it('proceeds without pruning when free disk is above the floor', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      let systemPruneCalled = false;
      const runner = new PythonEvalRunner({
        upstreamRepoDir,
        maxWorkers: 1,
        pruneRound: async () => { /* no-op */ },
        freeDiskBytes: async () => 50 * GB,
        systemPrune: async () => { systemPruneCalled = true; },
        diskFloorBytes: 10 * GB,
      });
      await runner.runEval(REQUEST);
      expect(systemPruneCalled).toBe(false);
    });

    it('prunes and proceeds when a low disk recovers above the floor after system prune', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const diskReadings = [5 * GB, 20 * GB];
      let systemPruneCalled = false;
      const runner = new PythonEvalRunner({
        upstreamRepoDir,
        maxWorkers: 1,
        pruneRound: async () => { /* no-op */ },
        freeDiskBytes: async () => diskReadings.shift() ?? 20 * GB,
        systemPrune: async () => { systemPruneCalled = true; },
        diskFloorBytes: 10 * GB,
      });
      const result = await runner.runEval(REQUEST);
      expect(systemPruneCalled).toBe(true);
      expect(result.passed_match).toBe(true);
    });

    it('throws InsufficientDiskError (clean abort) when disk stays below the floor after system prune', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const runner = new PythonEvalRunner({
        upstreamRepoDir,
        maxWorkers: 1,
        pruneRound: async () => { /* no-op */ },
        freeDiskBytes: async () => 2 * GB,
        systemPrune: async () => { /* no-op */ },
        diskFloorBytes: 10 * GB,
      });
      const err = await runner.runEval(REQUEST).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InsufficientDiskError);
      expect((err as InsufficientDiskError).freeBytes).toBe(2 * GB);
      expect((err as InsufficientDiskError).floorBytes).toBe(10 * GB);
    });
  });

  describe('patch trailing-newline normalisation (jinn-mono-c52e)', () => {
    it('appends \\n when args.patch ends mid-line', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const runner = new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 });
      // Reproduces 2026-05-14 patch_corrupt observed on
      // bafkreiggeeb45ricooagdji6lewdzossfiedfobhs4isw7hwh2anllk2dm.
      const sourcePatch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y';
      expect(sourcePatch.endsWith('\n')).toBe(false);

      await runner.runEval({ ...REQUEST, patch: sourcePatch });

      const observedPatches = JSON.parse(
        readFileSync(join(upstreamRepoDir, 'observed-patches.json'), 'utf8'),
      ) as Array<{ instance_id: string; patch: string }>;
      expect(observedPatches[0]!.patch).toBe(`${sourcePatch}\n`);
    });

    it('preserves a single trailing newline (no double-add)', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      const runner = new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 });
      const sourcePatch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n';

      await runner.runEval({ ...REQUEST, patch: sourcePatch });

      const observedPatches = JSON.parse(
        readFileSync(join(upstreamRepoDir, 'observed-patches.json'), 'utf8'),
      ) as Array<{ instance_id: string; patch: string }>;
      expect(observedPatches[0]!.patch).toBe(sourcePatch);
      expect(observedPatches[0]!.patch.endsWith('\n\n')).toBe(false);
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

  it('classifies fatal illegal-instruction crashes as arch mismatches', () => {
    expect(matchInfraSignature('Fatal Python error: Illegal instruction\nCurrent thread 0x000000010...')).toBe('image_arch_mismatch');
  });

  it('still leaves a normal pytest FAIL session alone (returns null)', () => {
    const normalFail = [
      '=================== test session starts ===================',
      'tests/test_x.py::test_foo FAILED',
      '=================== 1 failed in 0.42s ===================',
    ].join('\n');
    expect(matchInfraSignature(normalFail)).toBeNull();
  });

  it('does NOT misclassify a missing pytest plugin (pytest_asyncio) as pytest_missing', () => {
    expect(matchInfraSignature('/opt/conda/bin/python: No module named pytest_asyncio')).not.toBe('pytest_missing');
  });

  it('does NOT match a benign mention of conftest in a passing test log', () => {
    const benign = [
      '=================== test session starts ===================',
      'collected 5 items',
      'rootdir: /testbed, configfile: pytest.ini, conftest: conftest.py',
      'tests/test_x.py::test_foo PASSED',
      '=================== 5 passed in 0.42s ===================',
    ].join('\n');
    expect(matchInfraSignature(benign)).toBeNull();
  });

  it('does NOT match a benign mention of .venv in a non-collision log', () => {
    const benign = 'INFO: Created virtual environment at /testbed/.venv';
    expect(matchInfraSignature(benign)).toBeNull();
  });
});
