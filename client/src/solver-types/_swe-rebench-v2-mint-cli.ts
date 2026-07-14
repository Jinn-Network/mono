/**
 * `jinn solver-nets mint-tasks` orchestration.
 */

import type { PoolTask } from './_swe-rebench-v2-pool.js';
import {
  EVAL_SEMANTICS_VERSION,
  validatePoolInstances,
  type ValidatedPoolStore,
} from './_swe-rebench-v2-validated-pool.js';
import {
  MintedPoolStore,
  mintedIpfsDatasetCid,
  type MintedPoolEntry,
  type MintedProvenance,
} from './_swe-rebench-v2-minted-pool.js';
import {
  assertPublicRepoForPublish,
  assertRepoAllowedForMint,
  loadMintRepoDenylist,
  type PublicRepoChecker,
} from './_swe-rebench-v2-guards.js';
import type { EvalRunner, HfFetcher } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { uploadToIpfs } from '../adapters/mech/ipfs.js';

export interface MintTasksInput {
  candidates: Array<{
    poolTask: PoolTask;
    goldPatch: string;
    provenance: MintedProvenance;
    publish?: boolean;
  }>;
  stateDir: string;
  ipfsRegistryUrl: string;
  ipfsGatewayUrl: string;
  validatedStore: ValidatedPoolStore;
  mintedStore: MintedPoolStore;
  fetcher: HfFetcher;
  runner: EvalRunner;
  upstreamRepoDir: string;
  publicRepoChecker: PublicRepoChecker;
}

export interface MintTasksResult {
  admitted: string[];
  rejected: Array<{ instance_id: string; reason: string }>;
  artifactCid?: string;
}

export async function runMintTasksPipeline(input: MintTasksInput): Promise<MintTasksResult> {
  const denylist = loadMintRepoDenylist();
  const admitted: string[] = [];
  const rejected: Array<{ instance_id: string; reason: string }> = [];
  const toValidate: PoolTask[] = [];

  for (const c of input.candidates) {
    const repo = c.poolTask.repo ?? 'unknown/unknown';
    try {
      assertRepoAllowedForMint(repo, denylist);
      if (c.publish !== false) {
        await assertPublicRepoForPublish(repo, input.publicRepoChecker);
      }
      toValidate.push({ ...c.poolTask, patch: c.goldPatch });
    } catch (err) {
      rejected.push({
        instance_id: c.poolTask.instance_id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (toValidate.length > 0) {
    await validatePoolInstances(toValidate, {
      fetcher: input.fetcher,
      runner: input.runner,
      store: input.validatedStore,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
      upstreamRepoDir: input.upstreamRepoDir,
    }, { poolSource: 'minted', force: true });
  }

  for (const c of input.candidates) {
    if (rejected.some((r) => r.instance_id === c.poolTask.instance_id)) continue;
    const entry = await input.validatedStore.getEntry(c.poolTask.instance_id, EVAL_SEMANTICS_VERSION);
    if (!entry?.scorable) {
      rejected.push({ instance_id: c.poolTask.instance_id, reason: entry?.reason ?? 'admission-failed' });
      continue;
    }
    const row = await input.fetcher.fetchTaskRow({
      hf_dataset: c.poolTask.hf_dataset,
      hf_split: c.poolTask.hf_split,
      instance_id: c.poolTask.instance_id,
    });
    const mintedEntry: MintedPoolEntry & { goldPatch: string } = {
      row: {
        instance_id: c.poolTask.instance_id,
        repo: c.poolTask.repo ?? row.repo,
        image_name: row.image_name,
        FAIL_TO_PASS: row.FAIL_TO_PASS,
        PASS_TO_PASS: row.PASS_TO_PASS,
        test_patch: row.test_patch,
        install_config: row.install_config,
        problem_statement: c.poolTask.problem_statement,
        base_commit: c.poolTask.base_commit,
      },
      provenance: c.provenance,
      admission: entry,
      hf_dataset: c.poolTask.hf_dataset,
      hf_split: c.poolTask.hf_split,
      mintedAt: new Date().toISOString(),
      goldPatch: c.goldPatch,
    };
    await input.mintedStore.record(c.poolTask.instance_id, mintedEntry, EVAL_SEMANTICS_VERSION);
    admitted.push(c.poolTask.instance_id);
  }

  let artifactCid: string | undefined;
  const publishCandidates = input.candidates.filter((c) => c.publish !== false && admitted.includes(c.poolTask.instance_id));
  if (publishCandidates.length > 0) {
    const artifact = await input.mintedStore.exportArtifact(EVAL_SEMANTICS_VERSION);
    artifactCid = await uploadToIpfs(input.ipfsRegistryUrl, artifact);
    await input.mintedStore.setPublishedArtifact(
      EVAL_SEMANTICS_VERSION,
      artifactCid,
      publishCandidates.map((c) => c.poolTask.instance_id),
    );
  }

  return {
    admitted,
    rejected,
    artifactCid: artifactCid ? mintedIpfsDatasetCid(artifactCid) : undefined,
  };
}
