import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PythonEvalRunner,
  EvalCouldNotGradeError,
  InsufficientDiskError,
  matchInfraSignature,
} from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import {
  CommandTimeoutError,
  resolveImageDigest,
  type CommandRunner,
} from '../../../../src/solver-types/_swe-rebench-v2-substrate.js';

// CI runners can have <20 GB free; tests construct PythonEvalRunner without
// passing freeDiskBytes/diskFloorBytes, so the production env-driven 20 GB
// floor triggers InsufficientDiskError before any test logic runs. Pin the
// floor to a sub-MB positive value (resolveDiskFloorBytes rejects 0/negative
// as invalid and warns, then falls back to the 20 GB default — so we need a
// positive value here). Tests that exercise the disk-floor path pass their
// own freeDiskBytes/diskFloorBytes options and are unaffected by this env.
process.env['JINN_EVAL_DISK_FLOOR_GB'] = '0.000001';

// Most tests here construct PythonEvalRunner without injecting `pruneRound` or
// `commandRunner`, so the production cleanup shells out to the real `docker`
// CLI. On a host whose Docker daemon is wedged those calls hang until their
// bound expires, and the production default is 5 minutes — which would make
// this file take hours. Pin a short bound: cleanup is incidental to every
// assertion in this file (a timed-out prune is swallowed and logged), and the
// `docker command timeouts` block below sets its own bound via the constructor
// option (explicit option > env > default), so its assertions are unaffected.
process.env['JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS'] = '1000';

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
      // Pin install to a line that already mentions pytest so the #493
      // install guard is suppressed in this test (which asserts the exact
      // command shape pre-guard).
      install: ['pip install -e .', 'pip install pytest'],
      fail_to_pass: ['tests/a.py::test_x'],
      pass_to_pass: ['tests/a.py::test_y', 'tests/a.py::test_z[0]'],
    });
    const observedTask = JSON.parse(readFileSync(join(upstreamRepoDir, 'observed-task.json'), 'utf8'));
    expect(observedTask.install_config.test_cmd).toEqual([
      'pip install -e .',
      'pip install pytest',
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

  // #493 — pytest-install guard. The single highest-yield blocker on the
  // Stage-1 reason histogram was `ungradeable:pytest_missing` (~18% of all
  // unscorable instances). When the dataset's `install_config.install` does
  // not already install pytest, prepend a best-effort install line so the
  // SWE-bench resolved-semantics test_cmd can find the binary.
  describe('pytest-install guard (#493)', () => {
    it('prepends a pytest install when install does not already mention pytest', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval({
        ...REQUEST,
        install: 'pip install -e .',
      });
      const observedTask = JSON.parse(readFileSync(join(upstreamRepoDir, 'observed-task.json'), 'utf8'));
      const testCmd: string[] = observedTask.install_config.test_cmd;
      // The very first command is the prepended pytest install guard.
      expect(testCmd[0]).toContain('python3 -m ensurepip');
      expect(testCmd[0]).toContain('python3 -m pip install');
      expect(testCmd[0]).toContain('pytest');
      // #493 hardening: the guard is import-gated so it is a provable no-op
      // when pytest is already present, protecting previously-scorable
      // instances from any perturbation (no pip/ensurepip call at all).
      expect(testCmd[0]).toContain("python3 -c 'import pytest'");
      // The dataset's install line still runs.
      expect(testCmd).toContain('pip install -e .');
      // The final command is still the SWE-bench resolved-semantics pytest run.
      expect(testCmd[testCmd.length - 1]).toContain('python -m pytest');
    });

    it('does NOT prepend when install_config.install already installs pytest', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval({
        ...REQUEST,
        install: ['pip install -e .', 'pip install pytest==7.4'],
      });
      const observedTask = JSON.parse(readFileSync(join(upstreamRepoDir, 'observed-task.json'), 'utf8'));
      const testCmd: string[] = observedTask.install_config.test_cmd;
      // Exactly the two original install lines + the pytest run — no guard.
      expect(testCmd).toEqual([
        'pip install -e .',
        'pip install pytest==7.4',
        expect.stringContaining('python -m pytest'),
      ]);
    });

    it('does NOT prepend for non-pytest log parsers regardless of install contents', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval({
        ...REQUEST,
        log_parser: 'parse_log_go',
        install: 'go mod download',
        test_cmd: 'go test ./...',
      });
      const observedTask = JSON.parse(readFileSync(join(upstreamRepoDir, 'observed-task.json'), 'utf8'));
      expect(observedTask.install_config.test_cmd).toEqual(['go mod download', 'go test ./...']);
    });

    it('detects pytest even when the install line uses pip install -r requirements that pin pytest', async () => {
      const upstreamRepoDir = makeUpstreamFixture();
      await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval({
        ...REQUEST,
        // A bare `pytest-cov` should not be enough to skip the guard.
        // Only an explicit `pytest` word boundary counts.
        install: ['pip install -e .', 'pip install pytest-cov'],
      });
      const observedTask = JSON.parse(readFileSync(join(upstreamRepoDir, 'observed-task.json'), 'utf8'));
      const testCmd: string[] = observedTask.install_config.test_cmd;
      // pytest-cov by itself does NOT install pytest as a top-level command;
      // the guard SHOULD still fire to be safe. (`\bpytest\b` matches pytest
      // but not pytest-cov per the word-boundary on the trailing `-`.)
      expect(testCmd[0]).toContain('python3 -m pip install');
      expect(testCmd[0]).toContain('pytest');
    });
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

  it('returns full passed_actual/failed_actual lists in empirical mode (empty FAIL_TO_PASS/PASS_TO_PASS)', async () => {
    const upstreamRepoDir = makeUpstreamFixture({
      reportItem: {
        from_fail_to_pass: [],
        failed_from_pass_to_pass: [],
        passed_actual: ['test_a'],
        failed_actual: ['test_b'],
        passed_match: false,
        exit_code: 1,
      },
    });
    const result = await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval({
      ...REQUEST,
      fail_to_pass: [],
      pass_to_pass: [],
    });
    expect(result.passed).toEqual(['test_a']);
    expect(result.failed).toEqual(['test_b']);
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

  it('throws EvalCouldNotGradeError when the container workdir is not a git checkout', async () => {
    const upstreamRepoDir = makeUpstreamFixture({
      reportItem: {
        from_fail_to_pass: [],
        failed_from_pass_to_pass: ['test_b'],
        passed_match: false,
        exit_code: 128,
      },
      logBody: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    const err = await new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 }).runEval(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalCouldNotGradeError);
    expect((err as EvalCouldNotGradeError).reason).toBe('workdir_not_git_repo');
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

  // #1422 follow-up — real fingerprint from the 2026-07-07 evaluator outage:
  // a hung/killed `docker-credential-*` helper makes `docker run` abort before
  // the container ever starts, so eval.py records a zero-passed "mismatch"
  // report with NO test having run. Without this signature the harness graded
  // it as a genuine `passed_match: false` verdict and delivered a FALSE
  // negative on-chain (test_log CID bafkreifxsn2vx…, verdict 0x3a6bde7a…).
  const DOCKER_CREDENTIALS_KILLED = [
    "Unable to find image 'swerebench/sweb.eval.x86_64.gerlero_1776_foamlib-315:latest' locally",
    'docker: error getting credentials - err: signal: killed, out: ``',
    '',
    "Run 'docker run --help' for more information",
  ].join('\n');

  it('classifies a killed docker credential helper as an infra abort, not a real verdict (#1422)', () => {
    expect(matchInfraSignature(DOCKER_CREDENTIALS_KILLED)).toBe('docker_credentials_error');
  });

  it('classifies a generic docker-run daemon error as an infra abort', () => {
    expect(
      matchInfraSignature('docker: Error response from daemon: pull access denied for foo, repository does not exist'),
    ).not.toBeNull();
  });

  it('classifies a container workdir that is not a git repository as ungradeable', () => {
    expect(matchInfraSignature('fatal: not a git repository (or any of the parent directories): .git'))
      .toBe('workdir_not_git_repo');
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

/**
 * A wedged Docker daemon makes every `docker` CLI call hang forever. Because
 * `pruneRound` runs in `runEval`'s `finally`, an unbounded prune blocked the
 * grade job *before* its attempt record was written — which is why hung runs
 * left stale attempt records behind. Each docker call is now individually
 * bounded, and a timeout is logged distinctly from a real Docker failure.
 */
describe('docker command timeouts', () => {
  /** Stands in for a wedged daemon: every `docker` call simply never settles. */
  const neverResolves: CommandRunner = () => new Promise<never>(() => {});

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still returns the grade when every docker call is wedged', async () => {
    const upstreamRepoDir = makeUpstreamFixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await new PythonEvalRunner({
      upstreamRepoDir,
      maxWorkers: 1,
      commandRunner: neverResolves,
      dockerCommandTimeoutMs: 25,
    }).runEval(REQUEST);

    // The eval graded fine; only the docker-side digest lookup and cleanup hung.
    expect(result.passed_match).toBe(true);
    expect(result.imageDigest).toBeUndefined();
    // Every prune step timed out and was logged as a timeout, not as a Docker failure.
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => /docker rmi .* timed out after 25ms/.test(w))).toBe(true);
    expect(warnings.some((w) => /docker container prune -f timed out/.test(w))).toBe(true);
    expect(warnings.some((w) => /docker builder prune -f timed out/.test(w))).toBe(true);
    expect(warnings.some((w) => /Docker daemon may be wedged/.test(w))).toBe(true);
  });

  it('bounds the low-disk system prune too', async () => {
    const upstreamRepoDir = makeUpstreamFixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Free disk stays below the floor, so `ensureDiskHeadroom` prunes and
    // re-probes. With a wedged daemon that prune must abort, not hang.
    await expect(new PythonEvalRunner({
      upstreamRepoDir,
      maxWorkers: 1,
      commandRunner: neverResolves,
      dockerCommandTimeoutMs: 25,
      diskFloorBytes: 1_000_000_000,
      freeDiskBytes: async () => 1,
    }).runEval(REQUEST)).rejects.toBeInstanceOf(InsufficientDiskError);

    expect(warn.mock.calls.map((c) => String(c[0])).some(
      (w) => /docker system prune -f timed out/.test(w),
    )).toBe(true);
  });

  it('surfaces a timeout as a typed error a caller can tell from a Docker failure', async () => {
    const err = await resolveImageDigest('img:latest', neverResolves, 25).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandTimeoutError);
    // A real Docker failure resolves with a non-zero exit and yields null.
    expect(await resolveImageDigest('img:latest', async () => ({
      exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon',
    }))).toBeNull();
  });
});
