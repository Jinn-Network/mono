import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function runPilot(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node_modules/.bin/tsx', ['scripts/run-pilot.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    // `resolveDiskFloorBytes` (eval-runner.ts) requires a positive value, then does
    // `Math.floor(parsed * 1e9)` — this resolves to a ~1000-byte floor that no real
    // filesystem trips, neutralizing the gate. 1 GB (the previous value here) is a real
    // threshold: these regrade tests go red whenever the host drops under 1 GB free, and
    // the fake `scripts/eval.py` stub in this file never touches Docker or disk, so the
    // gate is pure noise for this suite.
    env: { ...process.env, JINN_EVAL_DISK_FLOOR_GB: '0.000001' },
    // A wedged Docker daemon can hang the child indefinitely; spawnSync blocks the event
    // loop, so vitest's 30s testTimeout can never fire to rescue it. This timeout is
    // containment for the test worker, not a fix for the underlying gap — `runDocker` /
    // `defaultCommandRunner` still have no timeout of their own (tracked separately).
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function attemptCount(outDir: string): number {
  return readdirSync(join(outDir, 'attempts')).filter((name) => name.endsWith('.json')).length;
}

describe('run-pilot durable dry-run resume', () => {
  it('uses the 24-task validated clean v3 slate by default', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-run-v3-'));
    const armsFile = join(outDir, 'arms.json');
    writeFileSync(armsFile, JSON.stringify([
      { name: 'stock', skills: [] },
      { name: 'haiku', skills: ['haiku-skill'] },
      { name: 'opus', skills: ['opus-skill'] },
    ]));

    const run = runPilot([
      '--dry-run',
      '--out', outDir,
      '--arms-file', armsFile,
      '--skills-nudge',
      '--max-new-solves', '0',
    ]);

    expect(run.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8')) as {
      attemptCount: number;
      semanticConfig: {
        instances: Array<{ instance_id: string; hf_dataset: string }>;
        taskSource?: string;
        slateHash?: string;
        skillsNudge?: boolean;
      };
    };
    expect(manifest.semanticConfig.skillsNudge).toBe(true);
    expect(manifest.semanticConfig.instances).toHaveLength(24);
    expect(manifest.semanticConfig.instances.every((ref) => ref.hf_dataset === 'nebius/SWE-rebench-leaderboard')).toBe(true);
    expect(manifest.semanticConfig.instances.some((ref) => ref.instance_id === 'pilosus__pip-license-checker-119')).toBe(false);
    expect(manifest.semanticConfig.taskSource).toBe('held-out-slate:v3');
    expect(manifest.semanticConfig.slateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.attemptCount).toBe(72);
  });

  it('runs dry-run attempts in chunks and resumes without repeating completed attempts', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-run-resume-'));
    const instances = JSON.stringify([
      { instance_id: 'alpha__repo-1', hf_dataset: 'ds', hf_split: 'train' },
    ]);
    const baseArgs = [
      '--dry-run',
      '--out', outDir,
      '--instances', instances,
      '--repeats', '1',
      '--max-new-solves', '1',
    ];

    const first = runPilot(baseArgs);
    expect(first.status).toBe(0);
    expect(attemptCount(outDir)).toBe(1);
    expect(first.stdout).toContain('total solves: 1');

    const second = runPilot(baseArgs);
    expect(second.status).toBe(0);
    expect(attemptCount(outDir)).toBe(2);
    expect(second.stdout).toContain('total solves: 2');

    const third = runPilot(baseArgs);
    expect(third.status).toBe(0);
    expect(attemptCount(outDir)).toBe(2);
    expect(third.stdout).toContain('no runnable attempts');
    expect(third.stdout).toContain('total solves: 2');

    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf-8')) as { outcomes: unknown[] };
    expect(report.outcomes).toHaveLength(2);
  });

  it('fails on frozen semantic config mismatch unless --force is passed', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-run-resume-'));
    const first = runPilot(['--dry-run', '--out', outDir, '--skill', 'one-skill']);
    expect(first.status).toBe(0);

    const mismatch = runPilot(['--dry-run', '--out', outDir, '--skill', 'other-skill']);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toMatch(/different frozen pilot config/i);

    const forced = runPilot(['--dry-run', '--out', outDir, '--skill', 'other-skill', '--force']);
    expect(forced.status).toBe(0);
  });

  it('extends an existing durable store when new instances are added (append-only slates)', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-run-extend-'));
    const one = [{ instance_id: 'alpha__repo-1', hf_dataset: 'ds', hf_split: 'train' }];
    const two = [...one, { instance_id: 'beta__repo-2', hf_dataset: 'ds', hf_split: 'train' }];

    const first = runPilot(['--dry-run', '--out', outDir, '--instances', JSON.stringify(one), '--repeats', '1']);
    expect(first.status).toBe(0);
    expect(attemptCount(outDir)).toBe(2); // one instance × arms A/B

    // Superset resume freezes the new instance and runs only its attempts.
    const second = runPilot(['--dry-run', '--out', outDir, '--instances', JSON.stringify(two), '--repeats', '1']);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/extending durable store with 1 new instance/i);
    expect(attemptCount(outDir)).toBe(4);

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8')) as {
      attemptCount: number;
      semanticConfig: { instances: Array<{ instance_id: string }> };
    };
    expect(manifest.semanticConfig.instances.map((ref) => ref.instance_id)).toEqual(['alpha__repo-1', 'beta__repo-2']);
    expect(manifest.attemptCount).toBe(4);

    const frozen = JSON.parse(readFileSync(join(outDir, 'instances.json'), 'utf-8')) as {
      instances: Array<{ ref: { instance_id: string } }>;
    };
    expect(frozen.instances.map((item) => item.ref.instance_id)).toEqual(['alpha__repo-1', 'beta__repo-2']);

    // Removal still fails closed.
    const removal = runPilot(['--dry-run', '--out', outDir, '--instances', JSON.stringify([two[1]]), '--repeats', '1']);
    expect(removal.status).toBe(1);
    expect(removal.stderr).toMatch(/instances may only be added/i);
  });

  it('refuses a real run whose arms differ in loadout without per-arm isolated homes', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-run-isolation-'));
    const armsFile = join(outDir, 'arms.json');
    // The 2026-07-10 arm-invariance trap: distinct skills, shared implicit home.
    writeFileSync(armsFile, JSON.stringify([
      { name: 'stock', skills: [] },
      { name: 'haiku', skills: ['some-skill'] },
    ]));

    const run = runPilot([
      '--out', outDir,
      '--instances', JSON.stringify([{ instance_id: 'a__b-1', hf_dataset: 'ds', hf_split: 'train' }]),
      '--arms-file', armsFile,
      '--max-new-solves', '1',
    ]);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/jinnAgentHome/i);
    // Fails before freezing anything — no store contamination, no spend.
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });

  it('refuses to resume a dry-run durable store with a real run (and vice versa)', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-run-mode-'));
    const instances = JSON.stringify([
      { instance_id: 'alpha__repo-1', hf_dataset: 'ds', hf_split: 'train' },
    ]);
    // Single-condition arms so the isolation gate is not what fires here —
    // this test's subject is the mode marker.
    const armsFile = join(outDir, 'arms.json');
    writeFileSync(armsFile, JSON.stringify([{ name: 'stock', skills: [] }]));

    const dry = runPilot(['--dry-run', '--out', outDir, '--instances', instances, '--arms-file', armsFile, '--max-new-solves', '0']);
    expect(dry.status).toBe(0);

    // Real run against the dry-run store must fail closed at the manifest
    // check (before any network/solve) — fake graded records must never be
    // resumable as real results.
    const real = runPilot(['--out', outDir, '--instances', instances, '--arms-file', armsFile, '--max-new-solves', '0']);
    expect(real.status).toBe(1);
    expect(real.stderr).toMatch(/different frozen pilot config for mode/i);
  });

  it('regrades a grade-error attempt from its saved patch without re-solving', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-run-regrade-'));
    const ref = { instance_id: 'example__repo-1', hf_dataset: 'ds', hf_split: 'train' };

    // Stub jinn-agent: if the pilot re-solves, this writes a sentinel and the
    // record can never become graded.
    const sentinel = join(outDir, 'agent-was-invoked');
    const agentBin = join(outDir, 'stub-jinn-agent');
    writeFileSync(agentBin, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nexit 1\n`);
    chmodSync(agentBin, 0o755);

    // Fake upstream scripts.eval that reports the FAIL_TO_PASS test passing.
    const upstreamDir = join(outDir, 'upstream');
    mkdirSync(join(upstreamDir, 'scripts'), { recursive: true });
    writeFileSync(join(upstreamDir, 'scripts', '__init__.py'), '');
    writeFileSync(join(upstreamDir, 'scripts', 'eval.py'), [
      'import argparse, json',
      'from pathlib import Path',
      'parser = argparse.ArgumentParser()',
      'parser.add_argument("--json", required=True)',
      'parser.add_argument("--patches", required=True)',
      'parser.add_argument("--max-workers")',
      'parser.add_argument("--report-json", required=True)',
      'args = parser.parse_args()',
      'tasks = json.loads(Path(args.json).read_text())',
      'item = {"instance_id": tasks[0]["instance_id"], "from_fail_to_pass": ["test_a"],',
      '        "failed_from_pass_to_pass": [], "passed_match": True, "exit_code": 0, "error": ""}',
      'Path(args.report_json).write_text(json.dumps({"total": 1, "items": [item]}))',
    ].join('\n'));

    const arms = [{ name: 'stock', skills: [] }];
    const armsFile = join(outDir, 'arms.json');
    writeFileSync(armsFile, JSON.stringify(arms));

    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
      schema: 'jinn.pilot.manifest.v1',
      generatedAt: '2026-07-10T00:00:00.000Z',
      semanticConfig: {
        instances: [ref],
        repeats: 1,
        arms,
        maxTurns: 20,
        gradeTimeoutMs: 600_000,
        mode: 'real',
      },
      attemptCount: 1,
    }));
    writeFileSync(join(outDir, 'instances.json'), JSON.stringify({
      schema: 'jinn.pilot.instances.v1',
      instances: [{
        ref,
        instance: {
          instance_id: ref.instance_id,
          repo: 'example/repo',
          base_commit: 'deadbeef',
          problem_statement: 'x',
        },
        hfRow: {
          instance_id: ref.instance_id,
          repo: 'example/repo',
          image_name: 'example-image:latest',
          test_patch: 'diff --git a/t b/t\n',
          install_config: { install: 'true', test_cmd: 'pytest -q', log_parser: 'parse_log_pytest' },
          FAIL_TO_PASS: ['test_a'],
          PASS_TO_PASS: [],
        },
      }],
    }));

    const recordBase = Buffer.from(`${ref.instance_id}:stock:0`, 'utf8').toString('base64url');
    mkdirSync(join(outDir, 'patches'), { recursive: true });
    writeFileSync(join(outDir, 'patches', `${recordBase}.patch`), 'diff --git a/x b/x\n+fix\n');
    mkdirSync(join(outDir, 'attempts'), { recursive: true });
    writeFileSync(join(outDir, 'attempts', `${recordBase}.json`), JSON.stringify({
      schema: 'jinn.pilot.attempt.v1',
      instance_id: ref.instance_id,
      arm: 'stock',
      repeat: 0,
      status: 'grade-error',
      passed: null,
      costUsd: 0.0611,
      tokens: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 1 },
      sessionId: '20260710_session',
      patchRelPath: `patches/${recordBase}.patch`,
      error: 'docker was down',
    }));

    const run = runPilot([
      '--out', outDir,
      '--instances', JSON.stringify([ref]),
      '--arms-file', armsFile,
      '--max-turns', '20',
      '--grade-timeout-ms', '600000',
      '--retry-errors',
      '--max-new-solves', '1',
      '--jinn-agent-bin', agentBin,
      '--upstream-repo-dir', upstreamDir,
    ]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('regrading');
    expect(run.stdout).not.toContain('cloning example/repo');
    expect(existsSync(sentinel)).toBe(false);

    const updated = JSON.parse(readFileSync(join(outDir, 'attempts', `${recordBase}.json`), 'utf-8')) as {
      status: string; passed: boolean | null; costUsd: number; sessionId?: string; error?: string;
    };
    expect(updated.status).toBe('graded');
    expect(updated.passed).toBe(true);
    expect(updated.costUsd).toBe(0.0611);
    expect(updated.sessionId).toBe('20260710_session');
    expect(updated.error).toBeUndefined();
  });

  it('regrades multiple instances under --solve-concurrency without re-solving any', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-run-concurrency-'));
    const refs = [
      { instance_id: 'example__repo-1', hf_dataset: 'ds', hf_split: 'train' },
      { instance_id: 'example__repo-2', hf_dataset: 'ds', hf_split: 'train' },
    ];

    const sentinel = join(outDir, 'agent-was-invoked');
    const agentBin = join(outDir, 'stub-jinn-agent');
    writeFileSync(agentBin, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nexit 1\n`);
    chmodSync(agentBin, 0o755);

    const upstreamDir = join(outDir, 'upstream');
    mkdirSync(join(upstreamDir, 'scripts'), { recursive: true });
    writeFileSync(join(upstreamDir, 'scripts', '__init__.py'), '');
    writeFileSync(join(upstreamDir, 'scripts', 'eval.py'), [
      'import argparse, json',
      'from pathlib import Path',
      'parser = argparse.ArgumentParser()',
      'parser.add_argument("--json", required=True)',
      'parser.add_argument("--patches", required=True)',
      'parser.add_argument("--max-workers")',
      'parser.add_argument("--report-json", required=True)',
      'args = parser.parse_args()',
      'tasks = json.loads(Path(args.json).read_text())',
      'item = {"instance_id": tasks[0]["instance_id"], "from_fail_to_pass": ["test_a"],',
      '        "failed_from_pass_to_pass": [], "passed_match": True, "exit_code": 0, "error": ""}',
      'Path(args.report_json).write_text(json.dumps({"total": 1, "items": [item]}))',
    ].join('\n'));

    const arms = [{ name: 'stock', skills: [] }];
    const armsFile = join(outDir, 'arms.json');
    writeFileSync(armsFile, JSON.stringify(arms));

    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
      schema: 'jinn.pilot.manifest.v1',
      generatedAt: '2026-07-10T00:00:00.000Z',
      semanticConfig: {
        instances: refs,
        repeats: 1,
        arms,
        maxTurns: 20,
        gradeTimeoutMs: 600_000,
        mode: 'real',
      },
      attemptCount: 2,
    }));
    writeFileSync(join(outDir, 'instances.json'), JSON.stringify({
      schema: 'jinn.pilot.instances.v1',
      instances: refs.map((ref) => ({
        ref,
        instance: { instance_id: ref.instance_id, repo: 'example/repo', base_commit: 'deadbeef', problem_statement: 'x' },
        hfRow: {
          instance_id: ref.instance_id,
          repo: 'example/repo',
          image_name: 'example-image:latest',
          test_patch: 'diff --git a/t b/t\n',
          install_config: { install: 'true', test_cmd: 'pytest -q', log_parser: 'parse_log_pytest' },
          FAIL_TO_PASS: ['test_a'],
          PASS_TO_PASS: [],
        },
      })),
    }));

    mkdirSync(join(outDir, 'patches'), { recursive: true });
    mkdirSync(join(outDir, 'attempts'), { recursive: true });
    const bases = refs.map((ref) => Buffer.from(`${ref.instance_id}:stock:0`, 'utf8').toString('base64url'));
    // One grade-error and one infra-ungradeable (eval_timeout-style) — both
    // have banked patches, both must regrade without a re-solve.
    const statuses = ['grade-error', 'ungradeable'] as const;
    for (const [i, ref] of refs.entries()) {
      writeFileSync(join(outDir, 'patches', `${bases[i]}.patch`), 'diff --git a/x b/x\n+fix\n');
      writeFileSync(join(outDir, 'attempts', `${bases[i]}.json`), JSON.stringify({
        schema: 'jinn.pilot.attempt.v1',
        instance_id: ref.instance_id,
        arm: 'stock',
        repeat: 0,
        status: statuses[i],
        passed: null,
        costUsd: 0.05,
        patchRelPath: `patches/${bases[i]}.patch`,
        ...(statuses[i] === 'grade-error' ? { error: 'docker was down' } : {}),
      }));
    }

    const run = runPilot([
      '--out', outDir,
      '--instances', JSON.stringify(refs),
      '--arms-file', armsFile,
      '--max-turns', '20',
      '--grade-timeout-ms', '600000',
      '--retry-errors',
      '--max-new-solves', '2',
      '--solve-concurrency', '2',
      '--jinn-agent-bin', agentBin,
      '--upstream-repo-dir', upstreamDir,
    ]);

    expect(run.status).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    for (const base of bases) {
      const updated = JSON.parse(readFileSync(join(outDir, 'attempts', `${base}.json`), 'utf-8')) as { status: string; passed: boolean | null };
      expect(updated.status).toBe('graded');
      expect(updated.passed).toBe(true);
    }
  });

  it('accepts a configurable arms file and runs one attempt per arm', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-run-arms-'));
    const armsFile = join(outDir, 'arms.json');
    writeFileSync(armsFile, JSON.stringify([
      { name: 'stock', skills: [] },
      { name: 'mini', skills: ['mini-skill'], jinnAgentHome: '/tmp/mini-home' },
      { name: 'gpt55', skills: ['gpt55-skill'], jinnAgentHome: '/tmp/gpt55-home' },
    ]));

    const run = runPilot([
      '--dry-run',
      '--out', outDir,
      '--arms-file', armsFile,
      '--max-new-solves', '3',
    ]);

    expect(run.status).toBe(0);
    expect(attemptCount(outDir)).toBe(3);
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8')) as {
      semanticConfig: { arms: Array<{ name: string; skills: string[]; jinnAgentHome?: string }> };
    };
    expect(manifest.semanticConfig.arms).toEqual([
      { name: 'stock', skills: [] },
      { name: 'mini', skills: ['mini-skill'] },
      { name: 'gpt55', skills: ['gpt55-skill'] },
    ]);
  });
});
