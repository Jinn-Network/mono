/**
 * Harvest state — per-repo scan cursor + rejected-candidate cache.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

const HARVEST_STATE_FILE = 'harvest-state.json';
const SCHEMA_VERSION = 'swe-rebench-v2-harvest-state.v1' as const;

export interface HarvestRepoState {
  lastScannedCommit: string;
  rejected: Record<string, { reason: string; at: string }>;
}

export interface HarvestStateFile {
  schemaVersion: typeof SCHEMA_VERSION;
  updatedAt: string;
  repos: Record<string, HarvestRepoState>;
}

export class HarvestStateStore {
  private readonly file: string;
  private cache: HarvestStateFile | null = null;

  constructor(opts: { stateDir: string }) {
    this.file = resolvePath(join(opts.stateDir, HARVEST_STATE_FILE));
  }

  private fresh(): HarvestStateFile {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      repos: {},
    };
  }

  private async load(): Promise<HarvestStateFile> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as HarvestStateFile;
      if (raw.schemaVersion === SCHEMA_VERSION) {
        this.cache = raw;
        return raw;
      }
    } catch {
      // missing
    }
    this.cache = this.fresh();
    return this.cache;
  }

  private async persist(file: HarvestStateFile): Promise<void> {
    file.updatedAt = new Date().toISOString();
    await mkdir(resolvePath(join(this.file, '..')), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
    this.cache = file;
  }

  async getRepo(repoKey: string): Promise<HarvestRepoState | null> {
    const file = await this.load();
    return file.repos[repoKey] ?? null;
  }

  async setLastScannedCommit(repoKey: string, commit: string): Promise<void> {
    const file = await this.load();
    const prev = file.repos[repoKey] ?? { lastScannedCommit: '', rejected: {} };
    file.repos[repoKey] = { ...prev, lastScannedCommit: commit };
    await this.persist(file);
  }

  async recordRejected(repoKey: string, instanceId: string, reason: string): Promise<void> {
    const file = await this.load();
    const prev = file.repos[repoKey] ?? { lastScannedCommit: '', rejected: {} };
    prev.rejected[instanceId] = { reason, at: new Date().toISOString() };
    file.repos[repoKey] = prev;
    await this.persist(file);
  }

  isRejected(repoState: HarvestRepoState | null, instanceId: string): boolean {
    return Boolean(repoState?.rejected[instanceId]);
  }
}
