import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  SweRebenchV2EvaluatorHarness,
  applyUpstreamPatches,
  inspectCurrentSweRebenchV2EvaluatorEnableContract,
} from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import { HttpHfFetcher } from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import type { Task } from '../../../../src/types/task.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import {
  ValidatedPoolStore,
  EVAL_SEMANTICS_VERSION,
  createVettedPoolArtifactRef,
  hashVettedPoolArtifact,
  type ValidatedPoolEntry,
  type SweRebenchV2VettedPoolArtifact,
} from '../../../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { computeRowHash } from '../../../../src/solver-types/_swe-rebench-v2-substrate.js';
import { RoutingTaskRowFetcher } from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/routing-task-row-fetcher.js';
import {
  computeMintedPoolRowV2Hash,
  type MintedPoolRowV2,
  type SweRebenchV2MintedPoolArtifactV2,
} from '../../../../src/solver-types/_swe-rebench-v2-minted-pool.js';
import {
  environmentAttestationMessageV1,
  hashTaskEnvironmentSpecV1,
  type TaskEnvironmentSpecV1,
} from '../../../../src/task-creator/environment/contracts.js';
import {
  createDifferentialAdmissionReceiptV2,
  hashDifferentialAdmissionReceiptV2,
} from '../../../../src/solver-types/_swe-rebench-v2-differential-admission.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function makeDurableEnabledMarker(implStateDir: string, upstreamRepoDir: string): void {
  const bundleSha256 = `sha256:${createHash('sha256')
    .update(readFileSync(join(process.cwd(), 'scripts', 'swe-rebench-v2-evaluator.bundle.v1.patch')))
    .digest('hex')}`;
  mkdirSync(upstreamRepoDir, { recursive: true });
  writeFileSync(
    join(implStateDir, 'state.json'),
    JSON.stringify({
      schemaVersion: 'swe-rebench-v2-evaluator-state.v2',
      enabled: true,
      enabledAt: '2026-07-10T00:00:00Z',
      upstreamRepoDir,
      upstream: {
        repoUrl: 'https://github.com/SWE-rebench/SWE-rebench-V2.git',
        commit: 'c71902a8cf8d2b725f63d51f199f4d3e56f68d2d',
      },
      patchBundle: {
        id: 'jinn.swe-rebench-v2.patch-bundle.v1',
        version: 'v1',
        sha256: bundleSha256,
      },
      trustedParsers: [{
        id: 'vitest-json.v1',
        version: 'v1',
        bundleId: 'jinn.swe-rebench-v2.patch-bundle.v1',
        bundleSha256,
      }],
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
    makeDurableEnabledMarker(implStateDir, join(implStateDir, 'upstream'));
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand: dockerOk() },
    });
    const r = await h.isReady();
    expect(r.ready).toBe(true);
  });

  it('reports not-ready when Docker is unreachable, even with a valid enable marker', async () => {
    makeDurableEnabledMarker(implStateDir, join(implStateDir, 'upstream'));
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

  it('reports not-ready when a v2 marker has stale pinned metadata', async () => {
    const upstreamRepoDir = join(implStateDir, 'upstream');
    makeDurableEnabledMarker(implStateDir, upstreamRepoDir);
    const markerPath = join(implStateDir, 'state.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.upstream.commit = '0'.repeat(40);
    writeFileSync(markerPath, JSON.stringify(marker));
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand: dockerOk() },
    });

    const r = await h.isReady();

    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/repair/i);
    expect(r.nextStep?.cli).toBe('jinn harnesses enable swe-rebench-v2-evaluator');
  });

  it('reports not-ready when the persisted bundle hash differs from the current asset', async () => {
    const upstreamRepoDir = join(implStateDir, 'upstream');
    makeDurableEnabledMarker(implStateDir, upstreamRepoDir);
    const markerPath = join(implStateDir, 'state.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.patchBundle.sha256 = `sha256:${'f'.repeat(64)}`;
    marker.trustedParsers[0].bundleSha256 = marker.patchBundle.sha256;
    writeFileSync(markerPath, JSON.stringify(marker));
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand: dockerOk() },
    });

    const r = await h.isReady();

    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/repair/i);
  });

  it('treats malformed v2 parser metadata as not-ready rather than throwing', async () => {
    const upstreamRepoDir = join(implStateDir, 'upstream');
    makeDurableEnabledMarker(implStateDir, upstreamRepoDir);
    const markerPath = join(implStateDir, 'state.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.trustedParsers = { not: 'an array' };
    writeFileSync(markerPath, JSON.stringify(marker));
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand: dockerOk() },
    });

    await expect(h.isReady()).resolves.toMatchObject({ ready: false });
  });

  it('caches the docker info probe across rapid isReady() calls (claim-loop hot path)', async () => {
    makeDurableEnabledMarker(implStateDir, join(implStateDir, 'upstream'));
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
        upstreamRepoDir: join(implStateDir, 'upstream'),
      }),
    );
    const h = new SweRebenchV2EvaluatorHarness({ implStateDir });
    const r = await h.isReady();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/upstream repo missing/);
  });
});

describe('current evaluator enable contract — Docker-free validation', () => {
  let implStateDir: string;
  beforeEach(() => {
    implStateDir = makeImplStateDir();
  });
  afterEach(() => {
    rmSync(implStateDir, { recursive: true, force: true });
  });

  it('rejects a structurally valid v1 marker with the re-enable instruction', () => {
    makeEnabledMarker(implStateDir, join(implStateDir, 'upstream'));

    const result = inspectCurrentSweRebenchV2EvaluatorEnableContract(implStateDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected current-contract rejection');
    expect(result.reason).toMatch(/durable bundle repair/i);
    expect(result.nextStep).toContain('jinn harnesses enable swe-rebench-v2-evaluator');
  });

  it.each([
    ['pinned upstream commit', (marker: any) => {
      marker.upstream.commit = '0'.repeat(40);
    }],
    ['patch bundle digest', (marker: any) => {
      marker.patchBundle.sha256 = `sha256:${'f'.repeat(64)}`;
    }],
    ['trusted parser binding', (marker: any) => {
      marker.trustedParsers[0].bundleSha256 = `sha256:${'e'.repeat(64)}`;
    }],
  ])('rejects stale v2 %s metadata', (_label, mutate) => {
    const upstreamRepoDir = join(implStateDir, 'upstream');
    makeDurableEnabledMarker(implStateDir, upstreamRepoDir);
    const markerPath = join(implStateDir, 'state.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    mutate(marker);
    writeFileSync(markerPath, JSON.stringify(marker));

    const result = inspectCurrentSweRebenchV2EvaluatorEnableContract(implStateDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected stale-contract rejection');
    expect(result.reason).toMatch(/durable bundle repair/i);
  });

  it('accepts the current v2 marker, managed checkout, bundle, and parser binding', () => {
    const upstreamRepoDir = join(implStateDir, 'upstream');
    makeDurableEnabledMarker(implStateDir, upstreamRepoDir);

    const result = inspectCurrentSweRebenchV2EvaluatorEnableContract(implStateDir);

    expect(result).toEqual({ ok: true, upstreamRepoDir });
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
    // applyUpstreamPatches is exercised for real (against real upstream
    // content) in the dedicated 'applyUpstreamPatches' describe block below;
    // stub it here so this test stays focused on the clone/marker flow.
    const applyUpstreamPatches = vi.fn();
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand, applyUpstreamPatches },
    });
    const r = await h.onEnable({ args: {}, runtimePlugins: [] });
    expect(r.status).toBe('ready');
    if (r.status === 'ready') {
      expect(r.details?.['upstreamRepoDir']).toBe(join(implStateDir, 'upstream'));
    }
    expect(applyUpstreamPatches).toHaveBeenCalledWith(join(implStateDir, 'upstream'));
    expect(existsSync(join(implStateDir, 'state.json'))).toBe(true);
    const state = JSON.parse(readFileSync(join(implStateDir, 'state.json'), 'utf8'));
    expect(state.enabled).toBe(true);
    expect(state.upstreamRepoDir).toBe(join(implStateDir, 'upstream'));
    // Idempotent: a second invocation does not re-clone, but does repeat the
    // lightweight Python self-test before reporting ready.
    runCommand.mockClear();
    const r2 = await h.onEnable({ args: {}, runtimePlugins: [] });
    expect(r2.status).toBe('ready');
    expect(runCommand.mock.calls.filter(([bin]) => bin === 'git')).toHaveLength(0);
    expect(runCommand).toHaveBeenCalledWith(
      'python3',
      ['-c', expect.stringContaining('vitest-json.v1')],
      { cwd: join(implStateDir, 'upstream') },
    );
  });

  it('pins, patches, self-tests, and records the durable evaluator bundle on enable', async () => {
    const upstreamRepoDir = join(implStateDir, 'upstream');
    const runCommand = makeRunCommand((bin) => {
      if (bin === 'docker' || bin === 'python3' || bin === 'git') return { exitCode: 0 };
      return { exitCode: 0 };
    });
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand, applyUpstreamPatches: vi.fn() },
    });

    const r = await h.onEnable({ args: {}, runtimePlugins: [] });

    expect(r.status).toBe('ready');
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      [
        'clone',
        '--no-checkout',
        'https://github.com/SWE-rebench/SWE-rebench-V2.git',
        upstreamRepoDir,
      ],
    );
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      ['fetch', '--depth=1', 'origin', 'c71902a8cf8d2b725f63d51f199f4d3e56f68d2d'],
      { cwd: upstreamRepoDir },
    );
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      ['checkout', '--detach', '--force', 'c71902a8cf8d2b725f63d51f199f4d3e56f68d2d'],
      { cwd: upstreamRepoDir },
    );
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      ['apply', '--check', expect.stringContaining('swe-rebench-v2-evaluator.bundle.v1.patch')],
      { cwd: upstreamRepoDir },
    );
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      ['apply', expect.stringContaining('swe-rebench-v2-evaluator.bundle.v1.patch')],
      { cwd: upstreamRepoDir },
    );
    expect(runCommand).toHaveBeenCalledWith(
      'python3',
      ['-c', expect.stringContaining('vitest-json.v1')],
      { cwd: upstreamRepoDir },
    );

    const state = JSON.parse(readFileSync(join(implStateDir, 'state.json'), 'utf8'));
    expect(state).toMatchObject({
      schemaVersion: 'swe-rebench-v2-evaluator-state.v2',
      enabled: true,
      upstreamRepoDir,
      upstream: {
        commit: 'c71902a8cf8d2b725f63d51f199f4d3e56f68d2d',
      },
      patchBundle: {
        id: 'jinn.swe-rebench-v2.patch-bundle.v1',
        version: 'v1',
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      trustedParsers: [
        {
          id: 'vitest-json.v1',
          version: 'v1',
        },
      ],
    });
  });

  it('repairs a legacy enable marker before returning ready', async () => {
    const upstreamRepoDir = join(implStateDir, 'upstream');
    makeEnabledMarker(implStateDir, upstreamRepoDir);
    const runCommand = makeRunCommand((bin) => {
      if (bin === 'docker' || bin === 'python3' || bin === 'git') return { exitCode: 0 };
      return { exitCode: 0 };
    });
    const h = new SweRebenchV2EvaluatorHarness({ implStateDir, _testDeps: { runCommand, applyUpstreamPatches: vi.fn() } });

    const r = await h.onEnable({ args: {}, runtimePlugins: [] });

    expect(r.status).toBe('ready');
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      ['reset', '--hard', 'c71902a8cf8d2b725f63d51f199f4d3e56f68d2d'],
      { cwd: upstreamRepoDir },
    );
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      ['apply', expect.stringContaining('swe-rebench-v2-evaluator.bundle.v1.patch')],
      { cwd: upstreamRepoDir },
    );
    const state = JSON.parse(readFileSync(join(implStateDir, 'state.json'), 'utf8'));
    expect(state.schemaVersion).toBe('swe-rebench-v2-evaluator-state.v2');
  });

  it('repairs an external stale marker without running git in its referenced directory', async () => {
    const externalRepoDir = mkdtempSync(join(tmpdir(), 'swe-rebench-v2-external-'));
    try {
      makeEnabledMarker(implStateDir, externalRepoDir);
      const managedRepoDir = join(implStateDir, 'upstream');
      const runCommand = makeRunCommand((bin, args) => {
        if (bin === 'git' && args[0] === 'clone') {
          mkdirSync(args[args.length - 1]!, { recursive: true });
        }
        return { exitCode: 0 };
      });
      const h = new SweRebenchV2EvaluatorHarness({ implStateDir, _testDeps: { runCommand, applyUpstreamPatches: vi.fn() } });

      const r = await h.onEnable({ args: {}, runtimePlugins: [] });

      expect(r.status).toBe('ready');
      expect(runCommand).toHaveBeenCalledWith(
        'git',
        ['clone', '--no-checkout', 'https://github.com/SWE-rebench/SWE-rebench-V2.git', managedRepoDir],
      );
      const gitWorkingDirs = runCommand.mock.calls
        .filter(([bin]) => bin === 'git')
        .map(([, , opts]) => (opts as { cwd?: string } | undefined)?.cwd);
      expect(gitWorkingDirs).not.toContain(externalRepoDir);
      expect(gitWorkingDirs).toContain(managedRepoDir);
    } finally {
      rmSync(externalRepoDir, { recursive: true, force: true });
    }
  });

  it('repairs malformed v2 parser metadata instead of throwing', async () => {
    const upstreamRepoDir = join(implStateDir, 'upstream');
    makeDurableEnabledMarker(implStateDir, upstreamRepoDir);
    const markerPath = join(implStateDir, 'state.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.trustedParsers = {};
    writeFileSync(markerPath, JSON.stringify(marker));
    const runCommand = makeRunCommand((bin) => {
      if (bin === 'docker' || bin === 'python3' || bin === 'git') return { exitCode: 0 };
      return { exitCode: 0 };
    });
    const h = new SweRebenchV2EvaluatorHarness({ implStateDir, _testDeps: { runCommand, applyUpstreamPatches: vi.fn() } });

    await expect(h.onEnable({ args: {}, runtimePlugins: [] })).resolves.toMatchObject({ status: 'ready' });
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      ['reset', '--hard', 'c71902a8cf8d2b725f63d51f199f4d3e56f68d2d'],
      { cwd: upstreamRepoDir },
    );
  });

  it('does not mark the evaluator ready when the patched upstream self-test fails', async () => {
    const upstreamRepoDir = join(implStateDir, 'upstream');
    const runCommand = makeRunCommand((bin, args) => {
      if (bin === 'docker') return { exitCode: 0 };
      if (bin === 'python3' && args[0] === '-c') return { exitCode: 1, stderr: 'parser missing' };
      return { exitCode: 0 };
    });
    const h = new SweRebenchV2EvaluatorHarness({ implStateDir, _testDeps: { runCommand } });

    const r = await h.onEnable({ args: {}, runtimePlugins: [] });

    expect(r).toMatchObject({ status: 'error' });
    expect(existsSync(join(implStateDir, 'state.json'))).toBe(false);
  });

  it('surfaces an upstream-patch failure as status=error', async () => {
    const runCommand = makeRunCommand((bin, args) => {
      if (bin === 'docker') return { exitCode: 0 };
      if (bin === 'python3') return { exitCode: 0, stdout: 'Python 3.12.0' };
      if (bin === 'git' && args[0] === 'clone') {
        mkdirSync(args[args.length - 1]!, { recursive: true });
        return { exitCode: 0 };
      }
      return { exitCode: 0 };
    });
    const applyUpstreamPatches = vi.fn(() => {
      throw new Error('failed to apply upstream patch passed-actual.patch');
    });
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand, applyUpstreamPatches },
    });
    const r = await h.onEnable({ args: {}, runtimePlugins: [] });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.message).toMatch(/failed to apply upstream patch/);
    }
    // No marker written — enable did not complete successfully.
    expect(existsSync(join(implStateDir, 'state.json'))).toBe(false);
  });

  it('M2 (WP1): re-applies upstream eval.py patches on re-enable so operators who enabled before the patch shipped still get it', async () => {
    // Real (trimmed, unpatched) upstream eval.py fixture, committed to a
    // fresh git repo — same fixture the 'applyUpstreamPatches' describe
    // block below exercises directly.
    const repoDir = join(implStateDir, 'upstream');
    mkdirSync(join(repoDir, 'scripts'), { recursive: true });
    const fixture = readFileSync(
      join(__dirname, 'fixtures', 'eval.py'),
      'utf8',
    );
    writeFileSync(join(repoDir, 'scripts', 'eval.py'), fixture);
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });
    execFileSync('git', ['add', '-A'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'unpatched upstream fixture'], { cwd: repoDir });

    // Simulate an operator who ran `onEnable` before this patch existed:
    // the marker is present and the repo exists, but eval.py is unpatched.
    writeFileSync(
      join(implStateDir, 'state.json'),
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-evaluator-state.v1',
        enabled: true,
        enabledAt: '2026-05-07T00:00:00Z',
        upstreamRepoDir: repoDir,
      }),
    );

    // Every git/docker/python invocation is a no-op against the real fixture
    // repo (exitCode 0); the WP1 guarantee is that `applyUpstreamPatches` (run
    // for real here, not stubbed) patches eval.py on this re-enable. next's
    // enable path re-runs the self-test and the patch step unconditionally, so
    // the patch is applied without a separate already-enabled fast path.
    const runCommand = makeRunCommand(() => ({ exitCode: 0 }));
    const h = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { runCommand },
    });
    const r = await h.onEnable({ args: {}, runtimePlugins: [] });
    expect(r.status).toBe('ready');

    const evalPy = readFileSync(join(repoDir, 'scripts', 'eval.py'), 'utf8');
    expect(evalPy).toContain('"passed_actual": sorted(passed_actual)');
    expect(evalPy).toContain('"failed_actual": sorted(failed_actual)');
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

describe('applyUpstreamPatches', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeImplStateDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A tmp git repo seeded with `fixtures/eval.py` — the real (trimmed,
   * unpatched) SWE-rebench-V2 `scripts/eval.py` as cloned by `onEnable`
   * today, committed as-is. This exercises `git apply --check --reverse`
   * against genuine upstream content rather than a synthetic stand-in.
   */
  function cloneFixtureUpstream(): string {
    const repoDir = join(dir, 'upstream');
    mkdirSync(join(repoDir, 'scripts'), { recursive: true });
    const fixture = readFileSync(
      join(__dirname, 'fixtures', 'eval.py'),
      'utf8',
    );
    writeFileSync(join(repoDir, 'scripts', 'eval.py'), fixture);
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });
    execFileSync('git', ['add', '-A'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'unpatched upstream fixture'], { cwd: repoDir });
    return repoDir;
  }

  it('applies the passed_actual patch to upstream eval.py, idempotently', () => {
    const repoDir = cloneFixtureUpstream();
    applyUpstreamPatches(repoDir);
    const evalPy = readFileSync(join(repoDir, 'scripts', 'eval.py'), 'utf8');
    expect(evalPy).toContain('"passed_actual": sorted(passed_actual)');
    expect(evalPy).toContain('"failed_actual": sorted(failed_actual)');
    // Second run is a no-op (already-applied, detected via reverse-check).
    expect(() => applyUpstreamPatches(repoDir)).not.toThrow();
  });

  it('no-ops when the fix is already present (upstream shipped it natively)', () => {
    const repoDir = cloneFixtureUpstream();
    applyUpstreamPatches(repoDir); // apply once
    const afterFirstApply = readFileSync(join(repoDir, 'scripts', 'eval.py'), 'utf8');
    applyUpstreamPatches(repoDir); // simulate a second onEnable against the same clone
    const afterSecondApply = readFileSync(join(repoDir, 'scripts', 'eval.py'), 'utf8');
    expect(afterSecondApply).toBe(afterFirstApply);
  });

  it('throws when the patch neither applies nor is already applied', () => {
    const repoDir = join(dir, 'upstream');
    mkdirSync(join(repoDir, 'scripts'), { recursive: true });
    // scripts/eval.py missing entirely — patch can't match any context.
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    expect(() => applyUpstreamPatches(repoDir)).toThrow(/failed to apply upstream patch/);
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
    // harness must now emit v2 and forward passedCount/totalCount from the grader.
    // runner stub returns passed=['test_a','test_b'], failed=[] → passedCount=2, totalCount=2.
    expect(sol.verdictPayload).toMatchObject({
      schemaVersion: 'swe-rebench-v2-verdict.v2',
      score: 1,
      passed_match: true,
      passedCount: 2,
      totalCount: 2,
    });
    // Real (unstubbed) clock + fake runner → grade() wall-time is ~0ms, so the
    // metered cost is 0 or tiny; the metering tests below pin exact values.
    expect(
      (sol.verdictPayload as Record<string, unknown>)['evaluator_cost_usd'],
    ).toBeGreaterThanOrEqual(0);
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
        schemaVersion: 'swe-rebench-v2-verdict.v2',
        score: 1,
        passed_match: true,
        passedCount: 2,
        totalCount: 2,
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

  describe('evaluator cost metering (JINN_EVAL_COMPUTE_USD_PER_HOUR, #1828)', () => {
    const ENV_KEY = 'JINN_EVAL_COMPUTE_USD_PER_HOUR';
    let priorEnv: string | undefined;
    beforeEach(() => {
      priorEnv = process.env[ENV_KEY];
    });
    afterEach(() => {
      if (priorEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = priorEnv;
      vi.restoreAllMocks();
    });

    // Stub the monotonic clock with a controllable value that only the fake
    // runner advances, making grade() elapsed time deterministic.
    async function runWithStubbedElapsed(elapsedMs: number) {
      let now = 1_000_000;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const runner = {
        runEval: vi.fn().mockImplementation(async () => {
          now += elapsedMs;
          return {
            passed_match: true,
            passed: ['test_a', 'test_b'],
            failed: [],
            log: 'all green',
            exitCode: 0,
          };
        }),
      };
      const harness = new SweRebenchV2EvaluatorHarness({
        implStateDir,
        _testDeps: {
          fetcher: makeFakeFetcher(),
          runner,
          uploadToIpfs: vi.fn().mockResolvedValue('bafy-test-log-cid'),
          stateDir: implStateDir,
        },
      });
      const ctx = buildHarnessContext(
        implStateDir,
        buildEvaluationTask(buildSolverEnvelope()),
      );
      return harness.run(ctx);
    }

    function costOf(sol: Awaited<ReturnType<SweRebenchV2EvaluatorHarness['run']>>): unknown {
      return (sol.verdictPayload as Record<string, unknown>)['evaluator_cost_usd'];
    }

    it('meters grade() wall-time at the env rate (30 min at 0.20/hr → 0.1)', async () => {
      process.env[ENV_KEY] = '0.20';
      const sol = await runWithStubbedElapsed(30 * 60_000);
      expect(costOf(sol)).toBe(0.1);
    });

    it('defaults to 0.20/hr when the env is unset', async () => {
      delete process.env[ENV_KEY];
      const sol = await runWithStubbedElapsed(30 * 60_000);
      expect(costOf(sol)).toBe(0.1);
    });

    it('records 0 with a warning (and still completes) when the env is zero', async () => {
      process.env[ENV_KEY] = '0';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sol = await runWithStubbedElapsed(30 * 60_000);
      expect(costOf(sol)).toBe(0);
      expect(sol.gating).toMatchObject({ verdict: 'PASS' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('JINN_EVAL_COMPUTE_USD_PER_HOUR'),
      );
    });

    it('records 0 with a warning (and still completes) when the env is not a number', async () => {
      const invalidRate = 'sensitive-invalid-rate';
      process.env[ENV_KEY] = invalidRate;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sol = await runWithStubbedElapsed(30 * 60_000);
      expect(costOf(sol)).toBe(0);
      expect(sol.gating).toMatchObject({ verdict: 'PASS' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('JINN_EVAL_COMPUTE_USD_PER_HOUR'),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(invalidRate));
    });

    it('uses monotonic elapsed time when the wall clock steps backward mid-grade', async () => {
      process.env[ENV_KEY] = '0.20';
      let wallNow = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => wallNow);
      const run = runWithStubbedElapsed(30 * 60_000);
      wallNow -= 5 * 60_000;
      const sol = await run;
      expect(costOf(sol)).toBe(0.1);
      expect(sol.gating).toMatchObject({ verdict: 'PASS' });
    });

    it('defensively clamps a negative monotonic elapsed time to 0', async () => {
      process.env[ENV_KEY] = '0.20';
      const sol = await runWithStubbedElapsed(-5 * 60_000);
      expect(costOf(sol)).toBe(0);
      expect(sol.gating).toMatchObject({ verdict: 'PASS' });
    });

    it('records 0 with a warning when a finite rate overflows the final cost', async () => {
      process.env[ENV_KEY] = String(Number.MAX_VALUE);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sol = await runWithStubbedElapsed(2 * 3_600_000);
      expect(costOf(sol)).toBe(0);
      expect(sol.gating).toMatchObject({ verdict: 'PASS' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('evaluator_cost_usd=0'));
    });

    it('records 0 with a warning when elapsed-time computation is non-finite', async () => {
      process.env[ENV_KEY] = '0.20';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sol = await runWithStubbedElapsed(Number.POSITIVE_INFINITY);
      expect(costOf(sol)).toBe(0);
      expect(sol.gating).toMatchObject({ verdict: 'PASS' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('evaluator_cost_usd=0'));
    });
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

  it('grades launcher-posted tasks from the published pool ref without local admission data', async () => {
    const artifact: SweRebenchV2VettedPoolArtifact = {
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-05-22T00:00:00.000Z',
      entries: [
        {
          instance_id: INSTANCE_ID,
          scorable: true,
          reason: 'gold-patch-resolves',
          checkedAt: '2026-05-14T00:00:00Z',
          rowHash: MATCHING_ROW_HASH,
          imageName: IMAGE_NAME,
          imageDigest: IMAGE_DIGEST,
        },
      ],
    };
    const ref = createVettedPoolArtifactRef({
      manifestCid: 'bafy-launch-manifest',
      artifactCid: 'bafy-vetted-pool',
      artifactHash: hashVettedPoolArtifact(artifact),
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      publishedAt: '2026-05-22T00:00:00.000Z',
    });
    const task = buildEvaluationTask(buildSolverEnvelope());
    task.solverNetManifestCid = 'bafy-launch-manifest';
    task.eligibility = { vettedPoolRef: ref };
    const runner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: true,
        passed: ['test_a'],
        failed: [],
        log: 'ok',
        exitCode: 0,
      }),
    };
    const loadPool = makeMatchingPoolLoader();
    const runCommand = makeMatchingDockerInspect();
    const fetchFromIpfs = vi.fn().mockResolvedValue(artifact);
    const harness = makeHarness({
      fetcher: { fetchTaskRow: vi.fn().mockResolvedValue(STUB_ROW) },
      fetchFromIpfs,
      loadPool,
      runCommand: runCommand as unknown as typeof import('../../../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js').runCommand,
      runner,
      uploadToIpfs: vi.fn().mockResolvedValue('bafy-ok'),
    });

    const ctx = buildHarnessContext(implStateDir, task);
    const sol = await harness.run(ctx);
    const second = await harness.run(ctx);

    expect(sol.gating).toMatchObject({ verdict: 'PASS' });
    expect(second.gating).toMatchObject({ verdict: 'PASS' });
    expect(fetchFromIpfs).toHaveBeenCalledTimes(1);
    expect(fetchFromIpfs).toHaveBeenCalledWith(expect.any(String), 'bafy-vetted-pool');
    expect(runner.runEval).toHaveBeenCalledTimes(2);
    expect(loadPool).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('skips launcher-posted tasks when the published pool ref omits the instance', async () => {
    const artifact: SweRebenchV2VettedPoolArtifact = {
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-05-22T00:00:00.000Z',
      entries: [
        {
          instance_id: 'other__repo-1',
          scorable: true,
          reason: 'gold-patch-resolves',
          checkedAt: '2026-05-14T00:00:00Z',
        },
      ],
    };
    const ref = createVettedPoolArtifactRef({
      manifestCid: 'bafy-launch-manifest',
      artifactCid: 'bafy-vetted-pool',
      artifactHash: hashVettedPoolArtifact(artifact),
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      publishedAt: '2026-05-22T00:00:00.000Z',
    });
    const task = buildEvaluationTask(buildSolverEnvelope());
    task.solverNetManifestCid = 'bafy-launch-manifest';
    task.eligibility = { vettedPoolRef: ref };
    const { SkippableError } = await import('../../../../src/harnesses/types.js');
    const harness = makeHarness({
      fetcher: { fetchTaskRow: vi.fn() },
      fetchFromIpfs: vi.fn().mockResolvedValue(artifact),
      runner: { runEval: vi.fn() },
      uploadToIpfs: vi.fn(),
    });

    const err = await harness.run(buildHarnessContext(implStateDir, task)).catch((e) => e);

    expect(err).toBeInstanceOf(SkippableError);
    expect(err.reason).toBe('vetted_pool_instance_missing_or_unscorable');
    expect(err.reason).not.toBe('admission_missing_or_unscorable');
  });
});

describe('SweRebenchV2EvaluatorHarness — minted-pool.v2 environment recheck', () => {
  const INSTANCE_ID = 'jinn-network__mono__echo-5b76bade3198';
  const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
  const IMAGE = `ghcr.io/jinn-network/task-environment@${IMAGE_DIGEST}`;
  const BASE_COMMIT = 'c7701007'.padEnd(40, '0');
  let implStateDir: string;
  let stateDir: string;

  beforeEach(() => {
    implStateDir = makeImplStateDir();
    stateDir = mkdtempSync(join(tmpdir(), 'swe-rebench-v2-minted-v2-state-'));
    makeDurableEnabledMarker(implStateDir, join(implStateDir, 'upstream'));
  });
  afterEach(() => {
    rmSync(implStateDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function parserDigest(): `sha256:${string}` {
    return `sha256:${createHash('sha256')
      .update(readFileSync(join(process.cwd(), 'scripts', 'swe-rebench-v2-evaluator.bundle.v1.patch')))
      .digest('hex')}`;
  }

  async function environmentSpec(): Promise<TaskEnvironmentSpecV1> {
    const unsigned = {
      schemaVersion: 'jinn.task-environment.v1' as const,
      source: {
        repo: 'Jinn-Network/mono',
        repoUrl: 'https://github.com/Jinn-Network/mono.git',
        baseCommit: BASE_COMMIT,
      },
      inputs: [{
        inputRef: `git+https://github.com/Jinn-Network/mono.git#${BASE_COMMIT}`,
        sha256: `sha256:${'e'.repeat(64)}` as `sha256:${string}`,
        rights: {
          inputRef: `git+https://github.com/Jinn-Network/mono.git#${BASE_COMMIT}`,
          rightsRef: 'https://spdx.org/licenses/Apache-2.0.html',
          basis: 'spdx' as const,
          spdxId: 'Apache-2.0',
        },
      }],
      execution: {
        platform: 'linux/amd64' as const,
        workspace: '/testbed' as const,
        image: { reference: IMAGE, digest: IMAGE_DIGEST as `sha256:${string}` },
        testCommands: [{ bin: 'yarn', args: ['vitest', 'run'] }],
        parser: {
          id: 'vitest-json.v1', version: 'v1', digest: parserDigest(),
          bundleId: 'jinn.swe-rebench-v2.patch-bundle.v1',
        },
        timeoutSeconds: 300,
        environment: {},
      },
      build: {
        recipeCid: 'bafy-recipe', recipeHash: `sha256:${'f'.repeat(64)}` as `sha256:${string}`,
        provider: 'explicit' as const, providerId: 'jinn-mono.v1', providerVersion: 'v1',
      },
      publication: {
        publicRepoVerifiedAt: '2026-07-10T00:00:00.000Z', rightsPolicyVersion: 'g0b.v1',
        buildSmoke: 'pass' as const, imageSecretScan: 'pass' as const, sbomCid: 'bafy-sbom',
      },
      attestation: {
        scheme: 'eip191' as const, algo: 'secp256k1' as const,
        environmentHash: `sha256:${'0'.repeat(64)}` as `sha256:${string}`,
        operatorSafe: `0x${'1'.repeat(40)}`, signer: `0x${'2'.repeat(40)}`,
        signature: `0x${'3'.repeat(130)}`,
      },
    } satisfies TaskEnvironmentSpecV1;
    const environmentHash = hashTaskEnvironmentSpecV1(unsigned);
    const account = privateKeyToAccount(`0x${'4'.repeat(64)}`);
    return {
      ...unsigned,
      attestation: {
        ...unsigned.attestation,
        environmentHash,
        signer: account.address,
        signature: await account.signMessage({ message: environmentAttestationMessageV1(environmentHash) }),
      },
    };
  }

  function artifact(spec: TaskEnvironmentSpecV1): SweRebenchV2MintedPoolArtifactV2 {
    const row = {
      instance_id: INSTANCE_ID,
      repo: 'Jinn-Network/mono',
      base_commit: BASE_COMMIT,
      language: 'typescript',
      problem_statement: 'regression',
      image_name: IMAGE,
      FAIL_TO_PASS: ['test/task-creator/public-repo.test.ts > regression'],
      PASS_TO_PASS: [],
      test_patch: 'diff --git a/test/a.ts b/test/a.ts',
      install_config: { test_cmd: ['yarn', 'vitest', 'run'], log_parser: 'vitest-json.v1' },
      rowHashVersion: 2 as const,
      environment: {
        environmentSpecCid: 'bafy-environment',
        environmentHash: hashTaskEnvironmentSpecV1(spec),
        attestation: spec.attestation,
        parser: spec.execution.parser,
        image: spec.execution.image,
        platform: spec.execution.platform,
      },
      publicRowHash: '' as `sha256:${string}`,
    } satisfies Omit<MintedPoolRowV2, 'publicRowHash'> & { publicRowHash: `sha256:${string}` };
    return {
      schemaVersion: 'swe-rebench-v2-minted-pool.v2',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-07-10T00:00:00.000Z',
      rows: [{ ...row, publicRowHash: computeMintedPoolRowV2Hash(row) }],
    };
  }

  function hardenedArtifact(spec: TaskEnvironmentSpecV1): {
    minted: SweRebenchV2MintedPoolArtifactV2;
    receipt: ReturnType<typeof createDifferentialAdmissionReceiptV2>;
  } {
    const minted = artifact(spec);
    const original = minted.rows[0]!;
    const receipt = createDifferentialAdmissionReceiptV2({
      task: {
        instanceId: INSTANCE_ID,
        repo: original.repo,
        baseCommit: BASE_COMMIT,
        fixCommit: 'f'.repeat(40),
      },
      goldPatchHash: `sha256:${createHash('sha256').update('private gold').digest('hex')}`,
      testPatchHash: `sha256:${createHash('sha256').update(original.test_patch).digest('hex')}`,
      environment: spec,
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      testPaths: [{
        testPath: 'test/a.ts',
        broken: [
          { passed: [], failed: [original.FAIL_TO_PASS[0]!], passed_match: false },
          { passed: [], failed: [original.FAIL_TO_PASS[0]!], passed_match: false },
        ],
        fixed: [
          { passed: [original.FAIL_TO_PASS[0]!], failed: [], passed_match: true },
          { passed: [original.FAIL_TO_PASS[0]!], failed: [], passed_match: true },
        ],
      }],
    });
    const row = {
      ...original,
      fix_commit: 'f'.repeat(40),
      differentialAdmission: {
        admissionPolicyVersion: receipt.admissionPolicyVersion,
        receiptCid: 'bafy-differential-receipt',
        receiptHash: hashDifferentialAdmissionReceiptV2(receipt),
      },
    };
    minted.rows[0] = {
      ...row,
      publicRowHash: computeMintedPoolRowV2Hash(row as MintedPoolRowV2),
    } as MintedPoolRowV2;
    return { minted, receipt };
  }

  function vettedAdmission(minted: SweRebenchV2MintedPoolArtifactV2): SweRebenchV2VettedPoolArtifact {
    const row = minted.rows[0]!;
    return {
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-07-10T00:00:00.000Z',
      entries: [{
        instance_id: row.instance_id,
        scorable: true,
        reason: 'gold-patch-resolves',
        checkedAt: '2026-07-10T00:00:00.000Z',
        rowHashVersion: 2,
        publicRowHash: row.publicRowHash,
        v2Environment: {
          environmentSpecCid: row.environment.environmentSpecCid,
          environmentHash: row.environment.environmentHash,
          parser: row.environment.parser,
          image: row.environment.image,
          platform: row.environment.platform,
        },
        ...(row.fix_commit ? { v2FixCommit: row.fix_commit } : {}),
        ...(row.differentialAdmission ? { differentialAdmission: row.differentialAdmission } : {}),
      }],
    };
  }

  function withVettedAdmission(task: Task, admission: SweRebenchV2VettedPoolArtifact): Task {
    task.solverNetManifestCid = 'bafy-v2-manifest';
    task.eligibility = {
      vettedPoolRef: createVettedPoolArtifactRef({
        manifestCid: 'bafy-v2-manifest',
        artifactCid: 'bafy-v2-admission',
        artifactHash: hashVettedPoolArtifact(admission),
        evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
        publishedAt: '2026-07-10T00:00:00.000Z',
      }),
    };
    return task;
  }

  function mintedTask(): Task {
    const task = buildEvaluationTask(buildSolverEnvelope());
    task.spec = {
      ...task.spec,
      instance_id: INSTANCE_ID,
      repo: 'Jinn-Network/mono',
      base_commit: BASE_COMMIT,
      language: 'typescript',
      hf_dataset: 'ipfs://bafymintedv2',
      hf_split: 'minted',
    };
    return task;
  }

  function imageInspect() {
    return vi.fn(async (bin: string, args: string[]) => {
      if (bin === 'docker' && args[0] === 'image' && args.includes('{{json .RepoDigests}}')) {
        return { exitCode: 0, stdout: JSON.stringify([IMAGE]), stderr: '' };
      }
      if (bin === 'docker' && args[0] === 'image' && args.includes('{{.Os}}/{{.Architecture}}')) {
        return { exitCode: 0, stdout: 'linux/amd64\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
  }

  it('grades a v2 task only after immutable row, environment, parser, image, and platform bindings match', async () => {
    const spec = await environmentSpec();
    const mintedArtifact = artifact(spec);
    const admission = vettedAdmission(mintedArtifact);
    const fetchFromIpfs = vi.fn(async (_gateway: string, cid: string) => cid === 'bafy-v2-admission' ? admission : spec);
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: vi.fn() },
      fetchMintedArtifact: async () => mintedArtifact,
    });
    const runner = { runEval: vi.fn().mockResolvedValue({ passed_match: true, passed: ['regression'], failed: [], log: 'ok', exitCode: 0 }) };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { stateDir, fetcher, fetchFromIpfs, runCommand: imageInspect(), runner, uploadToIpfs: vi.fn().mockResolvedValue('bafy-log') },
    });

    const solution = await harness.run(buildHarnessContext(implStateDir, withVettedAdmission(mintedTask(), admission)));

    expect(solution.gating).toMatchObject({ verdict: 'PASS' });
    expect(runner.runEval).toHaveBeenCalledOnce();
    expect(fetchFromIpfs).toHaveBeenCalledWith(expect.any(String), 'bafy-environment');
  });

  it('pulls the bound digest-qualified v2 image before inspection on a fresh evaluator', async () => {
    const spec = await environmentSpec();
    const mintedArtifact = artifact(spec);
    const admission = vettedAdmission(mintedArtifact);
    const calls: string[] = [];
    let pulled = false;
    const runCommand = vi.fn(async (bin: string, args: string[]) => {
      if (bin !== 'docker') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'pull') {
        calls.push(`pull:${args[1]}`);
        pulled = true;
        return { exitCode: 0, stdout: 'pulled', stderr: '' };
      }
      if (args[0] === 'image' && args.includes('{{json .RepoDigests}}')) {
        calls.push('inspect:digest');
        return pulled
          ? { exitCode: 0, stdout: JSON.stringify([IMAGE]), stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'image missing' };
      }
      if (args[0] === 'image' && args.includes('{{.Os}}/{{.Architecture}}')) {
        calls.push('inspect:platform');
        return pulled
          ? { exitCode: 0, stdout: 'linux/amd64\n', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'image missing' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: vi.fn() },
      fetchMintedArtifact: async () => mintedArtifact,
    });
    const runner = { runEval: vi.fn().mockResolvedValue({ passed_match: true, passed: ['regression'], failed: [], log: 'ok', exitCode: 0 }) };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: {
        stateDir, fetcher,
        fetchFromIpfs: vi.fn(async (_gateway: string, cid: string) => cid === 'bafy-v2-admission' ? admission : spec),
        runCommand, runner, uploadToIpfs: vi.fn().mockResolvedValue('bafy-log'),
      },
    });

    await expect(harness.run(buildHarnessContext(implStateDir, withVettedAdmission(mintedTask(), admission)))).resolves.toBeDefined();

    expect(calls).toEqual([`pull:${IMAGE}`, 'inspect:digest', 'inspect:platform']);
    expect(runner.runEval).toHaveBeenCalledOnce();
  });

  it('emits no verdict when the bound v2 image pull fails', async () => {
    const spec = await environmentSpec();
    const mintedArtifact = artifact(spec);
    const admission = vettedAdmission(mintedArtifact);
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: vi.fn() },
      fetchMintedArtifact: async () => mintedArtifact,
    });
    const runner = { runEval: vi.fn() };
    const runCommand = vi.fn(async (bin: string, args: string[]) =>
      bin === 'docker' && args[0] === 'pull'
        ? { exitCode: 1, stdout: '', stderr: 'pull denied' }
        : { exitCode: 0, stdout: '', stderr: '' },
    );
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: {
        stateDir, fetcher,
        fetchFromIpfs: vi.fn(async (_gateway: string, cid: string) => cid === 'bafy-v2-admission' ? admission : spec),
        runCommand, runner, uploadToIpfs: vi.fn(),
      },
    });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');

    const error = await harness.run(buildHarnessContext(implStateDir, withVettedAdmission(mintedTask(), admission))).catch((err) => err);

    expect(error).toBeInstanceOf(SkippableError);
    expect(error.reason).toBe('minted_substrate_image_pull_failed');
    expect(runner.runEval).not.toHaveBeenCalled();
  });

  it('emits no verdict for a v2 row without an exact published vetted-pool admission', async () => {
    const spec = await environmentSpec();
    const mintedArtifact = artifact(spec);
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: vi.fn() },
      fetchMintedArtifact: async () => mintedArtifact,
    });
    const runner = { runEval: vi.fn().mockResolvedValue({ passed_match: true, passed: ['regression'], failed: [], log: 'ok', exitCode: 0 }) };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { stateDir, fetcher, fetchFromIpfs: vi.fn().mockResolvedValue(spec), runCommand: imageInspect(), runner, uploadToIpfs: vi.fn() },
    });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');

    const error = await harness.run(buildHarnessContext(implStateDir, mintedTask())).catch((err) => err);

    expect(error).toBeInstanceOf(SkippableError);
    expect(error.reason).toBe('minted_v2_admission_missing');
    expect(runner.runEval).not.toHaveBeenCalled();
  });

  it('emits no verdict when the vetted-pool public row binding differs', async () => {
    const spec = await environmentSpec();
    const mintedArtifact = artifact(spec);
    const admission = vettedAdmission(mintedArtifact);
    admission.entries[0] = { ...admission.entries[0]!, publicRowHash: `sha256:${'8'.repeat(64)}` };
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: vi.fn() },
      fetchMintedArtifact: async () => mintedArtifact,
    });
    const runner = { runEval: vi.fn() };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { stateDir, fetcher, fetchFromIpfs: vi.fn(async (_gateway: string, cid: string) => cid === 'bafy-v2-admission' ? admission : spec), runCommand: imageInspect(), runner, uploadToIpfs: vi.fn() },
    });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');

    const error = await harness.run(buildHarnessContext(implStateDir, withVettedAdmission(mintedTask(), admission))).catch((err) => err);

    expect(error).toBeInstanceOf(SkippableError);
    expect(error.reason).toBe('minted_v2_admission_drift');
    expect(runner.runEval).not.toHaveBeenCalled();
  });

  it('emits no verdict when a hardened receipt hash differs from the vetted admission', async () => {
    const spec = await environmentSpec();
    const { minted, receipt } = hardenedArtifact(spec);
    const admission = vettedAdmission(minted);
    admission.entries[0] = {
      ...admission.entries[0]!,
      differentialAdmission: {
        admissionPolicyVersion: receipt.admissionPolicyVersion,
        receiptCid: 'bafy-differential-receipt',
        receiptHash: `sha256:${'9'.repeat(64)}`,
      },
    } as typeof admission.entries[number];
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: vi.fn() },
      fetchMintedArtifact: async () => minted,
    });
    const runner = { runEval: vi.fn() };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: {
        stateDir,
        fetcher,
        fetchFromIpfs: vi.fn(async (_gateway: string, cid: string) => {
          if (cid === 'bafy-v2-admission') return admission;
          if (cid === 'bafy-differential-receipt') return receipt;
          return spec;
        }),
        runCommand: imageInspect(),
        runner,
        uploadToIpfs: vi.fn(),
      },
    });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');

    const error = await harness.run(buildHarnessContext(implStateDir, withVettedAdmission(mintedTask(), admission))).catch((err) => err);

    expect(error).toBeInstanceOf(SkippableError);
    expect(error.reason).toBe('minted_v2_differential_admission_drift');
    expect(runner.runEval).not.toHaveBeenCalled();
  });

  it('emits no verdict when a hardened receipt fix commit drifts from the public row', async () => {
    const spec = await environmentSpec();
    const { minted, receipt } = hardenedArtifact(spec);
    const original = minted.rows[0]!;
    const drifted = { ...original, fix_commit: 'e'.repeat(40) };
    minted.rows[0] = {
      ...drifted,
      publicRowHash: computeMintedPoolRowV2Hash(drifted as MintedPoolRowV2),
    } as MintedPoolRowV2;
    const admission = vettedAdmission(minted);
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: vi.fn() },
      fetchMintedArtifact: async () => minted,
    });
    const runner = { runEval: vi.fn() };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: {
        stateDir,
        fetcher,
        fetchFromIpfs: vi.fn(async (_gateway: string, cid: string) => {
          if (cid === 'bafy-v2-admission') return admission;
          if (cid === 'bafy-differential-receipt') return receipt;
          return spec;
        }),
        runCommand: imageInspect(),
        runner,
        uploadToIpfs: vi.fn(),
      },
    });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');

    const error = await harness.run(buildHarnessContext(implStateDir, withVettedAdmission(mintedTask(), admission))).catch((err) => err);

    expect(error).toBeInstanceOf(SkippableError);
    expect(error.reason).toBe('minted_v2_differential_fix_commit_drift');
    expect(runner.runEval).not.toHaveBeenCalled();
  });

  it('emits no verdict when a v2 public row hash drifts', async () => {
    const spec = await environmentSpec();
    const mintedArtifact = artifact(spec);
    mintedArtifact.rows[0] = { ...mintedArtifact.rows[0]!, publicRowHash: `sha256:${'0'.repeat(64)}` };
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: vi.fn() },
      fetchMintedArtifact: async () => mintedArtifact,
    });
    const runner = { runEval: vi.fn() };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { stateDir, fetcher, fetchFromIpfs: vi.fn().mockResolvedValue(spec), runCommand: imageInspect(), runner, uploadToIpfs: vi.fn() },
    });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');

    const error = await harness.run(buildHarnessContext(implStateDir, mintedTask())).catch((err) => err);

    expect(error).toBeInstanceOf(SkippableError);
    expect(error.reason).toBe('minted_substrate_drift_public_row_hash');
    expect(runner.runEval).not.toHaveBeenCalled();
  });

  it('emits no verdict when a hash-valid v2 row points at a different signed environment', async () => {
    const spec = await environmentSpec();
    const mintedArtifact = artifact(spec);
    const original = mintedArtifact.rows[0]!;
    const wrongHash = `sha256:${'9'.repeat(64)}` as `sha256:${string}`;
    const row = {
      ...original,
      environment: {
        ...original.environment,
        environmentHash: wrongHash,
        attestation: { ...original.environment.attestation, environmentHash: wrongHash },
      },
    };
    mintedArtifact.rows[0] = { ...row, publicRowHash: computeMintedPoolRowV2Hash(row) };
    const admission = vettedAdmission(mintedArtifact);
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: vi.fn() },
      fetchMintedArtifact: async () => mintedArtifact,
    });
    const runner = { runEval: vi.fn() };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { stateDir, fetcher, fetchFromIpfs: vi.fn(async (_gateway: string, cid: string) => cid === 'bafy-v2-admission' ? admission : spec), runCommand: imageInspect(), runner, uploadToIpfs: vi.fn() },
    });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');

    const error = await harness.run(buildHarnessContext(implStateDir, withVettedAdmission(mintedTask(), admission))).catch((err) => err);

    expect(error).toBeInstanceOf(SkippableError);
    expect(error.reason).toBe('minted_substrate_drift_environment_hash');
    expect(runner.runEval).not.toHaveBeenCalled();
  });

  it('emits no verdict when the published environment uses a non-canonical source URL or input ref', async () => {
    const original = await environmentSpec();
    const unsigned = {
      ...original,
      source: { ...original.source, repoUrl: 'https://github.com/Jinn-Network/not-mono.git' },
      inputs: original.inputs.map((input) => ({
        ...input,
        inputRef: `git+https://github.com/Jinn-Network/not-mono.git#${BASE_COMMIT}`,
        rights: { ...input.rights, inputRef: `git+https://github.com/Jinn-Network/not-mono.git#${BASE_COMMIT}` },
      })),
    } satisfies TaskEnvironmentSpecV1;
    const environmentHash = hashTaskEnvironmentSpecV1(unsigned);
    const account = privateKeyToAccount(`0x${'4'.repeat(64)}`);
    const spec = {
      ...unsigned,
      attestation: {
        ...unsigned.attestation,
        environmentHash,
        signature: await account.signMessage({ message: environmentAttestationMessageV1(environmentHash) }),
      },
    } satisfies TaskEnvironmentSpecV1;
    const mintedArtifact = artifact(spec);
    const admission = vettedAdmission(mintedArtifact);
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: vi.fn() },
      fetchMintedArtifact: async () => mintedArtifact,
    });
    const runner = { runEval: vi.fn() };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir,
      _testDeps: { stateDir, fetcher, fetchFromIpfs: vi.fn(async (_gateway: string, cid: string) => cid === 'bafy-v2-admission' ? admission : spec), runCommand: imageInspect(), runner, uploadToIpfs: vi.fn() },
    });
    const { SkippableError } = await import('../../../../src/harnesses/types.js');

    const error = await harness.run(buildHarnessContext(implStateDir, withVettedAdmission(mintedTask(), admission))).catch((err) => err);

    expect(error).toBeInstanceOf(SkippableError);
    expect(error.reason).toBe('minted_substrate_source_binding_drift');
    expect(runner.runEval).not.toHaveBeenCalled();
  });
});
