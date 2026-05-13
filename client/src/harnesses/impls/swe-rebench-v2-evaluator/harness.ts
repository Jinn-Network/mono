/**
 * SWE-rebench v2 Evaluator Harness — wraps the {@link SweRebenchV2Evaluator}
 * grading library as a first-class {@link Harness} so the daemon dispatches
 * `swe-rebench-v2.v1` evaluation tasks to it.
 *
 * Operator setup is automated via {@link SweRebenchV2EvaluatorHarness.onEnable}:
 *   `jinn harnesses enable swe-rebench-v2-evaluator`
 *   - Validates Docker + Python availability.
 *   - Clones the upstream `SWE-rebench/SWE-rebench-V2` repo into
 *     `<implStateDir>/upstream` (one-time; idempotent on rerun).
 *   - Writes a `state.json` marker with `enabled: true`.
 *
 * `isReady()` reports `ready: false` (with a `nextStep` pointing at the
 * enable command) until the marker file is written.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.4
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SweRebenchV2TaskSchema,
  SweRebenchV2SolutionPayloadSchema,
  type SweRebenchV2VerdictPayload,
} from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import type {
  EnableResult,
  Harness,
  HarnessContext,
  HarnessEnableContext,
  HarnessEnableMetadata,
  ReadyStatus,
  Solution,
} from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS, SkippableError } from '../../types.js';
import type { Task } from '../../../types/task.js';
import { SignedEnvelopeSchema } from '../../../types/envelope.js';
import { uploadToIpfs } from '../../../adapters/mech/ipfs.js';
import { SweRebenchV2Evaluator, type EvalRunner, type HfFetcher } from './index.js';
import { PythonEvalRunner, EvalCouldNotGradeError } from './eval-runner.js';
import { HttpHfFetcher } from './hf-fetcher.js';

const DEFAULT_IPFS_REGISTRY_URL = 'https://registry.autonolas.tech';
const UPSTREAM_REPO_URL = 'https://github.com/SWE-rebench/SWE-rebench-V2.git';
const STATE_FILE = 'state.json';
const ENABLE_CLI = 'jinn harnesses enable swe-rebench-v2-evaluator';

/** The two verdict values emitted by this evaluator. The broader registry
 *  shape (`reputation.ts`) also recognises `'INDETERMINATE'` / `'REJECTED'`,
 *  but swe-rebench v2 grades are binary: the gold tests either resolve or
 *  they don't. Mirrors the pattern in `prediction-v0-evaluator/types.ts`. */
type SweRebenchVerdict = 'PASS' | 'FAIL';

interface EnabledState {
  schemaVersion: 'swe-rebench-v2-evaluator-state.v1';
  enabled: true;
  enabledAt: string;
  upstreamRepoDir: string;
}

export interface SweRebenchV2EvaluatorHarnessOptions {
  /** Marks a stub registry — `isReady()` reports requires-live-daemon. */
  stub?: boolean;
  /**
   * Per-impl state directory (e.g. `~/.jinn-client/engine/impl-state/swe-rebench-v2-evaluator`).
   * The upstream repo is cloned to `<implStateDir>/upstream` and the enabled
   * marker lives at `<implStateDir>/state.json`.
   */
  implStateDir?: string;
  /** IPFS registry URL used to pin test logs. Defaults to Autonolas gateway. */
  ipfsRegistryUrl?: string;
  /**
   * Test-only injection points. Production runs use Node's child_process
   * + node:fs + the bundled HFFetcher / PythonEvalRunner.
   */
  _testDeps?: {
    runCommand?: typeof runCommand;
    fetcher?: HfFetcher;
    runner?: EvalRunner;
    uploadToIpfs?: typeof uploadToIpfs;
  };
}

export class SweRebenchV2EvaluatorHarness implements Harness {
  readonly name = 'swe-rebench-v2-evaluator';
  readonly version = '1.0.0';

  private readonly stub: boolean;
  private readonly implStateDir: string | undefined;
  private readonly ipfsRegistryUrl: string;
  private readonly deps: NonNullable<SweRebenchV2EvaluatorHarnessOptions['_testDeps']>;
  /** The engine's claim-eligibility check calls `isReady()` per candidate
   *  task per tick (~17 Hz potential). Cache the live `docker info` result
   *  for a short TTL so we don't spawn `docker` in a tight loop. */
  private dockerCheckCache: { at: number; ok: boolean } | null = null;
  private static readonly DOCKER_CHECK_TTL_MS = 5_000;

  constructor(opts: SweRebenchV2EvaluatorHarnessOptions = {}) {
    this.stub = opts.stub ?? false;
    this.implStateDir = opts.implStateDir;
    this.ipfsRegistryUrl = opts.ipfsRegistryUrl ?? DEFAULT_IPFS_REGISTRY_URL;
    this.deps = opts._testDeps ?? {};
  }

  private async isDockerReachable(now: number = Date.now()): Promise<boolean> {
    const cached = this.dockerCheckCache;
    if (cached && now - cached.at < SweRebenchV2EvaluatorHarness.DOCKER_CHECK_TTL_MS) {
      return cached.ok;
    }
    const run = this.deps.runCommand ?? runCommand;
    const r = await run('docker', ['info']);
    this.dockerCheckCache = { at: now, ok: r.exitCode === 0 };
    return this.dockerCheckCache.ok;
  }

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'swe-rebench-v2.v1' && ctx.role === 'evaluation';
  }

  async canAttempt(task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (task.solverType !== 'swe-rebench-v2.v1') {
      return { ok: false, reason: 'solverType is not swe-rebench-v2.v1' };
    }
    if (task.role !== 'evaluation') {
      return { ok: false, reason: 'role is not evaluation' };
    }
    if (typeof task.context?.['restorationResult'] !== 'string') {
      return { ok: false, reason: 'context.restorationResult required' };
    }
    return { ok: true };
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    if (!this.implStateDir) {
      return {
        ready: false,
        reason: 'implStateDir not configured',
        nextStep: {
          description:
            'Configure JINN_ENGINE_IMPL_STATE_DIR_ROOT (or `engine.implStateDirRoot` in config) and restart the daemon.',
        },
      };
    }
    const state = readEnabledState(this.implStateDir);
    if (!state) {
      return {
        ready: false,
        reason: 'swe-rebench-v2 evaluator not enabled',
        nextStep: {
          description:
            `Run \`${ENABLE_CLI}\` to clone the upstream eval harness and validate Docker + Python.`,
          cli: ENABLE_CLI,
        },
      };
    }
    if (!existsSync(state.upstreamRepoDir)) {
      return {
        ready: false,
        reason: `upstream repo missing at ${state.upstreamRepoDir}`,
        nextStep: {
          description:
            `Re-run \`${ENABLE_CLI}\` to re-clone the upstream eval harness.`,
          cli: ENABLE_CLI,
        },
      };
    }
    // Live Docker probe (TTL-cached): the eval shells out to per-instance
    // `docker run` images. Docker is validated at `jinn harnesses enable` time,
    // but it can stop afterwards — re-check periodically so the daemon does
    // not claim evaluation tasks it cannot grade. (Without this, a stopped
    // Docker daemon turns every claimed eval into a bogus `passed_match:false`
    // verdict — see jinn-mono-uy6v.8.)
    if (!(await this.isDockerReachable())) {
      return {
        ready: false,
        reason: 'Docker daemon not reachable',
        nextStep: {
          description:
            'Start Docker Desktop (or the docker daemon) — the SWE-rebench v2 evaluator runs per-instance Docker images. Once Docker is up the evaluator becomes ready automatically.',
          url: 'https://docs.docker.com/get-docker/',
        },
      };
    }
    return { ready: true };
  }

  enableMetadata(): HarnessEnableMetadata {
    return {
      description:
        'swe-rebench-v2.v1 — code-issue benchmark from the SWE-rebench/SWE-rebench-V2 dataset. ' +
        'Requires Docker (per-instance images) and Python 3 (upstream eval.py harness). ' +
        'Enable will clone https://github.com/SWE-rebench/SWE-rebench-V2 into the impl state directory.',
      externalResources: [
        { name: 'SWE-rebench-V2 (upstream)', url: 'https://github.com/SWE-rebench/SWE-rebench-V2' },
        { name: 'Docker install', url: 'https://docs.docker.com/get-docker/' },
      ],
    };
  }

  async onEnable(_ctx: HarnessEnableContext): Promise<EnableResult> {
    if (!this.implStateDir) {
      return {
        status: 'error',
        message:
          'implStateDir is not configured. Set JINN_ENGINE_IMPL_STATE_DIR_ROOT (or engine.implStateDirRoot in config) and restart the daemon, then re-run.',
      };
    }
    const upstreamRepoDir = join(this.implStateDir, 'upstream');

    // Idempotent: if already enabled and the repo is present, we're done.
    const existing = readEnabledState(this.implStateDir);
    if (existing && existsSync(existing.upstreamRepoDir)) {
      return { status: 'ready', details: { upstreamRepoDir: existing.upstreamRepoDir } };
    }

    const run = this.deps.runCommand ?? runCommand;

    // Validate Docker (daemon reachable) before doing any disk work.
    const dockerCheck = await run('docker', ['info']);
    if (dockerCheck.exitCode !== 0) {
      return {
        status: 'waiting_for_external_action',
        action: {
          description:
            `Docker daemon is not reachable. Install Docker Desktop (or start the daemon), then re-run \`${ENABLE_CLI}\`.`,
          url: 'https://docs.docker.com/get-docker/',
        },
        nextInvocation: {
          cli: ENABLE_CLI,
          purpose: 'Re-validate Docker availability and continue setup.',
        },
      };
    }

    // Validate Python 3.
    const pythonCheck = await run('python3', ['--version']);
    if (pythonCheck.exitCode !== 0) {
      return {
        status: 'waiting_for_external_action',
        action: {
          description:
            'Python 3 is required to run the upstream eval.py harness. Install python3 and ensure it is on PATH, then re-run.',
        },
        nextInvocation: {
          cli: ENABLE_CLI,
          purpose: 'Re-validate Python availability and continue setup.',
        },
      };
    }

    // Clone upstream repo.
    await mkdir(this.implStateDir, { recursive: true, mode: 0o755 });
    if (!existsSync(upstreamRepoDir)) {
      const clone = await run('git', [
        'clone',
        '--depth=1',
        UPSTREAM_REPO_URL,
        upstreamRepoDir,
      ]);
      if (clone.exitCode !== 0) {
        return {
          status: 'error',
          message: `git clone failed (exit ${clone.exitCode}): ${clone.stderr.slice(-500)}`,
        };
      }
    }

    // Persist marker.
    const state: EnabledState = {
      schemaVersion: 'swe-rebench-v2-evaluator-state.v1',
      enabled: true,
      enabledAt: new Date().toISOString(),
      upstreamRepoDir,
    };
    await writeFile(join(this.implStateDir, STATE_FILE), JSON.stringify(state, null, 2));

    return {
      status: 'ready',
      details: { upstreamRepoDir },
    };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    if (this.stub) {
      throw new Error(
        'swe-rebench-v2-evaluator: stub registry cannot run evaluation (requires live daemon)',
      );
    }
    if (!this.implStateDir) {
      throw new Error(
        'swe-rebench-v2-evaluator: implStateDir not configured. Set engine.implStateDirRoot.',
      );
    }
    const state = readEnabledState(this.implStateDir);
    if (!state) {
      throw new Error(
        `swe-rebench-v2-evaluator: not enabled. Run \`${ENABLE_CLI}\`.`,
      );
    }

    const task = SweRebenchV2TaskSchema.parse(ctx.task.spec);

    // Parse the solver's restoration envelope and pull out the patch.
    const manifestJson = ctx.task.context!['restorationResult'] as string;
    const envelope = SignedEnvelopeSchema.parse(JSON.parse(manifestJson));
    if (envelope.solverType !== 'swe-rebench-v2.v1' || envelope.role !== 'restoration') {
      throw new Error(
        `swe-rebench-v2-evaluator: expected swe-rebench-v2.v1/restoration envelope, got ${envelope.solverType}/${envelope.role}`,
      );
    }
    const solutionPayload = SweRebenchV2SolutionPayloadSchema.parse(envelope.payload);

    const fetcher: HfFetcher = this.deps.fetcher ?? new HttpHfFetcher();
    const runner: EvalRunner =
      this.deps.runner ?? new PythonEvalRunner({ upstreamRepoDir: state.upstreamRepoDir });
    const evaluator = new SweRebenchV2Evaluator({ fetcher, runner });

    let graded: Awaited<ReturnType<SweRebenchV2Evaluator['grade']>>;
    try {
      graded = await evaluator.grade({ task, solutionPayload });
    } catch (err) {
      if (err instanceof EvalCouldNotGradeError) {
        // The eval never actually graded the solution (Docker down, patch
        // failed to apply, install/test-setup failed, arch-incompatible
        // image, …). There is no signal about the solver — emit no verdict.
        // SkippableError → engine records a skip, nothing is delivered.
        throw new SkippableError(
          `eval_not_gradeable:${err.reason}`,
          `${err.message}${err.logExcerpt ? `\n${err.logExcerpt}` : ''}`,
        );
      }
      throw err;
    }

    // Pin the test log to IPFS so anyone (evaluator dispute, audit, model
    // training) can fetch it anonymously by CID. The CID is surfaced via the
    // verdict-artifact's metadata, not the typed Verdict payload — the
    // schema does not couple Verdicts to daemon-derived IPFS provenance.
    const upload = this.deps.uploadToIpfs ?? uploadToIpfs;
    const test_log_cid = await upload(this.ipfsRegistryUrl, {
      kind: 'swe-rebench-v2-test-log.v1',
      instance_id: task.instance_id,
      log: graded.test_log,
      gradedAt: new Date().toISOString(),
    });

    const verdictPayload: SweRebenchV2VerdictPayload = {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: graded.score,
      passed_match: graded.passed_match,
      evaluator_cost_usd: 0,
    };
    const verdictArtifactPayload = {
      schemaVersion: 'swe-rebench-v2-verdict-artifact.v1',
      verdict: verdictPayload,
      informational: {
        instance_id: task.instance_id,
        round_month: task.round_month,
        test_log_cid,
      },
    };
    await writeFile(
      join(ctx.workingDir, 'swe-rebench-v2-verdict.json'),
      `${JSON.stringify(verdictArtifactPayload, null, 2)}\n`,
      'utf8',
    );

    // Derive the engine-facing `verdict` from `passed_match`. The engine's
    // reputation-feedback hook (and `verdictCodeForTask` for the on-chain
    // verdict tag in `claimDelivery`) keys on `gating.verdict`. Before this
    // mapping, the hook silently no-op'd on every swe-rebench-v2 delivery and
    // every verdict tag defaulted to PASS — see jinn-mono-uy6v.10.
    const verdict: SweRebenchVerdict = verdictPayload.passed_match ? 'PASS' : 'FAIL';

    return {
      venueRef: { name: 'swe-rebench-v2' },
      gating: {
        score: verdictPayload.score,
        passed_match: verdictPayload.passed_match,
        verdict,
      },
      informational: {
        instance_id: task.instance_id,
        round_month: task.round_month,
        test_log_cid,
      },
      verdictPayload: verdictPayload as unknown as Record<string, unknown>,
      artifacts: [
        {
          path: 'swe-rebench-v2-verdict.json',
          artifactType: 'swe-rebench_v2_verdict',
          metadata: {
            score: verdictPayload.score,
            passed_match: verdictPayload.passed_match,
            test_log_cid,
          },
          access: { priceUsdc: '0' },
        },
      ],
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  bin: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * The default `implStateDir` for the swe-rebench-v2 evaluator. The daemon
 * normally injects this via `engine.implStateDirRoot`; consumers (e.g. the
 * `validate-pool` CLI command) that need to locate the upstream eval repo
 * without going through the daemon use this default.
 */
export function defaultSweRebenchV2EvaluatorImplStateDir(): string {
  return join(process.env['HOME'] ?? homedir(), '.jinn-client', 'engine', 'impl-state', 'swe-rebench-v2-evaluator');
}

export function readEnabledState(implStateDir: string): EnabledState | null {
  const path = join(implStateDir, STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<EnabledState>;
    if (raw.enabled !== true || typeof raw.upstreamRepoDir !== 'string') return null;
    return raw as EnabledState;
  } catch {
    return null;
  }
}

export { runCommand };
