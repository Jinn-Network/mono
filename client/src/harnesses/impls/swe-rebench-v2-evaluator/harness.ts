/**
 * SWE-rebench v2 Evaluator Harness — wraps the {@link SweRebenchV2Evaluator}
 * grading library as a first-class {@link Harness} so the daemon dispatches
 * `swe-rebench-v2.v1` evaluation tasks to it.
 *
 * Operator setup is automated via {@link SweRebenchV2EvaluatorHarness.onEnable}:
 *   `jinn harnesses enable swe-rebench-v2-evaluator`
 *   - Validates Docker + Python availability.
 *   - Pins the upstream `SWE-rebench/SWE-rebench-V2` checkout at a reviewed commit.
 *   - Applies the versioned Jinn report/parser bundle and runs its Python self-test.
 *   - Writes a state marker binding commit, bundle digest, and trusted parser metadata.
 *
 * `isReady()` reports `ready: false` (with a `nextStep` pointing at the
 * enable command) until a current durable marker is written.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.4
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
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
import { SignedEnvelopeSchema, normalizeEnvelopeRole } from '../../../types/envelope.js';
import { fetchFromIpfs, uploadToIpfs } from '../../../adapters/mech/ipfs.js';
import { SweRebenchV2Evaluator, type EvalRunner, type HfFetcher, type HfRow } from './index.js';
import {
  PythonEvalRunner,
  EvalCouldNotGradeError,
  type PythonEvalRunnerOptions,
} from './eval-runner.js';
import { HttpHfFetcher } from './hf-fetcher.js';
import { RoutingTaskRowFetcher, parseMintedPoolArtifact } from './routing-task-row-fetcher.js';
import {
  ValidatedPoolStore,
  EVAL_SEMANTICS_VERSION,
  hashVettedPoolArtifact,
  loadVettedPoolArtifactScorableEntries,
  parseVettedPoolArtifact,
  vettedPoolArtifactRefFromEligibility,
  type ScorableVettedPoolArtifactEntries,
  type SweRebenchV2VettedPoolArtifactEntry,
  type V2MintedEnvironmentAdmissionBinding,
} from '../../../solver-types/_swe-rebench-v2-validated-pool.js';
import {
  computeRowHash,
  pullDigestQualifiedImage,
  resolveImageDigest,
  resolveImagePlatform,
  type CommandRunner,
  type CommandResult,
} from '../../../solver-types/_swe-rebench-v2-substrate.js';
import {
  computeMintedPoolRowV2Hash,
  isMintedPoolRowV2,
  parseMintedIpfsDataset,
  type DifferentialAdmissionReceiptReferenceV2,
  type MintedEnvironmentBindingV1,
  type MintedPoolRowV2,
} from '../../../solver-types/_swe-rebench-v2-minted-pool.js';
import {
  hashTaskEnvironmentSpecV1,
  parseTaskEnvironmentSpecV1,
  verifyEnvironmentAttestationV1,
  type TaskEnvironmentSpecV1,
  type TrustedParserIdentityV1,
} from '../../../task-creator/environment/contracts.js';
import { canonicalJson } from '../../../util/canonical-json.js';
import {
  hashDifferentialAdmissionReceiptV2,
  targetRecipeCommandForTestPath,
  verifyDifferentialAdmissionReceiptV2,
  type DifferentialAdmissionReceiptV2,
} from '../../../solver-types/_swe-rebench-v2-differential-admission.js';
import type { PoolTask } from '../../../solver-types/_swe-rebench-v2-pool.js';
import {
  defaultStateDir as defaultSolverTypeStateDir,
  loadSweRebenchV2Pool,
} from '../../../solver-types/swe-rebench-v2.js';
import {
  PoolCacheStore,
  loadPoolWithCacheFallback,
} from '../../../solver-types/_swe-rebench-v2-pool-cache.js';

const DEFAULT_IPFS_REGISTRY_URL = 'https://registry.autonolas.tech';
const DEFAULT_IPFS_GATEWAY_URL = 'https://gateway.autonolas.tech';
const UPSTREAM_REPO_URL = 'https://github.com/SWE-rebench/SWE-rebench-V2.git';
const UPSTREAM_COMMIT = 'c71902a8cf8d2b725f63d51f199f4d3e56f68d2d';
const PATCH_BUNDLE_ID = 'jinn.swe-rebench-v2.patch-bundle.v1';
const PATCH_BUNDLE_VERSION = 'v1';
const PATCH_BUNDLE_FILE = 'swe-rebench-v2-evaluator.bundle.v1.patch';
const VITEST_JSON_PARSER = { id: 'vitest-json.v1', version: 'v1' } as const;
const STATE_FILE = 'state.json';
const ENABLE_CLI = 'jinn harnesses enable swe-rebench-v2-evaluator';
const DEFAULT_EVAL_COMPUTE_USD_PER_HOUR = 0.2;

/**
 * Resolve the compute rate (USD/hour) used to meter `evaluator_cost_usd`
 * from wall-clock grade() time (#1828). Env-only: unset → default 0.20;
 * explicit invalid or ≤0 value → 0 with a warning — a misconfigured rate
 * must never throw or block an eval.
 */
function resolveComputeUsdPerHour(): number {
  const envRaw = process.env['JINN_EVAL_COMPUTE_USD_PER_HOUR'];
  if (envRaw === undefined) return DEFAULT_EVAL_COMPUTE_USD_PER_HOUR;
  const parsed = Number(envRaw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(
    '[swe-rebench-v2] JINN_EVAL_COMPUTE_USD_PER_HOUR is not a positive number — ' +
      'recording evaluator_cost_usd=0',
  );
  return 0;
}

/**
 * The source tree keeps the bundle in `client/scripts`; the published package
 * copies it to `dist/scripts`. Resolve both layouts so `tsx` development runs
 * and the built CLI apply the identical, versioned patch bytes.
 */
function patchBundlePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../../scripts', PATCH_BUNDLE_FILE),
    resolve(here, '../../../scripts', PATCH_BUNDLE_FILE),
  ];
  const path = candidates.find(existsSync);
  if (!path) {
    throw new Error(`missing ${PATCH_BUNDLE_FILE}; reinstall @jinn-network/client`);
  }
  return path;
}

function patchBundleMetadata(bundlePath: string): PatchBundleMetadata {
  const digest = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
  return {
    id: PATCH_BUNDLE_ID,
    version: PATCH_BUNDLE_VERSION,
    sha256: `sha256:${digest}`,
  };
}

function hasCurrentEnableContract(state: ReadEnabledState | null): state is EnabledState {
  if (!state || state.schemaVersion !== 'swe-rebench-v2-evaluator-state.v2') return false;
  if (state.upstream?.repoUrl !== UPSTREAM_REPO_URL || state.upstream?.commit !== UPSTREAM_COMMIT) return false;
  if (state.patchBundle?.id !== PATCH_BUNDLE_ID || state.patchBundle.version !== PATCH_BUNDLE_VERSION) return false;
  return state.trustedParsers.some((parser) =>
    parser.id === VITEST_JSON_PARSER.id &&
    parser.version === VITEST_JSON_PARSER.version &&
    parser.bundleId === state.patchBundle.id &&
    parser.bundleSha256 === state.patchBundle.sha256,
  );
}

function isCurrentEnabledState(
  state: ReadEnabledState | null,
  bundle: PatchBundleMetadata,
  upstreamRepoDir: string,
): state is EnabledState {
  if (!hasCurrentEnableContract(state)) return false;
  if (state.upstreamRepoDir !== upstreamRepoDir) return false;
  if (
    state.patchBundle.id !== bundle.id ||
    state.patchBundle.version !== bundle.version ||
    state.patchBundle.sha256 !== bundle.sha256
  ) return false;
  return state.trustedParsers.some((parser) =>
    parser.bundleId === bundle.id &&
    parser.bundleSha256 === bundle.sha256,
  );
}

function sameParser(a: TrustedParserIdentityV1, b: TrustedParserIdentityV1): boolean {
  return a.id === b.id && a.version === b.version && a.digest === b.digest && a.bundleId === b.bundleId;
}

function sameAttestation(
  a: TaskEnvironmentSpecV1['attestation'],
  b: TaskEnvironmentSpecV1['attestation'],
): boolean {
  return a.scheme === b.scheme &&
    a.algo === b.algo &&
    a.environmentHash === b.environmentHash &&
    a.operatorSafe.toLowerCase() === b.operatorSafe.toLowerCase() &&
    a.signer.toLowerCase() === b.signer.toLowerCase() &&
    a.signature.toLowerCase() === b.signature.toLowerCase();
}

function sameV2AdmissionBinding(
  a: V2MintedEnvironmentAdmissionBinding,
  b: MintedEnvironmentBindingV1,
): boolean {
  return a.environmentSpecCid === b.environmentSpecCid &&
    a.environmentHash === b.environmentHash &&
    sameParser(a.parser, b.parser) &&
    a.image.reference === b.image.reference &&
    a.image.digest === b.image.digest &&
    a.platform === b.platform;
}

function sameDifferentialAdmissionBinding(
  a: DifferentialAdmissionReceiptReferenceV2,
  b: DifferentialAdmissionReceiptReferenceV2,
): boolean {
  return a.admissionPolicyVersion === b.admissionPolicyVersion &&
    a.receiptCid === b.receiptCid &&
    a.receiptHash === b.receiptHash;
}

function canonicalCommandHash(command: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(command)).digest('hex')}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Runs without Docker: it proves the patched final report exposes actual
 * empirical sets and that the checked-in Vitest JSON parser is registered. */
const EMPIRICAL_SELF_TEST = [
  'import json',
  'from scripts.eval import build_report_item',
  'from lib.agent.log_parsers import NAME_TO_PARSER, TestStatus',
  "item = build_report_item({'instance_id': 'jinn-enable-self-test', 'FAIL_TO_PASS': [], 'PASS_TO_PASS': []}, {'result': {'passed_actual': ['passes'], 'failed_actual': ['fails'], 'passed_match': False, 'exit_code': 1, 'log_path': 'log'}})",
  "assert item['passed_actual'] == ['passes']",
  "assert item['failed_actual'] == ['fails']",
  "parser = NAME_TO_PARSER['vitest-json.v1']",
  "parsed = parser(json.dumps({'testResults': [{'assertionResults': [{'fullName': 'suite passes', 'status': 'passed'}, {'ancestorTitles': ['suite'], 'title': 'fails', 'status': 'failed'}]}]}))",
  "assert parsed == {'suite passes': TestStatus.PASSED.value, 'suite fails': TestStatus.FAILED.value}",
].join('\n');

/** The two verdict values emitted by this evaluator. The broader registry
 *  shape (`reputation.ts`) also recognises `'INDETERMINATE'` / `'REJECTED'`,
 *  but swe-rebench v2 grades are binary: the gold tests either resolve or
 *  they don't. Mirrors the pattern in `prediction-v0-evaluator/types.ts`. */
type SweRebenchVerdict = 'PASS' | 'FAIL';

interface LegacyEnabledState {
  schemaVersion: 'swe-rebench-v2-evaluator-state.v1';
  enabled: true;
  enabledAt: string;
  upstreamRepoDir: string;
}

interface PatchBundleMetadata {
  id: typeof PATCH_BUNDLE_ID;
  version: typeof PATCH_BUNDLE_VERSION;
  sha256: `sha256:${string}`;
}

interface EnabledState {
  schemaVersion: 'swe-rebench-v2-evaluator-state.v2';
  enabled: true;
  enabledAt: string;
  upstreamRepoDir: string;
  upstream: {
    repoUrl: typeof UPSTREAM_REPO_URL;
    commit: typeof UPSTREAM_COMMIT;
  };
  patchBundle: PatchBundleMetadata;
  trustedParsers: Array<{
    id: typeof VITEST_JSON_PARSER.id;
    version: typeof VITEST_JSON_PARSER.version;
    bundleId: typeof PATCH_BUNDLE_ID;
    bundleSha256: `sha256:${string}`;
  }>;
}

type ReadEnabledState = EnabledState | LegacyEnabledState;

export type CurrentSweRebenchV2EvaluatorEnableContract =
  | { ok: true; upstreamRepoDir: string }
  | { ok: false; reason: string; nextStep: string };

export interface CurrentSweRebenchV2EvaluatorEnableContractFacts {
  state: unknown;
  implStateDir: string;
  currentPatchBundle: PatchBundleMetadata;
  checkoutExists: boolean;
}

interface CachedPublishedPoolArtifact {
  evalSemanticsVersion: string;
  artifactHash: string;
  entries: ScorableVettedPoolArtifactEntries;
}

/**
 * Docker-free validation of the durable evaluator enable contract.
 *
 * This is the single production predicate for callers that need the managed
 * checkout but must not invoke the harness readiness probe. It binds the
 * marker to the managed path, current pinned upstream metadata, current patch
 * bundle digest, trusted parser binding, and checkout existence.
 */
export function validateCurrentSweRebenchV2EvaluatorEnableContract(
  facts: CurrentSweRebenchV2EvaluatorEnableContractFacts,
): CurrentSweRebenchV2EvaluatorEnableContract {
  const managedUpstreamRepoDir = join(facts.implStateDir, 'upstream');
  const state = isLegacyEnabledState(facts.state) || isEnabledState(facts.state)
    ? facts.state
    : null;
  if (!state) {
    return {
      ok: false,
      reason: 'swe-rebench-v2 evaluator not enabled',
      nextStep: `Run \`${ENABLE_CLI}\` to install and validate the evaluator.`,
    };
  }
  if (state.upstreamRepoDir !== managedUpstreamRepoDir) {
    return {
      ok: false,
      reason: 'swe-rebench-v2 evaluator enable state requires durable bundle repair',
      nextStep: `Run \`${ENABLE_CLI}\` to restore the managed evaluator checkout.`,
    };
  }
  if (!facts.checkoutExists) {
    return {
      ok: false,
      reason: `upstream repo missing at ${managedUpstreamRepoDir}`,
      nextStep: `Run \`${ENABLE_CLI}\` to re-clone the upstream eval harness.`,
    };
  }
  if (!isCurrentEnabledState(state, facts.currentPatchBundle, managedUpstreamRepoDir)) {
    return {
      ok: false,
      reason: 'swe-rebench-v2 evaluator enable state requires durable bundle repair',
      nextStep: `Run \`${ENABLE_CLI}\` to pin and self-test the upstream evaluator bundle.`,
    };
  }
  return { ok: true, upstreamRepoDir: managedUpstreamRepoDir };
}

/**
 * Read-only production adapter for the pure current-contract validator.
 * Resolves the versioned patch asset and filesystem facts, but deliberately
 * performs no Docker or network probe.
 */
export function inspectCurrentSweRebenchV2EvaluatorEnableContract(
  implStateDir: string,
): CurrentSweRebenchV2EvaluatorEnableContract {
  const managedUpstreamRepoDir = join(implStateDir, 'upstream');
  let currentPatchBundle: PatchBundleMetadata;
  try {
    currentPatchBundle = patchBundleMetadata(patchBundlePath());
  } catch (err) {
    return {
      ok: false,
      reason: `cannot load durable evaluator patch bundle: ${err instanceof Error ? err.message : String(err)}`,
      nextStep: `Reinstall @jinn-network/client, then run \`${ENABLE_CLI}\`.`,
    };
  }
  return validateCurrentSweRebenchV2EvaluatorEnableContract({
    state: readEnabledState(implStateDir),
    implStateDir,
    currentPatchBundle,
    checkoutExists: existsSync(managedUpstreamRepoDir),
  });
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
  /** IPFS gateway URL used to fetch launcher-published vetted pool artifacts. */
  ipfsGatewayUrl?: string;
  /**
   * Durable swe-rebench-v2 state dir (validated pool substrate). Wired from
   * `config.sweRebenchV2StateDir` via `buildHarnesses`. Falls back to
   * `defaultStateDir()` when omitted (tests / stub registries).
   */
  stateDir?: string;
  /**
   * Test-only injection points. Production runs use Node's child_process
   * + node:fs + the bundled HFFetcher / PythonEvalRunner.
   */
  _testDeps?: {
    runCommand?: typeof runCommand;
    /** Override for `onEnable`'s upstream-patch step. Defaults to {@link applyUpstreamPatches}. */
    applyUpstreamPatches?: typeof applyUpstreamPatches;
    fetcher?: HfFetcher;
    /**
     * Per-call runner override. When set, used directly on every `run()` —
     * the harness skips the lazy/cached path. Tests that need a fresh mock
     * per call typically also rebuild the harness per call, so this is
     * effectively a single-runner override.
     */
    runner?: EvalRunner;
    /**
     * Factory used to construct the cached runner the first time `run()`
     * fires (and only then). Tests use this to verify the runner is reused
     * across `run()` calls — the {@link runner} instance-injection point
     * makes that test invisible because it short-circuits caching entirely.
     * Defaults to `(opts) => new PythonEvalRunner(opts)`.
     */
    makeRunner?: (opts: PythonEvalRunnerOptions) => EvalRunner;
    uploadToIpfs?: typeof uploadToIpfs;
    fetchFromIpfs?: typeof fetchFromIpfs;
    /**
     * Override the state directory used for the {@link ValidatedPoolStore}
     * substrate-recheck. Production prefers the first-class `stateDir`
     * option on {@link SweRebenchV2EvaluatorHarnessOptions}; this remains
     * for tests. Falls back to `defaultStateDir()` when both are omitted.
     */
    stateDir?: string;
    /**
     * Override the pool-loading function used to resolve `patch` and
     * `base_commit` at verdict time for rowHash recomputation.
     * Defaults to `loadSweRebenchV2Pool()`.
     */
    loadPool?: () => Promise<PoolTask[]>;
  };
}

export class SweRebenchV2EvaluatorHarness implements Harness {
  readonly name = 'swe-rebench-v2-evaluator';
  readonly version = '1.0.0';

  private readonly stub: boolean;
  private readonly implStateDir: string | undefined;
  private readonly ipfsRegistryUrl: string;
  private readonly ipfsGatewayUrl: string;
  private readonly stateDir: string | undefined;
  private readonly deps: NonNullable<SweRebenchV2EvaluatorHarnessOptions['_testDeps']>;
  /** The engine's claim-eligibility check calls `isReady()` per candidate
   *  task per tick (~17 Hz potential). Cache the live `docker info` result
   *  for a short TTL so we don't spawn `docker` in a tight loop. */
  private dockerCheckCache: { at: number; ok: boolean } | null = null;
  private static readonly DOCKER_CHECK_TTL_MS = 5_000;
  /**
   * Lazily-constructed runner reused across every `run()` call for the
   * lifetime of this harness instance. The harness is registered once at
   * boot (`buildHarnesses()` in `impls/index.ts`), so a cached runner here
   * persists for the daemon lifetime. The runner holds the in-process LRU
   * of eval-image tags; without this caching the LRU is rebuilt empty per
   * call and the disk-budget bead (jinn-mono-uy6v.11) is a no-op.
   */
  private cachedRunner: EvalRunner | undefined;
  private cachedFetcher: HfFetcher | undefined;
  private cachedPool:
    | { stateDir: string; promise: Promise<PoolTask[]> }
    | undefined;
  private readonly publishedPoolArtifactCache = new Map<string, Promise<CachedPublishedPoolArtifact>>();

  constructor(opts: SweRebenchV2EvaluatorHarnessOptions = {}) {
    this.stub = opts.stub ?? false;
    this.implStateDir = opts.implStateDir;
    this.ipfsRegistryUrl = opts.ipfsRegistryUrl ?? DEFAULT_IPFS_REGISTRY_URL;
    this.ipfsGatewayUrl = opts.ipfsGatewayUrl ?? process.env['JINN_IPFS_GATEWAY_URL'] ?? DEFAULT_IPFS_GATEWAY_URL;
    this.stateDir = opts.stateDir ?? opts._testDeps?.stateDir;
    this.deps = opts._testDeps ?? {};
  }

  /**
   * Resolve the {@link EvalRunner} used for a `run()` invocation. The
   * runner is constructed lazily on the first call and reused thereafter so
   * the LRU image cache (`jinn-mono-uy6v.11`) actually accumulates across
   * evaluations. A {@link _testDeps.runner} override bypasses caching for
   * tests that want a fresh mock per call.
   */
  private getRunner(upstreamRepoDir: string): EvalRunner {
    if (this.deps.runner) return this.deps.runner;
    if (!this.cachedRunner) {
      const make =
        this.deps.makeRunner ??
        ((opts: PythonEvalRunnerOptions) => new PythonEvalRunner(opts));
      this.cachedRunner = make({ upstreamRepoDir });
    }
    return this.cachedRunner;
  }

  private getFetcher(): HfFetcher {
    if (this.deps.fetcher) return this.deps.fetcher;
    if (!this.cachedFetcher) {
      const fetchArtifact = this.deps.fetchFromIpfs ?? fetchFromIpfs;
      this.cachedFetcher = new RoutingTaskRowFetcher({
        hf: new HttpHfFetcher(),
        fetchMintedArtifact: async (cid) =>
          parseMintedPoolArtifact(await fetchArtifact(this.ipfsGatewayUrl, cid)),
      });
    }
    return this.cachedFetcher;
  }

  private loadPoolForRecheck(stateDir: string): Promise<PoolTask[]> {
    if (!this.cachedPool || this.cachedPool.stateDir !== stateDir) {
      const loadPool = this.deps.loadPool ?? loadSweRebenchV2Pool;
      const promise = loadPoolWithCacheFallback({
        loadPool,
        cache: new PoolCacheStore({ stateDir }),
        currentPool: [],
      }).then((result) => {
        if (result.pool.length > 0) return result.pool;
        if (result.error) {
          throw new Error(result.error.message);
        }
        return result.pool;
      });
      this.cachedPool = { stateDir, promise };
    }
    const cached = this.cachedPool;
    return cached.promise.catch((err) => {
      if (this.cachedPool === cached) {
        this.cachedPool = undefined;
      }
      throw err;
    });
  }

  private loadPublishedPoolArtifact(artifactCid: string): Promise<CachedPublishedPoolArtifact> {
    const cached = this.publishedPoolArtifactCache.get(artifactCid);
    if (cached) return cached;

    const fetchArtifact = this.deps.fetchFromIpfs ?? fetchFromIpfs;
    const promise = (async () => {
      let rawArtifact: unknown;
      try {
        rawArtifact = await fetchArtifact(this.ipfsGatewayUrl, artifactCid);
      } catch (err) {
        throw new SkippableError(
          'vetted_pool_fetch_failed',
          `cannot fetch vetted pool artifact ${artifactCid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const artifact = parseVettedPoolArtifact(rawArtifact);
        return {
          evalSemanticsVersion: artifact.evalSemanticsVersion,
          artifactHash: hashVettedPoolArtifact(artifact),
          entries: loadVettedPoolArtifactScorableEntries(artifact),
        };
      } catch (err) {
        throw new SkippableError(
          'vetted_pool_artifact_invalid',
          `invalid vetted pool artifact ${artifactCid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    this.publishedPoolArtifactCache.set(artifactCid, promise);
    promise.catch(() => {
      if (this.publishedPoolArtifactCache.get(artifactCid) === promise) {
        this.publishedPoolArtifactCache.delete(artifactCid);
      }
    });
    return promise;
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
    const enableContract =
      inspectCurrentSweRebenchV2EvaluatorEnableContract(this.implStateDir);
    if (!enableContract.ok) {
      return {
        ready: false,
        reason: enableContract.reason,
        nextStep: {
          description: enableContract.nextStep,
          cli: ENABLE_CLI,
        },
      };
    }
    const upstreamRepoDir = enableContract.upstreamRepoDir;
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
        'Enable pins and self-tests https://github.com/SWE-rebench/SWE-rebench-V2 in the impl state directory.',
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
    const existing = readEnabledState(this.implStateDir);
    // Never trust the marker to select a checkout: a stale or corrupt marker
    // must be repairable without allowing `checkout --force` / `reset --hard`
    // to run in another repository.
    //
    // WP1 (#1646): operators who enabled before a given upstream patch shipped
    // must still receive it. next's enable path already re-runs the self-test
    // and `applyUpstreamPatches` unconditionally on every enable (the guarded
    // block below only skips the clone/checkout when the marker is already
    // current), so the patches are re-applied idempotently without a separate
    // already-enabled fast-path early-return.
    const upstreamRepoDir = join(this.implStateDir, 'upstream');

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

    let bundlePath: string;
    let bundle: PatchBundleMetadata;
    try {
      bundlePath = patchBundlePath();
      bundle = patchBundleMetadata(bundlePath);
    } catch (err) {
      return {
        status: 'error',
        message: `cannot load durable evaluator patch bundle: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // A v2 marker binds the exact commit, patch bytes, and parser registry.
    // Any legacy or stale marker is repaired from a clean checkout. The
    // upstream directory is managed evaluator state, so --force is deliberate:
    // carrying a local manual patch forward would defeat the recorded binding.
    if (!isCurrentEnabledState(existing, bundle, upstreamRepoDir) || !existsSync(upstreamRepoDir)) {
      await mkdir(this.implStateDir, { recursive: true, mode: 0o755 });
      if (!existsSync(upstreamRepoDir)) {
        const clone = await run('git', [
          'clone',
          '--no-checkout',
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

      const fetch = await run('git', ['fetch', '--depth=1', 'origin', UPSTREAM_COMMIT], { cwd: upstreamRepoDir });
      if (fetch.exitCode !== 0) {
        return {
          status: 'error',
          message: `git fetch pinned upstream failed (exit ${fetch.exitCode}): ${fetch.stderr.slice(-500)}`,
        };
      }
      const checkout = await run('git', ['checkout', '--detach', '--force', UPSTREAM_COMMIT], { cwd: upstreamRepoDir });
      if (checkout.exitCode !== 0) {
        return {
          status: 'error',
          message: `git checkout pinned upstream failed (exit ${checkout.exitCode}): ${checkout.stderr.slice(-500)}`,
        };
      }
      const reset = await run('git', ['reset', '--hard', UPSTREAM_COMMIT], { cwd: upstreamRepoDir });
      if (reset.exitCode !== 0) {
        return {
          status: 'error',
          message: `git reset pinned upstream failed (exit ${reset.exitCode}): ${reset.stderr.slice(-500)}`,
        };
      }
      const patchCheck = await run('git', ['apply', '--check', bundlePath], { cwd: upstreamRepoDir });
      if (patchCheck.exitCode !== 0) {
        return {
          status: 'error',
          message: `evaluator patch bundle is incompatible with ${UPSTREAM_COMMIT}: ${patchCheck.stderr.slice(-500)}`,
        };
      }
      const apply = await run('git', ['apply', bundlePath], { cwd: upstreamRepoDir });
      if (apply.exitCode !== 0) {
        return {
          status: 'error',
          message: `evaluator patch bundle failed to apply: ${apply.stderr.slice(-500)}`,
        };
      }
    }

    // Never write the durable marker until both empirical actual-result fields
    // and the trusted Vitest JSON parser work in the patched upstream tree.
    const selfTest = await run('python3', ['-c', EMPIRICAL_SELF_TEST], { cwd: upstreamRepoDir });
    if (selfTest.exitCode !== 0) {
      return {
        status: 'error',
        message: `patched upstream empirical self-test failed (exit ${selfTest.exitCode}): ${selfTest.stderr.slice(-500)}`,
      };
    }

    // Apply Jinn's upstream eval.py patches (idempotent — see applyUpstreamPatches).
    try {
      (this.deps.applyUpstreamPatches ?? applyUpstreamPatches)(upstreamRepoDir);
    } catch (err) {
      return {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // Persist marker.
    const state: EnabledState = {
      schemaVersion: 'swe-rebench-v2-evaluator-state.v2',
      enabled: true,
      enabledAt: new Date().toISOString(),
      upstreamRepoDir,
      upstream: { repoUrl: UPSTREAM_REPO_URL, commit: UPSTREAM_COMMIT },
      patchBundle: bundle,
      trustedParsers: [{
        ...VITEST_JSON_PARSER,
        bundleId: bundle.id,
        bundleSha256: bundle.sha256,
      }],
    };
    await writeFile(join(this.implStateDir, STATE_FILE), JSON.stringify(state, null, 2));

    return {
      status: 'ready',
      details: { upstreamRepoDir, upstreamCommit: UPSTREAM_COMMIT, patchBundle: bundle.id },
    };
  }

  /**
   * Performs the verdict-time substrate recheck for a task:
   *   1. Verifies the admission record exists and is scorable.
   *   2. Fetches the current HF row and checks for rowHash drift.
   *   3. Checks for imageDigest drift if the admission carries one.
   *
   * Returns the live {@link HfRow} for use by the grading evaluator.
   * Throws {@link SkippableError} on any mismatch — never fails open.
   */
  private async recheckSubstrate(
    task: ReturnType<typeof SweRebenchV2TaskSchema.parse>,
    fetcher: HfFetcher,
    loadPool: () => Promise<PoolTask[]>,
    stateDir: string,
  ): Promise<HfRow> {
    const admissionStore = new ValidatedPoolStore({ stateDir });
    const admission = await admissionStore.getEntry(task.instance_id, EVAL_SEMANTICS_VERSION);

    if (!admission || !admission.scorable) {
      throw new SkippableError(
        'admission_missing_or_unscorable',
        `no scorable admission for ${task.instance_id} under semanticsVersion=${EVAL_SEMANTICS_VERSION}`,
      );
    }

    let recheckRow: HfRow;
    try {
      recheckRow = await fetcher.fetchTaskRow({
        hf_dataset: task.hf_dataset,
        hf_split: task.hf_split,
        instance_id: task.instance_id,
      });
    } catch (err) {
      throw new SkippableError(
        'hf_fetch_failed',
        `cannot verify substrate (HF unreachable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Load the pool task to access the gold `patch` field for rowHash
    // recomputation. The on-chain task schema carries base_commit and repo,
    // but not the gold patch — that lives only in the HF pool rows. Loading
    // the pool here keeps rowHash inputs symmetric with validate-pool time.
    // (Preferred approach per Task 9 spec; pool is small, O(hundreds) rows.)
    if (admission.rowHash) {
      let goldPatch: string;
      try {
        const pool = await loadPool();
        const poolTask = pool.find((t) => t.instance_id === task.instance_id);
        // Fall back to empty string if not found — matches validate-pool's
        // `task.patch ?? ''` defensive fallback for degenerate rows.
        goldPatch = poolTask?.patch ?? '';
      } catch (err) {
        // Pool load failed (HF outage, cache corruption, etc.) — can't recompute rowHash.
        // Distinct from `hf_fetch_failed` (HF row fetch) so operators can
        // distinguish the two failure modes in log aggregation.
        throw new SkippableError(
          'substrate_pool_load_failed',
          `cannot verify substrate (pool load failed): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const currentRowHash = computeRowHash({
        hf_dataset: task.hf_dataset,
        hf_split: task.hf_split,
        instance_id: task.instance_id,
        repo: task.repo,
        base_commit: task.base_commit,
        image_name: recheckRow.image_name,
        patch: goldPatch,
        test_patch: recheckRow.test_patch,
        // HF rows may have `install` as undefined for some rows; validate-pool
        // stored it as `[]` in that case, so we mirror that coercion here so
        // the rowHash inputs are byte-identical to admission time.
        install_config: { ...recheckRow.install_config, install: recheckRow.install_config.install ?? [] },
        FAIL_TO_PASS: recheckRow.FAIL_TO_PASS,
        PASS_TO_PASS: recheckRow.PASS_TO_PASS,
      });
      if (currentRowHash !== admission.rowHash) {
        throw new SkippableError(
          'substrate_drift_rowHash',
          `rowHash drift for ${task.instance_id}: admitted=${admission.rowHash}, current=${currentRowHash}`,
        );
      }
    }

    if (admission.imageDigest) {
      // runCommand accepts SpawnOptions (superset of { cwd? }), so it satisfies
      // CommandRunner at the call sites resolveImageDigest uses.
      const commandRunner: CommandRunner = (this.deps.runCommand ?? runCommand) as CommandRunner;
      const currentDigest = await resolveImageDigest(recheckRow.image_name, commandRunner);
      if (currentDigest && currentDigest !== admission.imageDigest) {
        throw new SkippableError(
          'substrate_drift_imageDigest',
          `imageDigest drift for ${task.instance_id}: admitted=${admission.imageDigest}, current=${currentDigest}`,
        );
      }
      // currentDigest === null is tolerated — the image may not be cached
      // locally yet (the eval-runner pulls on demand). The admission already
      // verified the digest at validate-pool time; a null here just means
      // the image isn't present locally, not that it changed.
    }

    return recheckRow;
  }

  /**
   * Recheck an explicit-environment v2 minted row. Unlike v1 benchmark rows,
   * every grading input is supplied by the immutable IPFS artifact and the
   * signed TaskEnvironmentSpec. Any missing/changed observation is a skip —
   * never a fallback to a local admission record or a binary verdict.
   */
  private async recheckMintedV2(
    task: ReturnType<typeof SweRebenchV2TaskSchema.parse>,
    runtimeTask: Task,
    fetcher: HfFetcher,
    enabledState: ReadEnabledState,
  ): Promise<HfRow | null> {
    if (!parseMintedIpfsDataset(task.hf_dataset)) return null;
    if (!(fetcher instanceof RoutingTaskRowFetcher)) {
      throw new SkippableError(
        'minted_pool_router_unavailable',
        `cannot resolve immutable minted artifact for ${task.instance_id}`,
      );
    }

    let routed;
    try {
      routed = await fetcher.fetchMintedRow({
        hf_dataset: task.hf_dataset,
        instance_id: task.instance_id,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SkippableError(
        /publicRowHash/u.test(detail) ? 'minted_substrate_drift_public_row_hash' : 'minted_pool_artifact_invalid',
        `cannot load minted artifact for ${task.instance_id}: ${detail}`,
      );
    }
    // v1 is deliberately routed through the historical admission path below.
    if (!routed || routed.artifact.schemaVersion !== 'swe-rebench-v2-minted-pool.v2') return null;
    if (routed.artifact.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION) {
      throw new SkippableError(
        'minted_pool_semantics_mismatch',
        `minted artifact semanticsVersion=${routed.artifact.evalSemanticsVersion} does not match evaluator semanticsVersion=${EVAL_SEMANTICS_VERSION}`,
      );
    }
    if (!isMintedPoolRowV2(routed.row)) {
      throw new SkippableError('minted_pool_artifact_invalid', `v2 artifact row lacks v2 bindings for ${task.instance_id}`);
    }
    const row = routed.row;
    const binding = row.environment;

    if (computeMintedPoolRowV2Hash(row) !== row.publicRowHash) {
      throw new SkippableError(
        'minted_substrate_drift_public_row_hash',
        `public row hash drift for ${task.instance_id}`,
      );
    }
    if (
      row.instance_id !== task.instance_id ||
      row.repo !== task.repo ||
      row.base_commit !== task.base_commit ||
      row.language !== task.language
    ) {
      throw new SkippableError(
        'minted_substrate_task_binding_drift',
        `on-chain task fields do not match v2 minted row for ${task.instance_id}`,
      );
    }
    if (row.image_name !== binding.image.reference || row.install_config.log_parser !== binding.parser.id) {
      throw new SkippableError(
        'minted_substrate_grading_binding_drift',
        `grading image or parser id does not match v2 environment binding for ${task.instance_id}`,
      );
    }

    const admission = await this.requireMintedV2Admission(task, runtimeTask, row);

    const spec = await this.loadAndVerifyMintedEnvironmentSpec(binding, task, enabledState);
    await this.recheckMintedV2DifferentialAdmission(task, row, admission, spec);
    // The environment contract declares the image which the runner must use;
    // checking the row too prevents a public artifact from redirecting tests to
    // an otherwise valid but unrelated environment image.
    if (spec.execution.image.reference !== row.image_name) {
      throw new SkippableError(
        'minted_substrate_image_reference_drift',
        `v2 row image does not match published environment spec for ${task.instance_id}`,
      );
    }

    const commandRunner: CommandRunner = (this.deps.runCommand ?? runCommand) as CommandRunner;
    if (!(await pullDigestQualifiedImage(binding.image.reference, commandRunner))) {
      throw new SkippableError(
        'minted_substrate_image_pull_failed',
        `cannot pull digest-qualified evaluator image for ${task.instance_id}`,
      );
    }
    const currentDigest = await resolveImageDigest(binding.image.reference, commandRunner);
    if (!currentDigest) {
      throw new SkippableError(
        'minted_substrate_image_unavailable',
        `cannot inspect digest-qualified evaluator image for ${task.instance_id}`,
      );
    }
    if (currentDigest !== binding.image.digest) {
      throw new SkippableError(
        'minted_substrate_drift_image_digest',
        `evaluator image digest drift for ${task.instance_id}: bound=${binding.image.digest}, current=${currentDigest}`,
      );
    }
    const currentPlatform = await resolveImagePlatform(binding.image.reference, commandRunner);
    if (currentPlatform !== binding.platform) {
      throw new SkippableError(
        'minted_substrate_drift_image_platform',
        `evaluator image platform unavailable or mismatched for ${task.instance_id}: bound=${binding.platform}`,
      );
    }

    return {
      instance_id: row.instance_id,
      repo: row.repo,
      image_name: row.image_name,
      FAIL_TO_PASS: row.FAIL_TO_PASS,
      PASS_TO_PASS: row.PASS_TO_PASS,
      test_patch: row.test_patch,
      install_config: row.install_config,
    };
  }

  /** A v2 row is gradeable only when the launcher-published vetted pool binds
   * the exact public row and explicit evaluator environment. */
  private async requireMintedV2Admission(
    task: ReturnType<typeof SweRebenchV2TaskSchema.parse>,
    runtimeTask: Task,
    row: MintedPoolRowV2,
  ): Promise<SweRebenchV2VettedPoolArtifactEntry> {
    let ref;
    try {
      ref = vettedPoolArtifactRefFromEligibility(runtimeTask.eligibility);
    } catch (err) {
      throw new SkippableError('minted_v2_admission_invalid', `invalid vetted-pool ref: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!ref) {
      throw new SkippableError('minted_v2_admission_missing', `v2 minted row ${task.instance_id} has no vetted-pool admission ref`);
    }
    if (runtimeTask.solverNetManifestCid && ref.manifestCid !== runtimeTask.solverNetManifestCid) {
      throw new SkippableError('minted_v2_admission_invalid', `vetted-pool manifest mismatch for ${task.instance_id}`);
    }
    if (ref.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION) {
      throw new SkippableError('minted_v2_admission_invalid', `vetted-pool semantics mismatch for ${task.instance_id}`);
    }
    const artifact = await this.loadPublishedPoolArtifact(ref.artifactCid);
    if (artifact.evalSemanticsVersion !== ref.evalSemanticsVersion || artifact.artifactHash !== ref.artifactHash) {
      throw new SkippableError('minted_v2_admission_invalid', `vetted-pool artifact binding mismatch for ${task.instance_id}`);
    }
    const entry = artifact.entries.byId.get(task.instance_id);
    if (!entry || entry.rowHashVersion !== 2 || !entry.publicRowHash || !entry.v2Environment) {
      throw new SkippableError('minted_v2_admission_missing', `no v2 scorable admission for ${task.instance_id}`);
    }
    if (
      entry.publicRowHash !== row.publicRowHash ||
      !sameV2AdmissionBinding(entry.v2Environment, row.environment)
    ) {
      throw new SkippableError('minted_v2_admission_drift', `vetted-pool admission drift for ${task.instance_id}`);
    }
    if (row.differentialAdmission && (!row.fix_commit || entry.v2FixCommit !== row.fix_commit)) {
      throw new SkippableError(
        'minted_v2_differential_fix_commit_drift',
        `differential fix commit admission drift for ${task.instance_id}`,
      );
    }
    return entry;
  }

  /** Re-derive every receipt command from the signed environment before grade. */
  private async recheckMintedV2DifferentialAdmission(
    task: ReturnType<typeof SweRebenchV2TaskSchema.parse>,
    row: MintedPoolRowV2,
    admission: SweRebenchV2VettedPoolArtifactEntry,
    spec: TaskEnvironmentSpecV1,
  ): Promise<void> {
    const rowReference = row.differentialAdmission;
    const admissionReference = admission.differentialAdmission;
    // Pre-hardening v2 rows retain their historical contract. New public-repo
    // admissions always include both references, and never fail open if one is
    // stripped or changed after publication.
    if (!rowReference && !admissionReference) return;
    if (!rowReference || !admissionReference || !sameDifferentialAdmissionBinding(rowReference, admissionReference)) {
      throw new SkippableError(
        'minted_v2_differential_admission_drift',
        `differential admission reference drift for ${task.instance_id}`,
      );
    }

    let receipt: DifferentialAdmissionReceiptV2;
    try {
      const fetchArtifact = this.deps.fetchFromIpfs ?? fetchFromIpfs;
      const raw = await fetchArtifact(this.ipfsGatewayUrl, rowReference.receiptCid);
      receipt = verifyDifferentialAdmissionReceiptV2(raw);
    } catch (err) {
      throw new SkippableError(
        'minted_v2_differential_receipt_unavailable',
        `cannot load or parse differential receipt for ${task.instance_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (hashDifferentialAdmissionReceiptV2(receipt) !== rowReference.receiptHash) {
      throw new SkippableError(
        'minted_v2_differential_receipt_hash_drift',
        `differential receipt hash drift for ${task.instance_id}`,
      );
    }
    if (receipt.task.fixCommit !== row.fix_commit) {
      throw new SkippableError(
        'minted_v2_differential_fix_commit_drift',
        `differential receipt fix commit drift for ${task.instance_id}`,
      );
    }
    if (
      receipt.task.instanceId !== task.instance_id ||
      receipt.task.repo !== task.repo ||
      receipt.task.baseCommit !== task.base_commit ||
      receipt.testPatchHash !== sha256(row.test_patch) ||
      receipt.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION ||
      receipt.environment.environmentHash !== spec.attestation.environmentHash ||
      receipt.environment.image.reference !== spec.execution.image.reference ||
      receipt.environment.image.digest !== spec.execution.image.digest ||
      receipt.environment.platform !== spec.execution.platform ||
      !sameParser(receipt.environment.parser, spec.execution.parser)
    ) {
      throw new SkippableError(
        'minted_v2_differential_context_drift',
        `differential receipt task/environment/parser/semantics drift for ${task.instance_id}`,
      );
    }
    try {
      for (const path of receipt.testPaths) {
        if (canonicalCommandHash(targetRecipeCommandForTestPath(spec, path.testPath)) !== path.commandHash) {
          throw new Error(`command binding drift for ${path.testPath}`);
        }
      }
    } catch (err) {
      throw new SkippableError(
        'minted_v2_differential_command_drift',
        `differential receipt command drift for ${task.instance_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const FAIL_TO_PASS = receipt.testPaths.flatMap((path) => path.FAIL_TO_PASS);
    const PASS_TO_PASS = receipt.testPaths.flatMap((path) => path.PASS_TO_PASS);
    if (!sameStringArray(row.FAIL_TO_PASS, FAIL_TO_PASS) || !sameStringArray(row.PASS_TO_PASS, PASS_TO_PASS)) {
      throw new SkippableError(
        'minted_v2_differential_row_drift',
        `differential receipt assertions do not match public row for ${task.instance_id}`,
      );
    }
  }

  private async loadAndVerifyMintedEnvironmentSpec(
    binding: MintedEnvironmentBindingV1,
    task: ReturnType<typeof SweRebenchV2TaskSchema.parse>,
    enabledState: ReadEnabledState,
  ): Promise<TaskEnvironmentSpecV1> {
    let spec: TaskEnvironmentSpecV1;
    try {
      const fetchArtifact = this.deps.fetchFromIpfs ?? fetchFromIpfs;
      const raw = await fetchArtifact(this.ipfsGatewayUrl, binding.environmentSpecCid);
      spec = parseTaskEnvironmentSpecV1(raw);
    } catch (err) {
      throw new SkippableError(
        'minted_environment_spec_unavailable',
        `cannot load or parse environment spec ${binding.environmentSpecCid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const environmentHash = hashTaskEnvironmentSpecV1(spec);
    if (environmentHash !== binding.environmentHash || spec.attestation.environmentHash !== binding.environmentHash) {
      throw new SkippableError(
        'minted_substrate_drift_environment_hash',
        `environment hash drift for ${task.instance_id}`,
      );
    }
    if (!sameAttestation(spec.attestation, binding.attestation)) {
      throw new SkippableError(
        'minted_substrate_drift_attestation',
        `environment attestation drift for ${task.instance_id}`,
      );
    }
    if (!(await verifyEnvironmentAttestationV1(spec.attestation))) {
      throw new SkippableError(
        'minted_substrate_attestation_invalid',
        `environment attestation signature is invalid for ${task.instance_id}`,
      );
    }
    if (
      spec.source.repo !== task.repo ||
      spec.source.baseCommit !== task.base_commit ||
      spec.execution.platform !== binding.platform ||
      spec.execution.image.reference !== binding.image.reference ||
      spec.execution.image.digest !== binding.image.digest ||
      !sameParser(spec.execution.parser, binding.parser)
    ) {
      throw new SkippableError(
        'minted_substrate_environment_binding_drift',
        `published environment binding drift for ${task.instance_id}`,
      );
    }
    const canonicalRepoUrl = `https://github.com/${task.repo}.git`;
    const canonicalInputRef = `git+${canonicalRepoUrl}#${task.base_commit}`;
    if (
      spec.source.repoUrl !== canonicalRepoUrl ||
      !spec.inputs.some((input) => input.inputRef === canonicalInputRef)
    ) {
      throw new SkippableError(
        'minted_substrate_source_binding_drift',
        `published environment source URL/input binding drift for ${task.instance_id}`,
      );
    }
    if (!hasCurrentEnableContract(enabledState) || !enabledState.trustedParsers.some((parser) =>
      parser.id === binding.parser.id &&
      parser.version === binding.parser.version &&
      parser.bundleId === binding.parser.bundleId &&
      parser.bundleSha256 === binding.parser.digest,
    )) {
      throw new SkippableError(
        'minted_substrate_parser_untrusted',
        `environment parser is not enabled and trusted for ${task.instance_id}`,
      );
    }
    return spec;
  }

  private async loadPublishedPoolRow(
    task: ReturnType<typeof SweRebenchV2TaskSchema.parse>,
    runtimeTask: Task,
    fetcher: HfFetcher,
  ): Promise<HfRow | null> {
    let ref;
    try {
      ref = vettedPoolArtifactRefFromEligibility(runtimeTask.eligibility);
    } catch (err) {
      throw new SkippableError(
        'vetted_pool_ref_invalid',
        `invalid vetted pool ref: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!ref) return null;

    if (runtimeTask.solverNetManifestCid && ref.manifestCid !== runtimeTask.solverNetManifestCid) {
      throw new SkippableError(
        'vetted_pool_manifest_mismatch',
        `vetted pool ref manifestCid ${ref.manifestCid} does not match task manifestCid ${runtimeTask.solverNetManifestCid}`,
      );
    }
    if (ref.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION) {
      throw new SkippableError(
        'vetted_pool_semantics_mismatch',
        `vetted pool ref semanticsVersion=${ref.evalSemanticsVersion} does not match evaluator semanticsVersion=${EVAL_SEMANTICS_VERSION}`,
      );
    }

    const artifact = await this.loadPublishedPoolArtifact(ref.artifactCid);
    try {
      if (artifact.evalSemanticsVersion !== ref.evalSemanticsVersion) {
        throw new Error(`artifact semanticsVersion=${artifact.evalSemanticsVersion} does not match ref=${ref.evalSemanticsVersion}`);
      }
      if (artifact.artifactHash !== ref.artifactHash) {
        throw new Error(`artifact hash ${artifact.artifactHash} does not match ref ${ref.artifactHash}`);
      }
    } catch (err) {
      throw new SkippableError(
        'vetted_pool_artifact_invalid',
        `invalid vetted pool artifact ${ref.artifactCid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!artifact.entries.byId.has(task.instance_id)) {
      throw new SkippableError(
        'vetted_pool_instance_missing_or_unscorable',
        `${task.instance_id} is not present as scorable in vetted pool artifact ${ref.artifactCid}`,
      );
    }

    try {
      return await fetcher.fetchTaskRow({
        hf_dataset: task.hf_dataset,
        hf_split: task.hf_split,
        instance_id: task.instance_id,
      });
    } catch (err) {
      throw new SkippableError(
        'hf_fetch_failed',
        `cannot load grading row after vetted-pool admission: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

    // Parse the solver's solution envelope and pull out the patch.
    const manifestJson = ctx.task.context!['restorationResult'] as string;
    const envelope = SignedEnvelopeSchema.parse(JSON.parse(manifestJson));
    if (
      envelope.solverType !== 'swe-rebench-v2.v1' ||
      normalizeEnvelopeRole(envelope.role) !== 'solution'
    ) {
      throw new Error(
        `swe-rebench-v2-evaluator: expected swe-rebench-v2.v1/solution envelope, got ${envelope.solverType}/${envelope.role}`,
      );
    }
    const solutionPayload = SweRebenchV2SolutionPayloadSchema.parse(envelope.payload);

    // ── Verdict-time substrate recheck ───────────────────────────────────────
    // Before grading, verify the instance's admission record is present,
    // scorable, and that the HF row + image haven't drifted since admission.
    // Any mismatch throws SkippableError — never fails open to a misclassified
    // FAIL verdict. (jinn-mono-fufn Task 9)
    const stateDir = this.stateDir ?? defaultSolverTypeStateDir();
    const fetcher: HfFetcher = this.getFetcher();
    const mintedV2Row = await this.recheckMintedV2(task, ctx.task, fetcher, state);
    const publishedPoolRow = mintedV2Row
      ? null
      : await this.loadPublishedPoolRow(task, ctx.task, fetcher);
    const recheckRow = mintedV2Row ?? publishedPoolRow ?? await this.recheckSubstrate(
      task,
      fetcher,
      () => this.loadPoolForRecheck(stateDir),
      stateDir,
    );
    // ── End substrate recheck ─────────────────────────────────────────────────

    const runner: EvalRunner = this.getRunner(state.upstreamRepoDir);
    const evaluator = new SweRebenchV2Evaluator({ fetcher, runner });

    // Meter real evaluator cost as grade() wall-time × compute rate (#1828).
    // Only the grade() call is timed — not the IPFS upload or the substrate
    // recheck above.
    const gradeStartedAtMs = performance.now();
    let graded: Awaited<ReturnType<SweRebenchV2Evaluator['grade']>>;
    try {
      graded = await evaluator.grade({ task, solutionPayload, row: recheckRow });
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
    const computedEvaluatorCostUsd =
      (Math.max(0, performance.now() - gradeStartedAtMs) / 3_600_000) * resolveComputeUsdPerHour();
    let evaluatorCostUsd = computedEvaluatorCostUsd;
    if (!Number.isFinite(computedEvaluatorCostUsd) || computedEvaluatorCostUsd < 0) {
      console.warn(
        '[swe-rebench-v2] evaluator cost computation was not finite and nonnegative — ' +
          'recording evaluator_cost_usd=0',
      );
      evaluatorCostUsd = 0;
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
      schemaVersion: 'swe-rebench-v2-verdict.v2',
      score: graded.score,
      passed_match: graded.passed_match,
      evaluator_cost_usd: evaluatorCostUsd,
      passedCount: graded.passedCount,
      totalCount: graded.totalCount,
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

// CommandResult is imported from _swe-rebench-v2-substrate.ts (Task 9 cleanup:
// removed the duplicate private interface that was here).

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
 * Upstream `SWE-rebench/SWE-rebench-V2` ships `scripts/eval.py` with a
 * `build_report_item()` that never surfaces `passed_actual`/`failed_actual`
 * on the report item it returns, even though it already derives
 * `passed_actual` internally to compute `from_fail_to_pass`. Jinn's
 * `PythonEvalRunner` (`eval-runner.ts`) reads exactly those two keys off
 * each report item to derive empirical F2P/P2P — without this patch they
 * are always empty, silently breaking empirical mining. See
 * `docs/handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md` ("Bugs
 * fixed during verification" #1) and `upstream-patches/passed-actual.patch`.
 */
const UPSTREAM_PATCHES = ['passed-actual.patch'];

/**
 * Apply Jinn's upstream `eval.py` patches to a freshly-cloned (or
 * previously-cloned) `SWE-rebench-V2` checkout, idempotently. Each patch is
 * checked with `git apply --check --reverse` first — if it reverse-applies
 * cleanly the fix is already present (either from a prior run of this
 * function, or because upstream has since shipped it natively) and the
 * patch is skipped rather than re-applied.
 *
 * Throws if a patch is neither already applied nor cleanly appliable, so
 * `onEnable` can surface it as a setup error instead of silently shipping a
 * harness that can't derive empirical F2P/P2P.
 */
export function applyUpstreamPatches(upstreamRepoDir: string): void {
  const patchesDir = join(dirname(fileURLToPath(import.meta.url)), 'upstream-patches');
  for (const patchFile of UPSTREAM_PATCHES) {
    const patchPath = join(patchesDir, patchFile);
    const reversed = spawnSync('git', ['apply', '--check', '--reverse', patchPath], {
      cwd: upstreamRepoDir,
    });
    if (reversed.status === 0) continue; // already applied — no-op.
    const applied = spawnSync('git', ['apply', patchPath], { cwd: upstreamRepoDir });
    if (applied.status !== 0) {
      throw new Error(
        `failed to apply upstream patch ${patchFile} to ${upstreamRepoDir}: ${applied.stderr?.toString() ?? ''}`,
      );
    }
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isLegacyEnabledState(value: unknown): value is LegacyEnabledState {
  return isRecord(value) &&
    value['schemaVersion'] === 'swe-rebench-v2-evaluator-state.v1' &&
    value['enabled'] === true &&
    typeof value['enabledAt'] === 'string' &&
    typeof value['upstreamRepoDir'] === 'string';
}

function isEnabledState(value: unknown): value is EnabledState {
  if (!isRecord(value) ||
    value['schemaVersion'] !== 'swe-rebench-v2-evaluator-state.v2' ||
    value['enabled'] !== true ||
    typeof value['enabledAt'] !== 'string' ||
    typeof value['upstreamRepoDir'] !== 'string' ||
    !isRecord(value['upstream']) ||
    typeof value['upstream']['repoUrl'] !== 'string' ||
    typeof value['upstream']['commit'] !== 'string' ||
    !isRecord(value['patchBundle']) ||
    typeof value['patchBundle']['id'] !== 'string' ||
    typeof value['patchBundle']['version'] !== 'string' ||
    !isSha256(value['patchBundle']['sha256']) ||
    !Array.isArray(value['trustedParsers'])) return false;

  return value['trustedParsers'].every((parser) =>
    isRecord(parser) &&
    typeof parser['id'] === 'string' &&
    typeof parser['version'] === 'string' &&
    typeof parser['bundleId'] === 'string' &&
    isSha256(parser['bundleSha256']),
  );
}

export function readEnabledState(implStateDir: string): ReadEnabledState | null {
  const path = join(implStateDir, STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    // Keep structurally-valid v1 state readable so enable can repair it in
    // place, while refusing every partial or malformed v2 marker.
    if (isLegacyEnabledState(raw) || isEnabledState(raw)) return raw;
    return null;
  } catch {
    return null;
  }
}

export { runCommand };
