/**
 * Diagnostic: re-grade an already-recovered patch from a bench transcript, with an
 * explicit timeout, and report wall-clock. No inference — reuses the saved patch.
 *
 * Answers "can this host complete a swe-rebench Docker eval at all, and how long
 * does it take?" without spending another solve.
 *
 * Usage:
 *   yarn tsx scripts/skills-bench/regrade-probe.ts \
 *     --transcript ../bench/runs/smoke/transcripts/'pgmpy__pgmpy-2271|baseline|0.json' \
 *     --slate ../bench/slate/slate.json \
 *     [--timeout-ms 3600000] [--upstream-repo-dir PATH]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { HttpHfFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import {
  PythonEvalRunner,
  EvalCouldNotGradeError,
} from '../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const transcriptPath = resolve(arg('transcript'));
const slatePath = resolve(arg('slate'));
const timeoutMs = Number(arg('timeout-ms', '3600000'));
const upstreamRepoDir = resolve(arg('upstream-repo-dir', join(homedir(), '.jinn-client', 'SWE-rebench-V2-upstream')));

const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as { patch?: string };
const patch = transcript.patch ?? '';
if (!patch.trim()) throw new Error('transcript has an empty patch — nothing to grade');

// instanceId is the first field of the "<instanceId>|<arm>|<repeat>.json" filename.
const base = transcriptPath.split('/').pop()!.replace(/\.json$/, '');
const instanceId = base.split('|')[0]!;

const slate = JSON.parse(readFileSync(slatePath, 'utf8')) as {
  feedback: { instance_id: string; hf_dataset: string; hf_split: string }[];
  holdout: { instance_id: string; hf_dataset: string; hf_split: string }[];
};
const entry = [...slate.feedback, ...slate.holdout].find((c) => c.instance_id === instanceId);
if (!entry) throw new Error(`${instanceId} not found in slate`);

console.log(`[probe] instance=${instanceId} patchBytes=${patch.length} timeoutMs=${timeoutMs}`);
console.log(`[probe] fetching HF row...`);
const row = await new HttpHfFetcher().fetchTaskRow({
  hf_dataset: entry.hf_dataset,
  hf_split: entry.hf_split,
  instance_id: instanceId,
});
console.log(`[probe] image=${row.image_name} repo=${row.repo}`);

const runner = new PythonEvalRunner({ upstreamRepoDir, evalTimeoutMs: timeoutMs });
const started = Date.now();
try {
  const result = await runner.runEval({
    instance_id: instanceId,
    repo: row.repo,
    image: row.image_name,
    patch,
    test_patch: row.test_patch,
    install: row.install_config.install,
    test_cmd: row.install_config.test_cmd,
    log_parser: row.install_config.log_parser,
    fail_to_pass: row.FAIL_TO_PASS,
    pass_to_pass: row.PASS_TO_PASS,
  });
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`[probe] COMPLETED in ${mins} min — passed_match=${result.passed_match} exit=${result.exitCode}`);
  console.log(`[probe] passed=${result.passed.length} failed=${result.failed.length}`);
} catch (err) {
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  if (err instanceof EvalCouldNotGradeError) {
    console.log(`[probe] UNGRADEABLE after ${mins} min — reason=${err.reason}`);
  } else {
    console.log(`[probe] ERROR after ${mins} min — ${(err as Error).message}`);
  }
  process.exitCode = 1;
}
