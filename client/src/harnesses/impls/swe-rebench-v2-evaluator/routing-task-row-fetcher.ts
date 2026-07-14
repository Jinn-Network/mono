/**
 * Routing task-row fetcher — resolves an `HfFetcher` task row from whichever
 * backend the dataset ref names: the HF datasets-server for benchmark rows, or
 * an `ipfs://` minted-rows artifact for task-creator instances. Spec §4.2.
 *
 * Named for what it does (route a task-row fetch), not the HF backend — the
 * `HfFetcher` interface it implements keeps the legacy name pending a wider
 * port rename.
 */

import type { HfFetcher, HfRow } from './index.js';
import { HttpHfFetcher } from './hf-fetcher.js';
import type { SweRebenchV2MintedPoolArtifact } from '../../../solver-types/_swe-rebench-v2-minted-pool.js';
import { parseMintedIpfsDataset } from '../../../solver-types/_swe-rebench-v2-minted-pool.js';

export interface RoutingTaskRowFetcherDeps {
  hf?: HfFetcher;
  fetchMintedArtifact: (cid: string) => Promise<SweRebenchV2MintedPoolArtifact>;
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
    const artifact = await this.fetchMinted(cid);
    this.artifactCache.set(cid, artifact);
    return artifact;
  }

  async fetchTaskRow(args: { hf_dataset: string; hf_split: string; instance_id: string }): Promise<HfRow> {
    const mintCid = parseMintedIpfsDataset(args.hf_dataset);
    if (mintCid) {
      const artifact = await this.loadArtifact(mintCid);
      const row = artifact.rows.find((r) => r.instance_id === args.instance_id);
      if (!row) throw new Error(`minted row not found: ${args.instance_id} in ${mintCid}`);
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
    return this.hf.fetchTaskRow(args);
  }
}

export function parseMintedPoolArtifact(raw: unknown): SweRebenchV2MintedPoolArtifact {
  if (!raw || typeof raw !== 'object') throw new Error('minted pool artifact must be an object');
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 'swe-rebench-v2-minted-pool.v1') {
    throw new Error('invalid minted pool artifact schemaVersion');
  }
  if (!Array.isArray(o.rows)) throw new Error('minted pool artifact rows must be an array');
  return raw as SweRebenchV2MintedPoolArtifact;
}
