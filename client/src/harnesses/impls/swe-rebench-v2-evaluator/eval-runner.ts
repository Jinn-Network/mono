/**
 * Thin Python-subprocess wrapper around `scripts/eval.py` from the upstream
 * SWE-rebench/SWE-rebench-V2 repo (MIT). Operators install the upstream
 * harness as a Python dependency; this runner shells out and parses the
 * structured JSON report.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalRunner } from './index.js';

export interface PythonEvalRunnerOptions {
  /** Path to the cloned SWE-rebench-V2 repo (cached locally). */
  upstreamRepoDir: string;
  /** Override Python executable. Defaults to `python3`. */
  pythonBin?: string;
  /** Workers for parallel eval (defaults to 1; we run one task at a time). */
  maxWorkers?: number;
}

export class PythonEvalRunner implements EvalRunner {
  constructor(private readonly opts: PythonEvalRunnerOptions) {}

  async runEval(args: Parameters<EvalRunner['runEval']>[0]): ReturnType<EvalRunner['runEval']> {
    const tmp = await mkdtemp(join(tmpdir(), 'swerebench-eval-'));
    // Single-task runner: eval.py matches the patch override by instance_id.
    const INSTANCE_ID = args.instance_id;
    const taskJson = [{
      instance_id: INSTANCE_ID,
      // SWE-rebench Docker images place the checked-out repository at
      // /testbed. The upstream eval.py derives its docker workdir from the
      // repo slug, so use a synthetic slug that resolves to /testbed while
      // preserving the real repo separately in the Jinn task/HF row.
      repo: 'jinn/testbed',
      image_name: args.image,
      FAIL_TO_PASS: args.fail_to_pass,
      PASS_TO_PASS: args.pass_to_pass,
      test_patch: args.test_patch,
      install_config: {
        test_cmd: [
          ...normalizeCommands(args.install),
          ...normalizeCommands(args.test_cmd),
        ],
        log_parser: args.log_parser,
      },
    }];
    // Upstream eval.py expects --patches to be a JSON list of
    // `{instance_id, patch, test_patch?}` overrides keyed by instance_id.
    const patchesJson = [{ instance_id: INSTANCE_ID, patch: args.patch }];
    const taskJsonPath = join(tmp, 'task.json');
    const patchesJsonPath = join(tmp, 'patches.json');
    const reportPath = join(tmp, 'report.json');
    await writeFile(taskJsonPath, JSON.stringify(taskJson));
    await writeFile(patchesJsonPath, JSON.stringify(patchesJson));

    const pyArgs = [
      '-m', 'scripts.eval',
      '--json', taskJsonPath,
      '--patches', patchesJsonPath,
      '--max-workers', String(this.opts.maxWorkers ?? 1),
      '--report-json', reportPath,
    ];
    const child = spawn(this.opts.pythonBin ?? 'python3', pyArgs, {
      cwd: this.opts.upstreamRepoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', reject);
    });

    let report: { items?: Array<Record<string, unknown>> };
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as typeof report;
    } catch {
      await rm(tmp, { recursive: true, force: true });
      throw new Error(`Eval runner failed: exitCode=${exitCode}, stderr=${stderr.slice(-500)}`);
    }

    // Upstream report shape: { total, passed, items: [{instance_id, passed_match,
    // from_fail_to_pass, failed_from_pass_to_pass, exit_code, log_path, error}] }.
    const items = Array.isArray(report.items) ? report.items : [];
    const item = items.find((i) => i['instance_id'] === INSTANCE_ID) ?? items[0] ?? {};

    let logBody = '';
    const logPath = item['log_path'];
    if (typeof logPath === 'string' && logPath.length > 0) {
      try {
        logBody = await readFile(logPath, 'utf8');
      } catch {
        logBody = '';
      }
    }

    await rm(tmp, { recursive: true, force: true });

    return {
      passed_match: item['passed_match'] === true,
      passed: Array.isArray(item['from_fail_to_pass']) ? (item['from_fail_to_pass'] as string[]) : [],
      failed: Array.isArray(item['failed_from_pass_to_pass']) ? (item['failed_from_pass_to_pass'] as string[]) : [],
      log: stdout + logBody,
      exitCode,
    };
  }
}

function normalizeCommands(value: string | string[] | undefined): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
