/**
 * Routing task-row fetcher — resolves an `HfFetcher` task row from either the
 * HF datasets server or an immutable `ipfs://` minted-pool artifact.
 *
 * v2 callers may retain the parsed artifact/row through `fetchMintedRow()` so
 * the evaluator can verify public environment bindings before grading. The
 * ordinary HfFetcher method remains intentionally lossless for legacy users.
 */

import type { HfFetcher, HfRow } from './index.js';
import { HttpHfFetcher } from './hf-fetcher.js';
import {
  parseMintedIpfsDataset,
  parseMintedPoolArtifact,
  type MintedPoolRow,
  type MintedPoolRowV2,
  type SweRebenchV2MintedPoolArtifact,
} from '../../../solver-types/_swe-rebench-v2-minted-pool.js';

export interface RoutingTaskRowFetcherDeps {
  hf?: HfFetcher;
  fetchMintedArtifact: (cid: string) => Promise<SweRebenchV2MintedPoolArtifact>;
}

export interface RoutedMintedPoolRow {
  cid: string;
  artifact: SweRebenchV2MintedPoolArtifact;
  row: MintedPoolRow | MintedPoolRowV2;
}

function asHfRow(row: MintedPoolRow | MintedPoolRowV2): HfRow {
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

export class RoutingTaskRowFetcher implements HfFetcher {
  private readonly hf: HfFetcher;
  private readonly artifactCache = new Map<string, SweRebenchV2MintedPoolArtifact>();

  constructor(deps: RoutingTaskRowFetcherDeps) {
    this.hf = deps.hf ?? new HttpHfFetcher();
    this.fetchMinted = deps.fetchMintedArtifact;
  }

  private readonly fetchMinted: (cid: string) => Promise<SweRebenchV2MintedPoolArtifact>;

  private async loadArtifact(cid: string): Promise<SweRebenchV2MintedPoolArtifact> {
    const cached = this.artifactCache.get(cid);
    if (cached) return cached;
    // Callers may return untrusted JSON under a type assertion; parse at this
    // trust boundary so a malformed v2 row never reaches a grading runner.
    const artifact = parseMintedPoolArtifact(await this.fetchMinted(cid));
    this.artifactCache.set(cid, artifact);
    return artifact;
  }

  async fetchMintedRow(args: { hf_dataset: string; instance_id: string }): Promise<RoutedMintedPoolRow | null> {
    const mintCid = parseMintedIpfsDataset(args.hf_dataset);
    if (!mintCid) return null;
    const artifact = await this.loadArtifact(mintCid);
    const row = artifact.rows.find((candidate) => candidate.instance_id === args.instance_id);
    if (!row) throw new Error(`minted row not found: ${args.instance_id} in ${mintCid}`);
    return { cid: mintCid, artifact, row };
  }

  async fetchTaskRow(args: { hf_dataset: string; hf_split: string; instance_id: string }): Promise<HfRow> {
    const minted = await this.fetchMintedRow(args);
    if (minted) return asHfRow(minted.row);
    return this.hf.fetchTaskRow(args);
  }
}

/** Kept as a routing-module export for existing CLI/test import sites. */
export { parseMintedPoolArtifact } from '../../../solver-types/_swe-rebench-v2-minted-pool.js';
