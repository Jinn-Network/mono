import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PythonEvalRunner,
  EvalCouldNotGradeError,
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
});
