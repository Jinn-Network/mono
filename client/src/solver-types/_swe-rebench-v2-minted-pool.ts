/**
 * Minted pool store + IPFS artifact for task-creator minted instances.
 * Spec: spec/2026-07-08-task-creator-v0.md §4.2 — gold patch is never published.
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve as resolvePath, join } from 'node:path';
import type { HfRow } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { canonicalJson } from '../harnesses/engine/canonical-json.js';
import type { PoolTask } from './_swe-rebench-v2-pool.js';
import {
  EVAL_SEMANTICS_VERSION,
  type ValidatedPoolEntry,
} from './_swe-rebench-v2-validated-pool.js';

const SCHEMA_VERSION = 'swe-rebench-v2-minted-pool.v1' as const;
export const SWE_REBENCH_V2_MINTED_POOL_ARTIFACT_TYPE = 'swe-rebench-v2-minted-pool.v1' as const;
const MINTED_POOL_FILE = 'minted-pool.json';

export interface MintedProvenance {
  synthetic: true;
  mintFamily: string;
  sourceLineageHash: string;
  sourceInstanceId?: string;
  minterSafe?: string;
  blindedUntil?: string;
}

/** Published row — no gold `patch` field (§10.1). */
export interface MintedPoolRow extends Omit<HfRow, never> {
  instance_id: string;
  repo: string;
  problem_statement?: string;
  base_commit?: string;
}

export interface MintedPoolEntry {
  row: MintedPoolRow;
  provenance: MintedProvenance;
  admission: ValidatedPoolEntry;
  hf_dataset: string;
  hf_split: string;
  mintedAt: string;
}

interface MintedPoolFile {
  schemaVersion: typeof SCHEMA_VERSION;
  evalSemanticsVersion: string;
  updatedAt: string;
  /** Latest published IPFS artifact CID for generator/evaluator row routing. */
  publishedArtifactCid?: string;
  entries: Record<string, MintedPoolEntry>;
}

export interface SweRebenchV2MintedPoolArtifact {
  schemaVersion: typeof SWE_REBENCH_V2_MINTED_POOL_ARTIFACT_TYPE;
  evalSemanticsVersion: string;
  generatedAt: string;
  rows: MintedPoolRow[];
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(resolvePath(join(file, '..')), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export function hashMintedPoolArtifact(artifact: SweRebenchV2MintedPoolArtifact): `sha256:${string}` {
  const digest = createHash('sha256').update(canonicalJson(artifact)).digest('hex');
  return `sha256:${digest}`;
}

export class MintedPoolStore {
  private readonly file: string;
  private cache: MintedPoolFile | null = null;

  constructor(opts: { stateDir: string }) {
    this.file = resolvePath(join(opts.stateDir, MINTED_POOL_FILE));
  }

  private fresh(evalSemanticsVersion: string): MintedPoolFile {
    return {
      schemaVersion: SCHEMA_VERSION,
      evalSemanticsVersion,
      updatedAt: new Date().toISOString(),
      entries: {},
    };
  }

  private async load(evalSemanticsVersion: string): Promise<MintedPoolFile> {
    if (this.cache && this.cache.evalSemanticsVersion === evalSemanticsVersion) return this.cache;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as MintedPoolFile;
      if (raw.schemaVersion === SCHEMA_VERSION) {
        this.cache = raw;
        return raw;
      }
    } catch {
      // missing
    }
    this.cache = this.fresh(evalSemanticsVersion);
    return this.cache;
  }

  async record(instanceId: string, entry: MintedPoolEntry, evalSemanticsVersion: string): Promise<void> {
    const file = await this.load(evalSemanticsVersion);
    file.entries[instanceId] = entry;
    file.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.file, file);
    this.cache = file;
  }

  async getPublishedArtifactCid(evalSemanticsVersion: string): Promise<string | null> {
    const file = await this.load(evalSemanticsVersion);
    return file.publishedArtifactCid ?? null;
  }

  /**
   * After IPFS publish, back-fill resolvable `hf_dataset` refs on entries so
   * posted tasks grade through RoutingTaskRowFetcher.
   */
  async setPublishedArtifact(
    evalSemanticsVersion: string,
    artifactCid: string,
    instanceIds?: string[],
  ): Promise<void> {
    const file = await this.load(evalSemanticsVersion);
    file.publishedArtifactCid = artifactCid;
    const hfDataset = mintedIpfsDatasetCid(artifactCid);
    const targets = instanceIds
      ? new Set(instanceIds)
      : new Set(Object.keys(file.entries));
    for (const id of targets) {
      const entry = file.entries[id];
      if (!entry) continue;
      entry.hf_dataset = hfDataset;
    }
    file.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.file, file);
    this.cache = file;
  }

  async getEntry(instanceId: string, evalSemanticsVersion: string): Promise<MintedPoolEntry | null> {
    const file = await this.load(evalSemanticsVersion);
    return file.entries[instanceId] ?? null;
  }

  async listEntries(evalSemanticsVersion: string): Promise<MintedPoolEntry[]> {
    const file = await this.load(evalSemanticsVersion);
    return Object.values(file.entries);
  }

  async exportArtifact(evalSemanticsVersion: string, opts: { generatedAt?: string } = {}): Promise<SweRebenchV2MintedPoolArtifact> {
    const entries = await this.listEntries(evalSemanticsVersion);
    const rows = entries
      .filter((e) => e.admission.scorable && e.admission.discrimination !== 'fail')
      .map((e) => e.row)
      .sort((a, b) => a.instance_id.localeCompare(b.instance_id));
    return {
      schemaVersion: SWE_REBENCH_V2_MINTED_POOL_ARTIFACT_TYPE,
      evalSemanticsVersion,
      generatedAt: opts.generatedAt ?? new Date().toISOString(),
      rows,
    };
  }

  /** Gold patches keyed by instance_id — local only, never published. */
  async goldPatches(evalSemanticsVersion: string): Promise<Map<string, string>> {
    const file = await this.load(evalSemanticsVersion);
    const map = new Map<string, string>();
    for (const [id, entry] of Object.entries(file.entries)) {
      const patch = (entry as MintedPoolEntry & { goldPatch?: string }).goldPatch;
      if (typeof patch === 'string') map.set(id, patch);
    }
    return map;
  }
}

export function mintedIpfsDatasetCid(cid: string): string {
  return `ipfs://${cid}`;
}

export function parseMintedIpfsDataset(hfDataset: string): string | null {
  if (!hfDataset.startsWith('ipfs://')) return null;
  return hfDataset.slice('ipfs://'.length);
}

export function getDefaultMintedPoolStore(stateDir: string): MintedPoolStore {
  return new MintedPoolStore({ stateDir });
}

/** Pool tasks from admitted minted entries (generator union). */
export async function loadMintedPoolTasks(
  store: MintedPoolStore,
  evalSemanticsVersion: string,
  artifactCid?: string,
): Promise<PoolTask[]> {
  const storedCid = artifactCid ?? (await store.getPublishedArtifactCid(evalSemanticsVersion));
  const entries = await store.listEntries(evalSemanticsVersion);
  const hfDataset = storedCid ? mintedIpfsDatasetCid(storedCid) : null;
  return entries
    .filter((e) => e.admission.scorable && e.admission.discrimination !== 'fail')
    .filter((e) => {
      if (!hfDataset) return false;
      return !e.hf_dataset || e.hf_dataset.startsWith('ipfs://');
    })
    .map((e) => ({
      instance_id: e.row.instance_id,
      hf_dataset: e.hf_dataset || hfDataset!,
      hf_split: e.hf_split || 'minted',
      repo: e.row.repo,
      base_commit: e.row.base_commit,
      patch: (e as MintedPoolEntry & { goldPatch?: string }).goldPatch ?? '',
      test_patch: e.row.test_patch,
      language: 'python' as const,
      problem_statement: e.row.problem_statement,
    }));
}

export { EVAL_SEMANTICS_VERSION };
