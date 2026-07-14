/**
 * Commit-echo harvest orchestration — source-instance mapping, empirical tests,
 * mint pipeline feed. Spec §5.2.
 */

import { createHash } from 'node:crypto';
import type { PoolTask } from './_swe-rebench-v2-pool.js';
import type { CommitEchoCandidate } from './_swe-rebench-v2-commit-echo.js';
import type { MintedProvenance } from './_swe-rebench-v2-minted-pool.js';
import type { EvalRunner, HfFetcher, HfRow } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import {
  runEmpiricalTestDerivation,
  type EmpiricalTestDerivationResult,
} from './_swe-rebench-v2-empirical-tests.js';
import { runMintTasksPipeline, type MintTasksInput } from './_swe-rebench-v2-mint-cli.js';
import {
  EVAL_SEMANTICS_VERSION,
  ValidatedPoolStore,
} from './_swe-rebench-v2-validated-pool.js';
import {
  MintedPoolStore,
  type SweRebenchV2MintedPoolArtifact,
} from './_swe-rebench-v2-minted-pool.js';
import { RoutingTaskRowFetcher } from '../harnesses/impls/swe-rebench-v2-evaluator/routing-task-row-fetcher.js';
import type { PublicRepoChecker } from './_swe-rebench-v2-guards.js';

export const MINTED_DATASET_PLACEHOLDER = 'ipfs://local-minted-pending' as const;

export function commitEchoLineageHash(repo: string, fixCommit: string): string {
  const digest = createHash('sha256').update(`${repo}:${fixCommit}`).digest('hex');
  return `sha256:${digest}`;
}

export function findSourceInstanceForRepo(
  pool: PoolTask[],
  scorableIds: Set<string>,
  repo: string,
): PoolTask | null {
  const normalized = repo.toLowerCase();
  for (const task of pool) {
    if ((task.repo ?? '').toLowerCase() !== normalized) continue;
    if (!scorableIds.has(task.instance_id)) continue;
    return task;
  }
  return null;
}

export interface BuiltMintCandidate {
  poolTask: PoolTask;
  goldPatch: string;
  provenance: MintedProvenance;
  row: HfRow;
}

export async function buildCommitEchoMintCandidate(args: {
  candidate: CommitEchoCandidate;
  source: PoolTask;
  fetcher: HfFetcher;
  runner: EvalRunner;
  minterSafe?: string;
  testPatch?: string;
}): Promise<{ built: BuiltMintCandidate | null; reason?: string; empirical?: EmpiricalTestDerivationResult }> {
  const sourceRow = await args.fetcher.fetchTaskRow({
    hf_dataset: args.source.hf_dataset,
    hf_split: args.source.hf_split,
    instance_id: args.source.instance_id,
  });

  const empirical = await runEmpiricalTestDerivation(
    {
      instance_id: args.candidate.instance_id,
      repo: args.candidate.repo,
      image: sourceRow.image_name,
      test_patch: args.testPatch ?? sourceRow.test_patch,
      install: sourceRow.install_config?.install
        ? (Array.isArray(sourceRow.install_config.install)
          ? sourceRow.install_config.install
          : [sourceRow.install_config.install])
        : undefined,
      test_cmd: sourceRow.install_config?.test_cmd ?? 'pytest',
      log_parser: sourceRow.install_config?.log_parser ?? 'parse_log_pytest',
      gold_patch: args.candidate.gold_patch,
      broken_patch: '',
    },
    args.runner,
  );
  if (empirical.dead) {
    return { built: null, reason: 'empirical-dead: no FAIL_TO_PASS tests', empirical };
  }

  const row: HfRow = {
    instance_id: args.candidate.instance_id,
    repo: args.candidate.repo,
    image_name: sourceRow.image_name,
    FAIL_TO_PASS: empirical.FAIL_TO_PASS,
    PASS_TO_PASS: empirical.PASS_TO_PASS,
    test_patch: args.testPatch ?? sourceRow.test_patch,
    install_config: sourceRow.install_config,
  };

  const poolTask: PoolTask = {
    instance_id: args.candidate.instance_id,
    hf_dataset: MINTED_DATASET_PLACEHOLDER,
    hf_split: 'minted',
    repo: args.candidate.repo,
    base_commit: args.candidate.base_commit,
    patch: args.candidate.gold_patch,
    test_patch: row.test_patch,
    language: args.source.language ?? 'python',
    problem_statement: args.candidate.problem_statement,
  };

  const provenance: MintedProvenance = {
    synthetic: true,
    mintFamily: 'commit-echo',
    sourceLineageHash: commitEchoLineageHash(args.candidate.repo, args.candidate.fix_commit),
    sourceInstanceId: args.source.instance_id,
    ...(args.minterSafe ? { minterSafe: args.minterSafe } : {}),
  };

  return {
    built: {
      poolTask,
      goldPatch: args.candidate.gold_patch,
      provenance,
      row,
    },
    empirical,
  };
}

export function inMemoryMintedArtifactFetcher(
  rows: Map<string, HfRow>,
): (cid: string) => Promise<SweRebenchV2MintedPoolArtifact> {
  return async () => ({
    schemaVersion: 'swe-rebench-v2-minted-pool.v1',
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
    generatedAt: new Date().toISOString(),
    rows: [...rows.values()].map((r) => ({
      instance_id: r.instance_id,
      repo: r.repo,
      image_name: r.image_name,
      FAIL_TO_PASS: r.FAIL_TO_PASS,
      PASS_TO_PASS: r.PASS_TO_PASS,
      test_patch: r.test_patch,
      install_config: r.install_config,
    })),
  });
}

export interface HarvestMintDeps {
  stateDir: string;
  ipfsRegistryUrl: string;
  ipfsGatewayUrl: string;
  validatedStore: ValidatedPoolStore;
  mintedStore: MintedPoolStore;
  hfFetcher: HfFetcher;
  runner: EvalRunner;
  upstreamRepoDir: string;
  publicRepoChecker: PublicRepoChecker;
  minterSafe?: string;
  publish?: boolean;
}

export async function admitBuiltMintCandidates(
  built: BuiltMintCandidate[],
  deps: HarvestMintDeps,
): Promise<Awaited<ReturnType<typeof runMintTasksPipeline>>> {
  const rowMap = new Map(built.map((b) => [b.poolTask.instance_id, b.row]));
  const routingFetcher = new RoutingTaskRowFetcher({
    hf: deps.hfFetcher,
    fetchMintedArtifact: inMemoryMintedArtifactFetcher(rowMap),
  });

  const input: MintTasksInput = {
    candidates: built.map((b) => ({
      poolTask: b.poolTask,
      goldPatch: b.goldPatch,
      provenance: b.provenance,
      publish: deps.publish,
    })),
    stateDir: deps.stateDir,
    ipfsRegistryUrl: deps.ipfsRegistryUrl,
    ipfsGatewayUrl: deps.ipfsGatewayUrl,
    validatedStore: deps.validatedStore,
    mintedStore: deps.mintedStore,
    fetcher: routingFetcher,
    runner: deps.runner,
    upstreamRepoDir: deps.upstreamRepoDir,
    publicRepoChecker: deps.publicRepoChecker,
  };
  return runMintTasksPipeline(input);
}

export function escrowInputsFromPatch(
  goldPatch: string,
  failToPass: string[],
): { loc: number; files: number; tests: number } {
  const fileSet = new Set<string>();
  let loc = 0;
  for (const line of goldPatch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\//.exec(line);
      if (m?.[1]) fileSet.add(m[1]);
    }
    if (line.startsWith('+') && !line.startsWith('+++')) loc += 1;
    if (line.startsWith('-') && !line.startsWith('---')) loc += 1;
  }
  return { loc: Math.max(loc, 1), files: Math.max(fileSet.size, 1), tests: Math.max(failToPass.length, 1) };
}

export const DEFAULT_SYNTHETIC_ESCROW_PARAMS = {
  alpha: 0.5,
  beta: 0.3,
  gamma: 0.2,
  loc_normalizer: 100,
  files_normalizer: 5,
  tests_normalizer: 10,
} as const;
