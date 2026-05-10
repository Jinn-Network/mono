import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PythonEvalRunner } from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';

const tempDirs: string[] = [];

function makeUpstreamFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swe-rebench-eval-runner-test-'));
  tempDirs.push(dir);
  const scriptsDir = join(dir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, '__init__.py'), '');
  writeFileSync(join(scriptsDir, 'eval.py'), `
import argparse
import json
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
Path("observed-log.txt").write_text("ok")
Path(args.report_json).write_text(json.dumps({
  "total": 1,
  "passed": 1,
  "items": [{
    "instance_id": tasks[0]["instance_id"],
    "passed_match": True,
    "from_fail_to_pass": ["test_a"],
    "failed_from_pass_to_pass": [],
    "exit_code": 0,
    "log_path": str(Path("observed-log.txt").resolve()),
    "error": "",
  }],
}))
`);
  chmodSync(join(scriptsDir, 'eval.py'), 0o755);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('PythonEvalRunner', () => {
  it('passes the real instance id and uses the SWE-rebench /testbed container workdir slug', async () => {
    const upstreamRepoDir = makeUpstreamFixture();
    const runner = new PythonEvalRunner({ upstreamRepoDir, maxWorkers: 1 });

    const result = await runner.runEval({
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
    });

    const observedTask = JSON.parse(readFileSync(join(upstreamRepoDir, 'observed-task.json'), 'utf8'));
    expect(observedTask.instance_id).toBe('astronomer__astronomer-cosmos-2332');
    expect(observedTask.repo).toBe('jinn/testbed');
    expect(observedTask.install_config.test_cmd).toEqual([
      'pip install -e .',
      'pytest tests/dbt/test_graph.py',
    ]);
    expect(result.passed_match).toBe(true);
    expect(result.passed).toEqual(['test_a']);
  });
});
