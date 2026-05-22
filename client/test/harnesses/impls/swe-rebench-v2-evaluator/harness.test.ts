import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SweRebenchV2EvaluatorHarness } from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import { HttpHfFetcher } from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import type { Task } from '../../../../src/types/task.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import {
  ValidatedPoolStore,
  EVAL_SEMANTICS_VERSION,
  type ValidatedPoolEntry,
} from '../../../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { computeRowHash } from '../../../../src/solver-types/_swe-rebench-v2-substrate.js';

function makeImplStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'swe-rebench-v2-evaluator-test-'));
}

function makeEnabledMarker(implStateDir: string, upstreamRepoDir: string): void {
  mkdirSync(upstreamRepoDir, { recursive: true });
  writeFileSync(
    join(implStateDir, 'state.json'),
    JSON.stringify({
      schemaVersion: 'swe-rebench-v2-evaluator-state.v1',
      enabled: true,
      enabledAt: '2026-05-07T00:00:00Z',
      upstreamRepoDir,
    }),
  );
}

function buildEvaluationTask(restorationEnvelopeJson: string): Task {
  return {
    id: 'eval-task-1',
    description: 'evaluate swe-rebench-v2',
    solverType: 'swe-rebench-v2.v1',
    role: 'evaluation',
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: 'unidata__netcdf-c-1925',
      repo: 'Unidata/netcdf-c',
      base_commit: 'ad6bff35c39a0600fb8f2e176be4269e768e4e22',
      language: 'c',
      problem_statement: 'tst_filter does not handle quoted filter args correctly',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      deadline_unix: 1746547200,
      round_month: '2026-05',
    },
    context: { restorationResult: restorationEnvelopeJson },
  };
}

function buildSolverEnvelope(overrides: Record<string, unknown> = {}): string {
  // Syntactically-valid SignedEnvelope (jinn.execution.v1) for a swe-rebench-v2
  // solution. The harness does not verify signature integrity in v1 — it
  // parses the envelope, asserts solverType+role, and passes the payload to
  // the grading library. We hand-roll a fixed-shape signed envelope here.
  const base = {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'swe-rebench-v2.v1',
    role: 'solution',
    generatedAt: Date.parse('2026-05-08T00:00:00.000Z'),
    task: {
      cid: 'bafy-task',
      onchainCreationTx: `0x${'0'.repeat(64)}`,
      onchainCreationBlock: 1,
      requestId: `0x${'1'.repeat(64)}`,
    },
    participant: {
      safeAddress: `0x${'2'.repeat(40)}`,
      agentEoa: `0x${'3'.repeat(40)}`,
    },
    window: { startTs: Date.parse('2026-05-08T00:00:00.000Z'), endTs: Date.parse('2026-05-15T00:00:00.000Z') },
    executor: {
      implName: 'claude-code-learner',
      implVersion: '1.0.0',
      clientGitSha: 'dev',
      codeDigest: `sha256:${'0'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'1'.repeat(64)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa' as const, pubkey: `0x${'3'.repeat(40)}` },
      mode: 'train' as const,
    },
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-hello\n+world\n',
    },
    signature: {
      algo: 'secp256k1' as const,
      signer: `0x${'3'.repeat(40)}`,
      hash: `0x${'4'.repeat(64)}`,
      sig: `0x${'5'.repeat(130)}`,
    },
    ...overrides,
  };
  return JSON.stringify(base);
}

function buildHarnessContext(implStateDir: string, task: Task): HarnessContext {
  return {
    task,
    implStateDir,
    workingDir: implStateDir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => undefined } as unknown as HarnessContext['trajectory'],
    mode: 'train',
  };
}

/**
 * Seed an admission entry into `stateDir`'s ValidatedPoolStore.
 * Pre-existing tests use a scorable entry without `rowHash`/`imageDigest` so
 * the substrate-drift checks are skipped and the normal grading path runs.
 */
async function seedAdmission(
  stateDir: string,
  instanceId: string,
  entry: Partial<ValidatedPoolEntry> & { scorable: boolean },
): Promise<void> {
  const store = new ValidatedPoolStore({ stateDir });
  await store.record(
    instanceId,
    {
      reason: 'gold-patch-resolves',
      checkedAt: new Date().toISOString(),
      ...entry,
    },
    EVAL_SEMANTICS_VERSION,
  );
}

describe('SweRebenchV2EvaluatorHarness — supports + canAttempt', () => {
  it('claims solverType=swe-rebench-v2.v1 with role=evaluation only', () => {
    const h = new SweRebenchV2EvaluatorHarness();
    expect(h.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(true);
    expect(h.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(false);
    expect(h.supports({ solverType: 'prediction.v1', role: 'evaluation' })).toBe(false);
  });

  it('canAttempt rejects non-evaluation tasks', async () => {
    const h = new SweRebenchV2EvaluatorHarness();
    const task = buildEvaluationTask('{}');
    task.role = 'restoration';
    const r = await h.canAttempt(task);
    expect(r).toEqual({ ok: false, reason: 'role is not evaluation' });
  });

  it('canAttempt rejects tasks missing context.restorationResult', async () => {
    const h = new SweRebenchV2EvaluatorHarness();
    const task = buildEvaluationTask('{}');
    delete (task.context as Record<string, unknown>)['restorationResult'];
    const r = await h.canAttempt(task);
    expect(r).toEqual({ ok: false, reason: 'context.restorationResult required' });
  });
});

describe('SweRebenchV2EvaluatorHarness — isReady', () => {
  let implStateDir: string;
  beforeEach(() => {
    implStateDir = makeImplStateDir();
  });
  afterEach(() => {
    rmSync(implStateDir, { recursive: true, force: true });
  });

  it('reports requires-live-daemon in stub mode', async () => {
    const h = new SweRebenchV2EvaluatorHarness({ stub: true });
    const r = await h.isReady();
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('requires live daemon');
  });

  it('reports not-enabled when state file is absent', async () => {
    const h = new SweRebenchV2EvaluatorHarness({ implStateDir });
    const r = await h.isReady();
    expect(r.ready).toBe(false);
    expect(r.nextStep?.cli).toBe('jinn harnesses enable swe-rebench-v2-evaluator');
  });

  it('reports not-enabled when implStateDir not configured', async () => {
    const h = new SweRebenchV2EvaluatorHarness({});
    const r = await h.isReady();
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('implStateDir not configured');
  });

  function dockerOk() {
    return vi.fn(async (bin: string) =>
      bin === 'docker'
        ? { exitCode: 0, stdout: 'Server Version: 27.0.0', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    );
  }

  it('reports ready when state file + upstream repo are present and Docker is reachable', async () => {
    makeEnabledMarker(implStateDir, join(implStateDir, 'upstream'));
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand: dockerOk() },
    });
    const r = await h.isReady();
    expect(r.ready).toBe(true);
  });

  it('reports not-ready when Docker is unreachable, even with a valid enable marker', async () => {
    makeEnabledMarker(implStateDir, join(implStateDir, 'upstream'));
    const runCommand = vi.fn(async (bin: string) =>
      bin === 'docker'
        ? { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.' }
        : { exitCode: 0, stdout: '', stderr: '' },
    );
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand },
    });
    const r = await h.isReady();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/docker/i);
    expect(r.nextStep?.description).toMatch(/docker/i);
    expect(runCommand).toHaveBeenCalledWith('docker', ['info']);
  });

  it('caches the docker info probe across rapid isReady() calls (claim-loop hot path)', async () => {
    makeEnabledMarker(implStateDir, join(implStateDir, 'upstream'));
    const runCommand = vi.fn(async (bin: string) =>
      bin === 'docker' ? { exitCode: 0, stdout: 'ok', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' },
    );
    const h = new SweRebenchV2EvaluatorHarness({ implStateDir, _testDeps: { runCommand } });
    for (let i = 0; i < 25; i++) {
      const r = await h.isReady();
      expect(r.ready).toBe(true);
    }
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('reports not-ready when upstream repo dir is missing despite a marker', async () => {
    // Marker pointing at a non-existent dir.
    writeFileSync(
      join(implStateDir, 'state.json'),
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-evaluator-state.v1',
        enabled: true,
        enabledAt: '2026-05-07T00:00:00Z',
        upstreamRepoDir: join(implStateDir, 'does-not-exist'),
      }),
    );
    const h = new SweRebenchV2EvaluatorHarness({ implStateDir });
    const r = await h.isReady();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/upstream repo missing/);
  });
});

describe('SweRebenchV2EvaluatorHarness — onEnable', () => {
  let implStateDir: string;
  beforeEach(() => {
    implStateDir = makeImplStateDir();
  });
  afterEach(() => {
    rmSync(implStateDir, { recursive: true, force: true });
  });

  function makeRunCommand(impl: (bin: string, args: string[]) => { exitCode: number; stdout?: string; stderr?: string }) {
    return vi.fn(async (bin: string, args: string[]) => {
      const r = impl(bin, args);
      return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    });
  }

  it('fails fast when implStateDir is not configured', async () => {
    const h = new SweRebenchV2EvaluatorHarness();
    const r = await h.onEnable({ args: {}, runtimePlugins: [] });
    expect(r.status).toBe('error');
  });

  it('returns waiting_for_external_action when Docker is unreachable', async () => {
    const runCommand = makeRunCommand((bin) => {
      if (bin === 'docker') return { exitCode: 1, stderr: 'cannot connect' };
      return { exitCode: 0 };
    });
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand },
    });
    const r = await h.onEnable({ args: {}, runtimePlugins: [] });
    expect(r.status).toBe('waiting_for_external_action');
    if (r.status === 'waiting_for_external_action') {
      expect(r.action.description).toMatch(/Docker daemon/);
    }
    expect(runCommand).toHaveBeenCalledWith('docker', ['info']);
  });

  it('returns waiting_for_external_action when Python is missing', async () => {
    const runCommand = makeRunCommand((bin) => {
      if (bin === 'docker') return { exitCode: 0 };
      if (bin === 'python3') return { exitCode: 127, stderr: 'not found' };
      return { exitCode: 0 };
    });
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand },
    });
    const r = await h.onEnable({ args: {}, runtimePlugins: [] });
    expect(r.status).toBe('waiting_for_external_action');
    if (r.status === 'waiting_for_external_action') {
      expect(r.action.description).toMatch(/Python 3/);
    }
  });

  it('clones the upstream repo + writes a state marker on first successful enable', async () => {
    const runCommand = makeRunCommand((bin, args) => {
      if (bin === 'docker') return { exitCode: 0 };
      if (bin === 'python3') return { exitCode: 0, stdout: 'Python 3.12.0' };
      if (bin === 'git' && args[0] === 'clone') {
        // Simulate clone by creating the target dir.
        mkdirSync(args[args.length - 1]!, { recursive: true });
        return { exitCode: 0 };
      }
      return { exitCode: 0 };
    });
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand },
    });
    const r = await h.onEnable({ args: {}, runtimePlugins: [] });
    expect(r.status).toBe('ready');
    if (r.status === 'ready') {
      expect(r.details?.['upstreamRepoDir']).toBe(join(implStateDir, 'upstream'));
    }
    expect(existsSync(join(implStateDir, 'state.json'))).toBe(true);
    const state = JSON.parse(readFileSync(join(implStateDir, 'state.json'), 'utf8'));
    expect(state.enabled).toBe(true);
    expect(state.upstreamRepoDir).toBe(join(implStateDir, 'upstream'));
    // Idempotent: a second invocation does not re-clone.
    runCommand.mockClear();
    const r2 = await h.onEnable({ args: {}, runtimePlugins: [] });
    expect(r2.status).toBe('ready');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('surfaces a clone failure as status=error', async () => {
    const runCommand = makeRunCommand((bin, args) => {
      if (bin === 'docker' || bin === 'python3') return { exitCode: 0 };
      if (bin === 'git' && args[0] === 'clone') {
        return { exitCode: 128, stderr: 'fatal: unable to access repository' };
      }
      return { exitCode: 0 };
    });
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand },
    });
    const r = await h.onEnable({ args: {}, runtimePlugins: [] });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.message).toMatch(/git clone failed/);
    }
  });
});

describe('SweRebenchV2EvaluatorHarness — run', () => {
  let implStateDir: string;
  beforeEach(async () => {
    implStateDir = makeImplStateDir();
    makeEnabledMarker(implStateDir, join(implStateDir, 'upstream'));
    // Seed a scorable admission without rowHash/imageDigest so the substrate-
    // drift checks are skipped and normal grading proceeds. Tests that
    // specifically exercise substrate-recheck behavior live in the separate
    // describe block below and seed their own admission entries.
    await seedAdmission(implStateDir, 'unidata__netcdf-c-1925', { scorable: true });
  });
  afterEach(() => {
    rmSync(implStateDir, { recursive: true, force: true });
  });

  function makeFakeFetcher(image_name = 'docker.io/swerebenchv2/test:latest') {
    return {
      fetchTaskRow: vi.fn().mockResolvedValue({
        instance_id: 'unidata__netcdf-c-1925',
        repo: 'Unidata/netcdf-c',
        image_name,
        FAIL_TO_PASS: ['test_a'],
        PASS_TO_PASS: ['test_b'],
        test_patch: 'diff --git ...',
        install_config: { test_cmd: 'make test', log_parser: 'pytest' },
      }),
    };
  }

  it('returns score=1 + passed_match=true and pins test_log to IPFS on a passing run', async () => {
    const uploadToIpfs = vi
      .fn()
      .mockResolvedValue('bafy-test-log-cid');
    const runner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: true,
        passed: ['test_a', 'test_b'],
        failed: [],
        log: 'all green',
        exitCode: 0,
      }),
    };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { fetcher: makeFakeFetcher(), runner, uploadToIpfs, stateDir: implStateDir },
    });
    const ctx = buildHarnessContext(
      implStateDir,
      buildEvaluationTask(buildSolverEnvelope()),
    );

    const sol = await harness.run(ctx);

    // gating MUST include `verdict` ('PASS'|'FAIL') — the engine's reputation
    // feedback hook keys on this field (jinn-mono-uy6v.10). passed_match=true
    // → 'PASS'; passed_match=false → 'FAIL'.
    expect(sol.gating).toEqual({ score: 1, passed_match: true, verdict: 'PASS' });
    expect(sol.verdictPayload).toMatchObject({
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: 1,
      passed_match: true,
      evaluator_cost_usd: 0,
    });
    expect(sol.verdictPayload).not.toHaveProperty('test_log_cid');
    // The pinned-blob CID is surfaced as artifact metadata, not as a typed
    // payload field — preserves the solver/daemon boundary in the schema.
    const verdictArtifact = sol.artifacts?.[0];
    expect(verdictArtifact?.path).toBe('swe-rebench-v2-verdict.json');
    const verdictArtifactPayload = JSON.parse(
      readFileSync(join(ctx.workingDir, 'swe-rebench-v2-verdict.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(verdictArtifactPayload).toMatchObject({
      schemaVersion: 'swe-rebench-v2-verdict-artifact.v1',
      verdict: {
        schemaVersion: 'swe-rebench-v2-verdict.v1',
        score: 1,
        passed_match: true,
      },
      informational: {
        instance_id: 'unidata__netcdf-c-1925',
        test_log_cid: 'bafy-test-log-cid',
      },
    });
    expect(verdictArtifact?.metadata).toMatchObject({
      score: 1,
      passed_match: true,
      test_log_cid: 'bafy-test-log-cid',
    });
    expect(sol.informational).toMatchObject({ test_log_cid: 'bafy-test-log-cid' });
    // Pinned blob includes the log + instance_id.
    expect(uploadToIpfs).toHaveBeenCalledTimes(1);
    const [, pinned] = uploadToIpfs.mock.calls[0]!;
    expect(pinned).toMatchObject({
      kind: 'swe-rebench-v2-test-log.v1',
      instance_id: 'unidata__netcdf-c-1925',
      log: 'all green',
    });
  });

  it('returns score=0 when the test suite fails', async () => {
    const runner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: false,
        passed: [],
        failed: ['test_a'],
        log: 'test_a failed',
        exitCode: 1,
      }),
    };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: {
        fetcher: makeFakeFetcher(),
        runner,
        uploadToIpfs: vi.fn().mockResolvedValue('bafy-fail-log'),
        stateDir: implStateDir,
      },
    });
    const ctx = buildHarnessContext(
      implStateDir,
      buildEvaluationTask(buildSolverEnvelope()),
    );
    const sol = await harness.run(ctx);
    expect((sol.verdictPayload as Record<string, unknown>)['score']).toBe(0);
    expect((sol.verdictPayload as Record<string, unknown>)['passed_match']).toBe(false);
    // Failing-grade gating MUST carry `verdict: 'FAIL'` so the engine's
    // reputation feedback hook records a 0-score on the harness's agent NFT
    // (jinn-mono-uy6v.10). Before this fix the field was missing and the hook
    // silently no-op'd on every verdict.
    expect(sol.gating).toEqual({ score: 0, passed_match: false, verdict: 'FAIL' });
  });

  it('does not produce a verdict when the eval could not grade the solution (skips instead)', async () => {
    const { EvalCouldNotGradeError } = await import(
      '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js'
    );
    const { SkippableError } = await import('../../../../src/harnesses/types.js');
    const uploadToIpfs = vi.fn().mockResolvedValue('bafy-should-not-be-called');
    const runner = {
      runEval: vi
        .fn()
        .mockRejectedValue(
          new EvalCouldNotGradeError(
            'docker_unavailable',
            'docker: Cannot connect to the Docker daemon',
          ),
        ),
    };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { fetcher: makeFakeFetcher(), runner, uploadToIpfs, stateDir: implStateDir },
    });
    const ctx = buildHarnessContext(
      implStateDir,
      buildEvaluationTask(buildSolverEnvelope()),
    );
    await expect(harness.run(ctx)).rejects.toBeInstanceOf(SkippableError);
    expect(uploadToIpfs).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.workingDir, 'swe-rebench-v2-verdict.json'))).toBe(false);
  });

  it('throws when the envelope is not swe-rebench-v2.v1/solution', async () => {
    const wrongEnvelope = buildSolverEnvelope({ solverType: 'prediction.v1' });
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: {
        fetcher: makeFakeFetcher(),
        runner: { runEval: vi.fn() },
        uploadToIpfs: vi.fn(),
        stateDir: implStateDir,
      },
    });
    const ctx = buildHarnessContext(implStateDir, buildEvaluationTask(wrongEnvelope));
    await expect(harness.run(ctx)).rejects.toThrow(/expected swe-rebench-v2\.v1\/solution/);
  });

  it('throws when the harness is not enabled', async () => {
    rmSync(join(implStateDir, 'state.json'));
    const harness = new SweRebenchV2EvaluatorHarness({ implStateDir });
    const ctx = buildHarnessContext(
      implStateDir,
      buildEvaluationTask(buildSolverEnvelope()),
    );
    await expect(harness.run(ctx)).rejects.toThrow(/not enabled/);
  });

  it('reuses a single EvalRunner across run() calls so per-round pruning fires on the shared runner (jinn-mono-uy6v.11)', async () => {
    // Regression: pre-fix, `new PythonEvalRunner(...)` was constructed inside
    // each `run()` call, so the in-process runner was rebuilt empty every
    // invocation and per-round pruning never fired in production. The
    // existing pruning tests didn't catch this because they exercise
    // PythonEvalRunner directly. This test pins the harness→runner wiring:
    // the runner factory must be invoked exactly once across multiple run()
    // calls, regardless of how many distinct tasks the harness grades.
    const makeRunner = vi.fn(() => ({
      runEval: vi.fn().mockResolvedValue({
        passed_match: true,
        passed: ['test_a', 'test_b'],
        failed: [],
        log: 'ok',
        exitCode: 0,
      }),
    }));
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: {
        fetcher: makeFakeFetcher(),
        makeRunner,
        uploadToIpfs: vi.fn().mockResolvedValue('bafy-test-log'),
        stateDir: implStateDir,
      },
    });
    const ctx1 = buildHarnessContext(
      implStateDir,
      buildEvaluationTask(buildSolverEnvelope()),
    );
    const ctx2 = buildHarnessContext(
      implStateDir,
      buildEvaluationTask(buildSolverEnvelope()),
    );
    await harness.run(ctx1);
    await harness.run(ctx2);
    expect(makeRunner).toHaveBeenCalledTimes(1);
    // The factory is also expected to receive the upstream repo dir from the
    // enabled state — guards against a future refactor that passes the wrong
    // path and silently creates a broken runner.
    expect(makeRunner).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamRepoDir: expect.any(String) }),
    );
    // Sanity: both runs actually invoked runEval — proves the harness is
    // exercising the cached runner, not falling back to anything else.
    const runner = makeRunner.mock.results[0]?.value as { runEval: ReturnType<typeof vi.fn> };
    expect(runner.runEval).toHaveBeenCalledTimes(2);
  });

  it('retries a transient HF 429 during substrate recheck and still emits a verdict', async () => {
    const hfRow = {
      instance_id: 'unidata__netcdf-c-1925',
      repo: 'Unidata/netcdf-c',
      image_name: 'docker.io/swerebenchv2/test:latest',
      FAIL_TO_PASS: ['test_a'],
      PASS_TO_PASS: ['test_b'],
      test_patch: 'diff --git ...',
      install_config: { test_cmd: 'make test', log_parser: 'pytest' },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        rows: [{ row: hfRow }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const fetcher = new HttpHfFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffMs: [0],
      minRequestIntervalMs: 0,
      sleep: vi.fn(async () => undefined),
    });
    const runner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: true,
        passed: ['test_a'],
        failed: [],
        log: 'ok after retry',
        exitCode: 0,
      }),
    };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: {
        fetcher,
        runner,
        uploadToIpfs: vi.fn().mockResolvedValue('bafy-retry-log'),
        stateDir: implStateDir,
      },
    });

    const sol = await harness.run(buildHarnessContext(
      implStateDir,
      buildEvaluationTask(buildSolverEnvelope()),
    ));

    expect(sol.gating).toMatchObject({ verdict: 'PASS' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(runner.runEval).toHaveBeenCalledTimes(1);
    expect(existsSync(join(implStateDir, 'swe-rebench-v2-verdict.json'))).toBe(true);
  });
});

describe('SweRebenchV2EvaluatorHarness — verdict-time substrate recheck', () => {
  const INSTANCE_ID = 'unidata__netcdf-c-1925';
  const IMAGE_NAME = 'docker.io/swerebenchv2/test:latest';
  const IMAGE_DIGEST = 'sha256:' + 'a'.repeat(64);
  const GOLD_PATCH = 'diff --git a/fix.c b/fix.c\n@@ -1 +1 @@\n-old\n+new\n';

  // A stub HF row returned by the fetcher during verdict-time recheck.
  const STUB_ROW = {
    instance_id: INSTANCE_ID,
    repo: 'Unidata/netcdf-c',
    image_name: IMAGE_NAME,
    FAIL_TO_PASS: ['test_a'],
    PASS_TO_PASS: ['test_b'],
    test_patch: 'diff --git ...',
    install_config: { test_cmd: 'make test', log_parser: 'pytest' },
  };

  // Precompute the rowHash that matches the stub row + gold patch + task fields.
  // This is the value that will be stored in the admission record and must
  // match what computeRowHash produces at verdict time.
  const MATCHING_ROW_HASH = computeRowHash({
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: '2026_02',
    instance_id: INSTANCE_ID,
    repo: 'Unidata/netcdf-c',
    base_commit: 'ad6bff35c39a0600fb8f2e176be4269e768e4e22',
    image_name: IMAGE_NAME,
    patch: GOLD_PATCH,
    test_patch: 'diff --git ...',
    install_config: { install: [], test_cmd: 'make test', log_parser: 'pytest' },
    FAIL_TO_PASS: ['test_a'],
    PASS_TO_PASS: ['test_b'],
  });

  // A pool-loader stub that returns the matching pool task with the gold patch.
  function makeMatchingPoolLoader() {
    return vi.fn().mockResolvedValue([{
      instance_id: INSTANCE_ID,
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      repo: 'Unidata/netcdf-c',
      base_commit: 'ad6bff35c39a0600fb8f2e176be4269e768e4e22',
      patch: GOLD_PATCH,
      test_patch: 'diff --git ...',
    }]);
  }

  // A runCommand stub that returns the matching image digest.
  function makeMatchingDockerInspect() {
    return vi.fn(async (bin: string, args: string[]) => {
      if (bin === 'docker' && args[0] === 'image') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([`${IMAGE_NAME}@${IMAGE_DIGEST}`]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
  }

  let implStateDir: string;
  let stateDir: string;

  beforeEach(() => {
    implStateDir = mkdtempSync(join(tmpdir(), 'swe-rebench-v2-recheck-impl-'));
    stateDir = mkdtempSync(join(tmpdir(), 'swe-rebench-v2-recheck-state-'));
    makeEnabledMarker(implStateDir, join(implStateDir, 'upstream'));
  });
  afterEach(() => {
    rmSync(implStateDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeHarness(deps: NonNullable<ConstructorParameters<typeof SweRebenchV2EvaluatorHarness>[0]['_testDeps']>) {
    return new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { stateDir, ...deps },
    });
  }

  function makeCtx() {
    return buildHarnessContext(implStateDir, buildEvaluationTask(buildSolverEnvelope()));
  }

  it('throws SkippableError when no admission entry exists for the instance', async () => {
    // stateDir is empty — no validated-pool.json at all.
    const { SkippableError } = await import('../../../../src/harnesses/types.js');
    const harness = makeHarness({
      fetcher: { fetchTaskRow: vi.fn() },
      runner: { runEval: vi.fn() },
      uploadToIpfs: vi.fn(),
    });
    await expect(harness.run(makeCtx())).rejects.toBeInstanceOf(SkippableError);
    await expect(harness.run(makeCtx())).rejects.toMatchObject({
      reason: 'admission_missing_or_unscorable',
    });
    // No verdict artifact should be written.
    expect(existsSync(join(implStateDir, 'swe-rebench-v2-verdict.json'))).toBe(false);
  });

  it('throws SkippableError when the admission entry is unscorable', async () => {
    await seedAdmission(stateDir, INSTANCE_ID, { scorable: false, reason: 'gold-patch-not-resolved' });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');
    const harness = makeHarness({
      fetcher: { fetchTaskRow: vi.fn() },
      runner: { runEval: vi.fn() },
      uploadToIpfs: vi.fn(),
    });
    await expect(harness.run(makeCtx())).rejects.toBeInstanceOf(SkippableError);
    await expect(harness.run(makeCtx())).rejects.toMatchObject({
      reason: 'admission_missing_or_unscorable',
    });
  });

  it('throws SkippableError when rowHash drifted between admission and verdict time', async () => {
    // Admission carries a rowHash that won't match current state.
    await seedAdmission(stateDir, INSTANCE_ID, {
      scorable: true,
      rowHash: 'sha256:' + 'dead'.repeat(16),  // arbitrary stale hash
    });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');
    const harness = makeHarness({
      fetcher: { fetchTaskRow: vi.fn().mockResolvedValue(STUB_ROW) },
      loadPool: makeMatchingPoolLoader(),
      runner: { runEval: vi.fn() },
      uploadToIpfs: vi.fn(),
    });
    const err = await harness.run(makeCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(SkippableError);
    expect(err.reason).toBe('substrate_drift_rowHash');
    expect(existsSync(join(implStateDir, 'swe-rebench-v2-verdict.json'))).toBe(false);
  });

  it('throws SkippableError when imageDigest drifted', async () => {
    const differentDigest = 'sha256:' + 'b'.repeat(64);
    // Admission carries imageDigest X; resolveImageDigest returns Y.
    await seedAdmission(stateDir, INSTANCE_ID, {
      scorable: true,
      // No rowHash — skip the rowHash check so we reach the imageDigest check.
      imageDigest: differentDigest,
    });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');
    // runCommand returns the matching IMAGE_DIGEST (different from what's stored in admission).
    const harness = makeHarness({
      fetcher: { fetchTaskRow: vi.fn().mockResolvedValue(STUB_ROW) },
      runCommand: makeMatchingDockerInspect() as unknown as typeof import('../../../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js').runCommand,
      runner: { runEval: vi.fn() },
      uploadToIpfs: vi.fn(),
    });
    const err = await harness.run(makeCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(SkippableError);
    expect(err.reason).toBe('substrate_drift_imageDigest');
    expect(existsSync(join(implStateDir, 'swe-rebench-v2-verdict.json'))).toBe(false);
  });

  it('throws SkippableError with reason hf_fetch_failed when the HF row fetch fails', async () => {
    // Seed a scorable admission (no rowHash/imageDigest so only the HF fetch matters).
    await seedAdmission(stateDir, INSTANCE_ID, { scorable: true });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');
    const harness = makeHarness({
      fetcher: {
        fetchTaskRow: vi.fn().mockRejectedValue(new Error('HF datasets-server unavailable')),
      },
      runner: { runEval: vi.fn() },
      uploadToIpfs: vi.fn(),
    });
    const err = await harness.run(makeCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(SkippableError);
    expect(err.reason).toBe('hf_fetch_failed');
    expect(err.message).toMatch(/HF unreachable/);
    // No verdict artifact should be written.
    expect(existsSync(join(implStateDir, 'swe-rebench-v2-verdict.json'))).toBe(false);
  });

  it('grades normally when admission entry matches current substrate', async () => {
    // Seed an admission with both rowHash and imageDigest matching current state.
    await seedAdmission(stateDir, INSTANCE_ID, {
      scorable: true,
      rowHash: MATCHING_ROW_HASH,
      imageDigest: IMAGE_DIGEST,
    });
    const runner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: true,
        passed: ['test_a'],
        failed: [],
        log: 'ok',
        exitCode: 0,
      }),
    };
    const harness = makeHarness({
      fetcher: { fetchTaskRow: vi.fn().mockResolvedValue(STUB_ROW) },
      loadPool: makeMatchingPoolLoader(),
      runCommand: makeMatchingDockerInspect() as unknown as typeof import('../../../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js').runCommand,
      runner,
      uploadToIpfs: vi.fn().mockResolvedValue('bafy-ok'),
    });
    const sol = await harness.run(makeCtx());
    expect(sol.gating).toMatchObject({ verdict: 'PASS' });
    // Confirm the runner was actually invoked (grading happened).
    expect(runner.runEval).toHaveBeenCalledTimes(1);
  });

  it('loads the evaluator pool once and shares it across run() calls', async () => {
    await seedAdmission(stateDir, INSTANCE_ID, {
      scorable: true,
      rowHash: MATCHING_ROW_HASH,
    });
    const loadPool = makeMatchingPoolLoader();
    const runner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: true,
        passed: ['test_a'],
        failed: [],
        log: 'ok',
        exitCode: 0,
      }),
    };
    const harness = makeHarness({
      fetcher: { fetchTaskRow: vi.fn().mockResolvedValue(STUB_ROW) },
      loadPool,
      runner,
      uploadToIpfs: vi.fn().mockResolvedValue('bafy-ok'),
    });

    await harness.run(makeCtx());
    await harness.run(makeCtx());

    expect(loadPool).toHaveBeenCalledTimes(1);
    expect(runner.runEval).toHaveBeenCalledTimes(2);
  });
});
