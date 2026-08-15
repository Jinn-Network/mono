/**
 * Daemon harvest loop — commit-echo mining from configured local repos.
 * Spec §5.2; plan: end-to-end harvest slice.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { discoverCommitEchoCandidates } from '../solver-types/_swe-rebench-v2-commit-echo.js';
import {
  createGitCommitEchoDeps,
  type GitCommitEchoRepoConfig,
} from '../solver-types/_swe-rebench-v2-commit-echo-git.js';
import {
  HarvestStateStore,
  classifyHarvestFailure,
  AWAITING_RECEIPT_PUBLICATION_REQUIRED,
} from '../solver-types/_swe-rebench-v2-harvest-state.js';
import {
  admitBuiltMintCandidates,
  buildCommitEchoMintCandidate,
  explicitRecipeBootstrapError,
  findSourceInstanceForRepo,
  parseExplicitRecipeBootstrap,
  type ExplicitRecipeBootstrap,
  type HarvestMintDeps,
} from '../solver-types/_swe-rebench-v2-harvest.js';
import {
  EVAL_SEMANTICS_VERSION,
  ValidatedPoolStore,
} from '../solver-types/_swe-rebench-v2-validated-pool.js';
import { loadSweRebenchV2Pool } from '../solver-types/swe-rebench-v2.js';
import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';
import {
  isMintedPoolRowV2,
  type MintedPoolEntry,
} from '../solver-types/_swe-rebench-v2-minted-pool.js';
import type { Store } from '../store/store.js';
import { emitEvent } from '../observability/emit-event.js';
import { recordLoopTick } from './loop-heartbeat.js';
import { canonicalJson } from '../util/canonical-json.js';
import { uploadToIpfs } from '../adapters/mech/ipfs.js';

export type HarvestSource = 'commits' | 'sessions';

export interface HarvestRepoConfig {
  path: string;
  repo: string;
  remote?: string;
  /** Explicit public-repo evaluator environment; otherwise retain v1 backing. */
  explicitRecipe?: ExplicitRecipeBootstrap;
}

export interface HarvestLoopConfig {
  intervalMs: number;
  stateDir: string;
  repos: HarvestRepoConfig[];
  limitPerRepo: number;
  /** Max session-echo records mined per tick (sibling of limitPerRepo). */
  limitPerTick: number;
  publish: boolean;
  minterSafe?: string;
  /** Required only when at least one commit repo is configured. */
  mintDeps?: Omit<HarvestMintDeps, 'publish' | 'minterSafe'>;
  loadPool?: () => Promise<PoolTask[]>;
  validatedStore?: ValidatedPoolStore;
  harvestState?: HarvestStateStore;
  isDockerAvailable?: () => boolean;
  store?: Store;
  now?: () => number;
  /**
   * Which harvest sources this tick considers. Absent ⇒ `['commits']`.
   * The `'sessions'` source is explicitly parked during Stage 2 until a
   * canonical publication policy is ratified.
   */
  sources?: HarvestSource[];
}

export interface HarvestTickResult {
  discovered: number;
  admitted: string[];
  rejected: Array<{ instance_id: string; reason: string }>;
  awaitingInput: Array<{ instance_id: string; reason: string }>;
  quarantined: Array<{ instance_id: string; reason: string }>;
  skipped: string[];
}

function defaultDockerCheck(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

export const SESSIONS_SOURCE_PARKED_STAGE_2 = 'sessions-source-parked-stage-2';

const STAGE_RANK: Record<string, number> = {
  discovered: 0,
  recipe: 1,
  image: 2,
  environment: 3,
  empirical: 4,
  admission: 5,
  ipfs: 6,
  complete: 7,
};

function recipeHashFor(bootstrap: ExplicitRecipeBootstrap): string {
  return `sha256:${createHash('sha256').update(canonicalJson(bootstrap.recipe)).digest('hex')}`;
}

function stageBefore(stage: keyof typeof STAGE_RANK, target: keyof typeof STAGE_RANK): boolean {
  return STAGE_RANK[stage] < STAGE_RANK[target];
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Admission reuse is intentionally explicit-environment-only. Legacy rows do
 * not carry a complete public environment binding, so retaining their old
 * forced-validation behavior is the fail-closed choice.
 */
async function loadBoundAdmission(args: {
  built: Awaited<ReturnType<typeof buildCommitEchoMintCandidate>>['built'];
  validatedStore: ValidatedPoolStore;
  mintedStore: HarvestMintDeps['mintedStore'];
}): Promise<{ entry: MintedPoolEntry; rowHashVersion: 2 } | null> {
  const built = args.built;
  if (!built?.environment) return null;
  const entry = await args.mintedStore.getEntry(built.poolTask.instance_id, EVAL_SEMANTICS_VERSION);
  const validated = await args.validatedStore.getEntry(built.poolTask.instance_id, EVAL_SEMANTICS_VERSION);
  if (!entry || !validated || !entry.admission.scorable || !validated.scorable) return null;
  if (entry.admission.discrimination === 'fail' || validated.discrimination === 'fail') return null;
  if (!sameCanonical(entry.admission, validated)) return null;
  if (!isMintedPoolRowV2(entry.row) || entry.rowHashVersion === 1) return null;

  const row = entry.row;
  const local = entry as MintedPoolEntry & { goldPatch?: string };
  if (
    row.instance_id !== built.poolTask.instance_id ||
    row.repo !== built.poolTask.repo ||
    row.base_commit !== built.poolTask.base_commit ||
    row.fix_commit !== built.fixCommit ||
    row.language !== built.poolTask.language ||
    row.problem_statement !== built.poolTask.problem_statement ||
    row.image_name !== built.row.image_name ||
    !sameCanonical(row.FAIL_TO_PASS, built.row.FAIL_TO_PASS) ||
    !sameCanonical(row.PASS_TO_PASS, built.row.PASS_TO_PASS) ||
    row.test_patch !== built.row.test_patch ||
    !sameCanonical(row.install_config, built.row.install_config) ||
    !sameCanonical(row.environment, built.environment) ||
    row.publicRowHash !== entry.admission.publicRowHash ||
    entry.admission.rowHashVersion !== 2 ||
    entry.admission.v2FixCommit !== row.fix_commit ||
    !sameCanonical(entry.admission.v2Environment, built.environment) ||
    local.goldPatch !== built.goldPatch ||
    entry.provenance.sourceLineageHash !== built.provenance.sourceLineageHash
  ) return null;
  if (built.differentialAdmission) {
    const rowEvidence = row.differentialAdmission;
    const admissionEvidence = entry.admission.differentialAdmission;
    if (
      !rowEvidence || !admissionEvidence ||
      rowEvidence.admissionPolicyVersion !== built.differentialAdmission.receipt.admissionPolicyVersion ||
      rowEvidence.receiptHash !== built.differentialAdmission.receiptHash ||
      admissionEvidence.admissionPolicyVersion !== rowEvidence.admissionPolicyVersion ||
      admissionEvidence.receiptCid !== rowEvidence.receiptCid ||
      admissionEvidence.receiptHash !== rowEvidence.receiptHash
    ) return null;
  }
  return { entry, rowHashVersion: 2 };
}

async function publishBoundAdmission(args: {
  instanceId: string;
  rowHashVersion: 2;
  mintDeps: HarvestMintDeps;
}): Promise<string> {
  // includeIds: the row we are publishing right now is still marked
  // published:false at export time (the marker flips only after this
  // setPublishedArtifact call), so it must be named to survive the tier-2
  // publish gate in exportArtifactV2.
  const artifact = await args.mintDeps.mintedStore.exportArtifactV2(EVAL_SEMANTICS_VERSION, {
    includeIds: [args.instanceId],
  });
  const artifactCid = await uploadToIpfs(args.mintDeps.ipfsRegistryUrl, artifact);
  await args.mintDeps.mintedStore.setPublishedArtifact(
    EVAL_SEMANTICS_VERSION,
    artifactCid,
    [args.instanceId],
    { rowHashVersion: args.rowHashVersion },
  );
  return artifactCid;
}

export async function runHarvestTick(config: HarvestLoopConfig): Promise<HarvestTickResult> {
  const sources = config.sources ?? ['commits'];
  const skipped = sources.includes('sessions') ? [SESSIONS_SOURCE_PARKED_STAGE_2] : [];
  if (!sources.includes('commits') || config.repos.length === 0) {
    return { discovered: 0, admitted: [], rejected: [], awaitingInput: [], quarantined: [], skipped };
  }

  const dockerOk = (config.isDockerAvailable ?? defaultDockerCheck)();
  if (!dockerOk) {
    return {
      discovered: 0,
      admitted: [],
      rejected: [],
      awaitingInput: [],
      quarantined: [],
      skipped: [...skipped, 'docker-unavailable'],
    };
  }
  if (!config.mintDeps) {
    throw new Error('commit harvest requires mintDeps when repos are configured');
  }
  const mintDeps = config.mintDeps;

  const validatedStore = config.validatedStore ?? new ValidatedPoolStore({ stateDir: config.stateDir });
  const harvestState = config.harvestState ?? new HarvestStateStore({ stateDir: config.stateDir });
  const scorableIds = await validatedStore.getScorableIds(EVAL_SEMANTICS_VERSION) ?? new Set<string>();

  const pool = await (config.loadPool ?? loadSweRebenchV2Pool)();
  const admitted: string[] = [];
  const rejected: Array<{ instance_id: string; reason: string }> = [];
  const awaitingInput: Array<{ instance_id: string; reason: string }> = [];
  const quarantined: Array<{ instance_id: string; reason: string }> = [];
  let discovered = 0;

  for (const repoCfg of sources.includes('commits') ? config.repos : []) {
    const repoState = await harvestState.getRepo(repoCfg.repo);
    const snapshot = repoState?.lastScannedCommit ?? '';
    const gitDeps = createGitCommitEchoDeps(repoCfg as GitCommitEchoRepoConfig);
    const candidates = await discoverCommitEchoCandidates(
      [{ repo: repoCfg.repo, snapshotCommit: snapshot }],
      gitDeps,
      { limitPerRepo: config.limitPerRepo },
    );
    discovered += candidates.length;

    if (candidates.length > 0) {
      const lastCommit = candidates[candidates.length - 1]!.fix_commit;
      const recipeHash = repoCfg.explicitRecipe
        ? recipeHashFor(repoCfg.explicitRecipe)
        : 'rebench-v1';
      // The state write creates every job before it changes the repo cursor.
      await harvestState.persistDiscoveredJobs({
        repo: repoCfg.repo,
        cursor: lastCommit,
        candidates,
        recipeHash,
      });
    }
  }

  // A cursor can already be past a candidate that lacked an explicit recipe.
  // Re-open only jobs claimed by the newly configured exact base binding;
  // incompatible config stays awaiting_input without a retry loop.
  for (const repoCfg of config.repos) {
    if (!repoCfg.explicitRecipe) continue;
    const recipeHash = recipeHashFor(repoCfg.explicitRecipe);
    await harvestState.resumeAwaitingInputJobs({
      repo: repoCfg.repo,
      recipeHash,
      predicate: (job) =>
        job.candidate.repo.toLowerCase() === repoCfg.explicitRecipe!.recipe.source.repo.toLowerCase() &&
        job.candidate.base_commit === repoCfg.explicitRecipe!.recipe.source.baseCommit,
    });
    if (config.publish) {
      await harvestState.resumeAwaitingPublicationJobs({
        repo: repoCfg.repo,
        recipeHash,
        predicate: (job) =>
          job.candidate.repo.toLowerCase() === repoCfg.explicitRecipe!.recipe.source.repo.toLowerCase() &&
          job.candidate.base_commit === repoCfg.explicitRecipe!.recipe.source.baseCommit,
      });
    }
  }

  const configuredRepos = new Map(config.repos.map((repo) => [repo.repo, repo]));
  const tickNow = config.now ? new Date(config.now()) : undefined;
  for (const dueJob of await harvestState.getDueJobs(tickNow)) {
    let job = dueJob;
    const repoCfg = configuredRepos.get(job.repo);
    if (!repoCfg) continue;
    const candidate = job.candidate;
    const legacyRejected = await harvestState.getRepo(repoCfg.repo);
    if (harvestState.isRejected(legacyRejected, candidate.instance_id)) {
      skipped.push(candidate.instance_id);
      continue;
    }

    const source = repoCfg.explicitRecipe
      ? undefined
      : findSourceInstanceForRepo(pool, scorableIds, candidate.repo);

    // The IPFS pointer was persisted before the checkpoint callback. A crash
    // between that write and markJobAdmitted therefore finishes locally on
    // restart instead of replaying empirical/admission work.
    if (job.stage === 'ipfs') {
      const checkpointCid = job.artifactRefs['mintedArtifactCid'];
      const entry = checkpointCid
        ? await mintDeps.mintedStore.getEntry(candidate.instance_id, EVAL_SEMANTICS_VERSION)
        : null;
      const rowHashVersion = entry && (entry.rowHashVersion === 2 || isMintedPoolRowV2(entry.row)) ? 2 : 1;
      const publishedCid = entry
        ? await mintDeps.mintedStore.getPublishedArtifactCid(EVAL_SEMANTICS_VERSION, rowHashVersion)
        : null;
      if (checkpointCid && entry && publishedCid === checkpointCid) {
        await harvestState.markJobAdmitted(job.taskKey);
        admitted.push(candidate.instance_id);
        continue;
      }
      await harvestState.markJobFailure(
        job.taskKey,
        'infrastructure: IPFS checkpoint does not match durable minted-pool state',
        tickNow ? { now: tickNow } : {},
      );
      continue;
    }

    if (repoCfg.explicitRecipe) {
      const recipeHash = recipeHashFor(repoCfg.explicitRecipe);
      if (job.recipeHash !== recipeHash) {
        job = await harvestState.rebindJobRecipe({ taskKey: job.taskKey, recipeHash });
      }
    }

    const startedAt = Date.now();
    const bootstrapError = repoCfg.explicitRecipe
      ? explicitRecipeBootstrapError(candidate, repoCfg.explicitRecipe)
      : null;
    if (repoCfg.explicitRecipe && !bootstrapError) {
      const binding = repoCfg.explicitRecipe.environment;
      const recipeHash = recipeHashFor(repoCfg.explicitRecipe);
      if (stageBefore(job.stage, 'recipe')) {
        await harvestState.updateJob(job.taskKey, {
          stage: 'recipe',
          artifactRefs: { recipeHash, recipeId: repoCfg.explicitRecipe.recipe.recipeId },
        });
      }
      if (stageBefore(job.stage, 'image')) {
        await harvestState.updateJob(job.taskKey, {
          stage: 'image',
          artifactRefs: { imageReference: binding.image.reference, imageDigest: binding.image.digest },
        });
      }
      if (stageBefore(job.stage, 'environment')) {
        await harvestState.updateJob(job.taskKey, {
          stage: 'environment',
          artifactRefs: {
            environmentSpecCid: binding.environmentSpecCid,
            environmentHash: binding.environmentHash,
            parserDigest: binding.parser.digest,
          },
        });
      }
    }
    // Do not claim empirical work happened when the source/recipe gate will
    // immediately return awaiting_input or policy failure.
    if (
      ((repoCfg.explicitRecipe && !bootstrapError) || (!repoCfg.explicitRecipe && source)) &&
      job.stage !== 'admission'
    ) {
      await harvestState.updateJob(job.taskKey, { stage: 'empirical' });
    }
    try {
      const builtResult = await buildCommitEchoMintCandidate({
        candidate,
        ...(source ? { source } : {}),
        ...(repoCfg.explicitRecipe ? { explicitRecipe: repoCfg.explicitRecipe } : {}),
        fetcher: mintDeps.hfFetcher,
        runner: mintDeps.runner,
        minterSafe: config.minterSafe,
        empiricalEvidenceStore: harvestState,
        differentialAdmissionEvidence: job.differentialAdmission,
      });
      await harvestState.updateJob(job.taskKey, {
        resourceUse: { empiricalDurationMs: Date.now() - startedAt },
        ...(builtResult.built?.differentialAdmission ? {
          differentialAdmission: {
            schemaVersion: 'swe-rebench-v2-differential-admission-evidence.v2',
            admissionPolicyVersion: builtResult.built.differentialAdmission.receipt.admissionPolicyVersion,
            receiptHash: builtResult.built.differentialAdmission.receiptHash,
            receipt: builtResult.built.differentialAdmission.receipt,
            ...(job.differentialAdmission?.receiptCid ? { receiptCid: job.differentialAdmission.receiptCid } : {}),
            recordedAt: new Date().toISOString(),
          },
        } : {}),
      });
      if (!builtResult.built) {
        // An admission checkpoint can only survive while its exact empirical
        // binding remains available. A failed re-derivation invalidates it.
        if (job.stage === 'admission') {
          await harvestState.updateJob(job.taskKey, { stage: 'empirical' });
        }
        const reason = builtResult.reason ?? 'build-failed';
        const disposition = classifyHarvestFailure(reason);
        await harvestState.markJobFailure(job.taskKey, reason, tickNow ? { now: tickNow } : {});
        if (disposition === 'awaiting_input') awaitingInput.push({ instance_id: candidate.instance_id, reason });
        else if (disposition === 'quarantined') quarantined.push({ instance_id: candidate.instance_id, reason });
        else if (disposition === 'terminal_policy') rejected.push({ instance_id: candidate.instance_id, reason });
        continue;
      }
      const built = builtResult.built;
      if (
        !config.publish &&
        built.environment &&
        built.differentialAdmission &&
        !job.differentialAdmission?.receiptCid
      ) {
        const reason = `${AWAITING_RECEIPT_PUBLICATION_REQUIRED}: explicit-environment receipt is persisted locally; publish it and rerun with publish enabled before mint admission`;
        await harvestState.markJobFailure(job.taskKey, reason, tickNow ? { now: tickNow } : {});
        awaitingInput.push({ instance_id: candidate.instance_id, reason });
        continue;
      }
      // A persisted explicit-environment admission is sufficient to resume at
      // publication. Verify the local mint entry *and* validated-pool record
      // against the just-derived candidate before skipping forced validation.
      if (job.stage === 'admission') {
        const boundAdmission = await loadBoundAdmission({
          built,
          validatedStore,
          mintedStore: mintDeps.mintedStore,
        });
        if (boundAdmission) {
          if (config.publish) {
            const artifactCid = await publishBoundAdmission({
              instanceId: candidate.instance_id,
              rowHashVersion: boundAdmission.rowHashVersion,
              mintDeps,
            });
            await harvestState.updateJob(job.taskKey, {
              stage: 'ipfs',
              artifactRefs: {
                mintedArtifactCid: artifactCid,
                mintedArtifactRowHashVersion: String(boundAdmission.rowHashVersion),
              },
              resourceUse: { ipfsDurationMs: Date.now() - startedAt },
            });
          }
          await harvestState.markJobAdmitted(job.taskKey);
          admitted.push(candidate.instance_id);
          continue;
        }
        // The local admission disagrees with the current candidate or its
        // public environment binding. It is not reusable; rerun admission.
        await harvestState.updateJob(job.taskKey, { stage: 'empirical' });
      }

      const mintResult = await admitBuiltMintCandidates([built], {
        ...mintDeps,
        publish: config.publish,
        minterSafe: config.minterSafe,
        progress: {
          onAdmissionStored: async ({ instanceId, rowHashVersion, differentialAdmission }) => {
            const entry = await mintDeps.mintedStore.getEntry(instanceId, EVAL_SEMANTICS_VERSION);
            await harvestState.updateJob(job.taskKey, {
              stage: 'admission',
              artifactRefs: {
                admissionInstanceId: instanceId,
                admissionRowHashVersion: String(rowHashVersion),
                ...(entry?.admission.publicRowHash ? { admissionPublicRowHash: entry.admission.publicRowHash } : {}),
                ...(entry?.admission.rowHash ? { admissionRowHash: entry.admission.rowHash } : {}),
              },
              resourceUse: { admissionDurationMs: Date.now() - startedAt },
              ...(differentialAdmission ? {
                differentialAdmission: {
                  schemaVersion: 'swe-rebench-v2-differential-admission-evidence.v2',
                  admissionPolicyVersion: differentialAdmission.admissionPolicyVersion,
                  receiptHash: differentialAdmission.receiptHash,
                  receiptCid: differentialAdmission.receiptCid,
                  ...(built.differentialAdmission ? { receipt: built.differentialAdmission.receipt } : {}),
                  recordedAt: new Date().toISOString(),
                },
              } : {}),
            });
          },
          onIpfsPublished: async ({ artifactCid, rowHashVersion }) => {
            await harvestState.updateJob(job.taskKey, {
              stage: 'ipfs',
              artifactRefs: {
                mintedArtifactCid: artifactCid,
                mintedArtifactRowHashVersion: String(rowHashVersion),
              },
              resourceUse: { ipfsDurationMs: Date.now() - startedAt },
            });
          },
        },
      });
      for (const id of mintResult.admitted) {
        admitted.push(id);
        await harvestState.markJobAdmitted(job.taskKey);
      }
      for (const result of mintResult.rejected) {
        const disposition = classifyHarvestFailure(result.reason);
        await harvestState.markJobFailure(job.taskKey, result.reason, tickNow ? { now: tickNow } : {});
        if (disposition === 'awaiting_input') awaitingInput.push(result);
        else if (disposition === 'quarantined') quarantined.push(result);
        else if (disposition === 'terminal_policy') rejected.push(result);
      }
      if (config.store) {
        for (const id of mintResult.admitted) {
          emitEvent(config.store, {
            kind: 'harvest_admitted',
            requestId: id,
            outcome: 'ok',
            detail: `commit-echo ${candidate.repo}@${candidate.fix_commit.slice(0, 8)}`,
          }, 'harvest-loop');
        }
      }
    } catch (error) {
      // Build/evaluator/network failures remain a bounded retry, never a verdict.
      await harvestState.markJobFailure(
        job.taskKey,
        `infrastructure: ${error instanceof Error ? error.message : String(error)}`,
        tickNow ? { now: tickNow } : {},
      );
    }
  }

  return { discovered, admitted, rejected, awaitingInput, quarantined, skipped };
}

export async function resolveHarvestRepoConfigs(
  repos: Array<{ path: string; repo?: string; remote?: string; explicitRecipe?: unknown }>,
): Promise<HarvestRepoConfig[]> {
  const { resolveHarvestRepoSlug } = await import('../solver-types/_swe-rebench-v2-commit-echo-git.js');
  const out: HarvestRepoConfig[] = [];
  for (const r of repos) {
    let repo = r.repo;
    if (!repo) {
      repo = (await resolveHarvestRepoSlug(r.path, r.remote ?? 'origin')) ?? undefined;
    }
    if (!repo) {
      console.warn(`[harvest] skipping ${r.path}: cannot resolve owner/repo slug`);
      continue;
    }
    let explicitRecipe: ExplicitRecipeBootstrap | undefined;
    if (r.explicitRecipe !== undefined) {
      try {
        explicitRecipe = parseExplicitRecipeBootstrap(r.explicitRecipe);
      } catch (error) {
        console.warn(`[harvest] ${r.path}: invalid explicit recipe: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    out.push({ path: r.path, repo, ...(r.remote ? { remote: r.remote } : {}), ...(explicitRecipe ? { explicitRecipe } : {}) });
  }
  return out;
}

export class HarvestLoop {
  private stopped = false;

  constructor(private readonly config: HarvestLoopConfig) {}

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<HarvestTickResult> {
    const result = await runHarvestTick(this.config);
    if (result.skipped.includes(SESSIONS_SOURCE_PARKED_STAGE_2)) {
      console.log(`[harvest-loop] ${SESSIONS_SOURCE_PARKED_STAGE_2}`);
    }
    if (this.config.store) {
      recordLoopTick(this.config.store, 'harvest');
      if (result.admitted.length > 0 || result.rejected.length > 0) {
        console.log(
          `[harvest-loop] tick: discovered=${result.discovered} admitted=${result.admitted.length} rejected=${result.rejected.length}`,
        );
      }
    }
    return result;
  }

  async run(): Promise<void> {
    if (this.config.intervalMs <= 0) return;
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (err) {
        console.error(
          '[harvest-loop] tick failed (non-fatal):',
          err instanceof Error ? err.message : err,
        );
      }
      await new Promise<void>((r) => setTimeout(r, this.config.intervalMs));
    }
  }
}
