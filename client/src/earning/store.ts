/**
 * Fleet state persistence.
 *
 * State lives at ~/.jinn-client/earning/earning_state.json.
 * Mnemonic keystore lives at ~/.jinn-client/earning/master_keystore.json.
 * Legacy keystore (if present) at ~/.jinn-client/earning/agent_keystore.json.
 */

import { existsSync } from 'fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  type FleetState,
  type ServiceState,
  FleetStateSchema,
  createDefaultFleetState,
} from './types.js';

export const DEFAULT_EARNING_DIR = path.join(os.homedir(), '.jinn-client', 'earning');

export const STATE_FILE = 'earning_state.json';
export const MNEMONIC_KEYSTORE_FILE = 'master_keystore.json';
export const LEGACY_KEYSTORE_FILE = 'agent_keystore.json';
export const MIGRATIONS_FILE = 'earning_migrations.json';

export type EarningMigrationKind = 'base-sepolia-standard-setup';
export type EarningMigrationRetireStatus = 'pending' | 'retired' | 'already_inactive' | 'failed';

export interface EarningMigrationArchiveEntry {
  migration_id: string;
  kind: EarningMigrationKind;
  chain: 'base' | 'base-sepolia';
  service_index: number;
  created_at: string;
  updated_at: string;
  backup_state_path: string;
  from: {
    service_id: number | null;
    safe_address: string | null;
    mech_address: string | null;
    staking_address: string | null;
    step: string;
    agent_id: string | null;
  };
  to: {
    staking_address: string;
  };
  retire_status: EarningMigrationRetireStatus;
  retire_tx_hash?: string | null;
  retire_error?: string | null;
  state_reset_at?: string | null;
}

export interface EarningMigrationArchive {
  schemaVersion: 1;
  updated_at: string;
  entries: EarningMigrationArchiveEntry[];
}

/** Absolute path to the encrypted mnemonic keystore for a given earning dir. */
export function mnemonicKeystorePath(earningDir: string): string {
  return path.join(earningDir, MNEMONIC_KEYSTORE_FILE);
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

/** Parse fleet JSON without side effects (for status / read-only tools). */
export function parseFleetStateJson(raw: string): FleetState | null {
  try {
    const parsed = JSON.parse(raw);
    const result = FleetStateSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    return null;
  } catch {
    return null;
  }
}

function parseFleetStateOrNull(raw: string): FleetState | null {
  const data = parseFleetStateJson(raw);
  if (data) return data;
  try {
    JSON.parse(raw);
    console.error('[earning-store] Invalid state schema; resetting.');
  } catch (error) {
    console.error('[earning-store] Failed to parse state; resetting:', error);
  }
  return null;
}

export class FleetStateStore {
  private readonly statePath: string;
  private readonly mnemonicKeystorePath: string;
  private readonly legacyKeystorePath: string;
  private readonly migrationsPath: string;
  private readonly earningDir: string;

  constructor(earningDir: string = DEFAULT_EARNING_DIR) {
    this.earningDir = earningDir;
    this.statePath = path.join(earningDir, STATE_FILE);
    this.mnemonicKeystorePath = path.join(earningDir, MNEMONIC_KEYSTORE_FILE);
    this.legacyKeystorePath = path.join(earningDir, LEGACY_KEYSTORE_FILE);
    this.migrationsPath = path.join(earningDir, MIGRATIONS_FILE);
  }

  get dir(): string {
    return this.earningDir;
  }

  hasStateFile(): boolean {
    return existsSync(this.statePath);
  }

  // ── Mnemonic keystore ──────────────────────────────────────────────────

  hasMnemonicKeystore(): boolean {
    return existsSync(this.mnemonicKeystorePath);
  }

  async loadMnemonicKeystore(): Promise<string> {
    return readFile(this.mnemonicKeystorePath, 'utf8');
  }

  async saveMnemonicKeystore(encryptedJson: string): Promise<void> {
    await writeJsonAtomic(this.mnemonicKeystorePath, JSON.parse(encryptedJson));
  }

  // ── Legacy detection ───────────────────────────────────────────────────

  hasLegacyKeystore(): boolean {
    return existsSync(this.legacyKeystorePath);
  }

  async migrateLegacyFiles(): Promise<void> {
    if (existsSync(this.legacyKeystorePath)) {
      await rename(this.legacyKeystorePath, `${this.legacyKeystorePath}.legacy`);
    }
    if (existsSync(this.statePath)) {
      await rename(this.statePath, `${this.statePath}.legacy`);
    }
    console.error(
      '[earning-store] Legacy keystore detected. Old files renamed with .legacy suffix. ' +
      'A new mnemonic wallet will be generated.',
    );
  }

  // ── Fleet state ────────────────────────────────────────────────────────

  /**
   * Read persisted fleet state if the file exists and validates.
   * Does not create a default file (unlike load()).
   */
  async tryLoadExisting(): Promise<FleetState | null> {
    if (!existsSync(this.statePath)) {
      return null;
    }
    const raw = await readFile(this.statePath, 'utf8');
    return parseFleetStateJson(raw);
  }

  async load(chain: 'base' | 'base-sepolia' = 'base'): Promise<FleetState> {
    if (!existsSync(this.statePath)) {
      const state = createDefaultFleetState(chain);
      await writeJsonAtomic(this.statePath, state);
      return state;
    }

    const raw = await readFile(this.statePath, 'utf8');
    const parsed = parseFleetStateOrNull(raw);

    if (parsed) {
      return parsed;
    }

    const backupPath = `${this.statePath}.invalid-${Date.now()}`;
    await rename(this.statePath, backupPath);

    const state = createDefaultFleetState(chain);
    await writeJsonAtomic(this.statePath, state);
    console.error(`[earning-store] Backed up invalid state to ${backupPath}`);
    return state;
  }

  async save(state: FleetState): Promise<FleetState> {
    const next: FleetState = {
      ...state,
      updated_at: new Date().toISOString(),
    };
    const validated = FleetStateSchema.parse(next);
    await writeJsonAtomic(this.statePath, validated);
    return validated;
  }

  async backupStateFile(label: string): Promise<string | null> {
    if (!existsSync(this.statePath)) {
      return null;
    }
    await mkdir(this.earningDir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.earningDir, `${STATE_FILE}.${safeLabel}.${stamp}.bak`);
    await copyFile(this.statePath, backupPath);
    return backupPath;
  }

  async loadMigrationArchive(): Promise<EarningMigrationArchive> {
    if (!existsSync(this.migrationsPath)) {
      return {
        schemaVersion: 1,
        updated_at: new Date().toISOString(),
        entries: [],
      };
    }

    try {
      const raw = await readFile(this.migrationsPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<EarningMigrationArchive>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
        return {
          schemaVersion: 1,
          updated_at: new Date().toISOString(),
          entries: [],
        };
      }
      return {
        schemaVersion: 1,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date().toISOString(),
        entries: parsed.entries as EarningMigrationArchiveEntry[],
      };
    } catch {
      return {
        schemaVersion: 1,
        updated_at: new Date().toISOString(),
        entries: [],
      };
    }
  }

  async upsertMigrationArchiveEntry(
    entry: Omit<EarningMigrationArchiveEntry, 'created_at' | 'updated_at'> & {
      created_at?: string;
      updated_at?: string;
    },
  ): Promise<EarningMigrationArchiveEntry> {
    const archive = await this.loadMigrationArchive();
    const now = new Date().toISOString();
    const idx = archive.entries.findIndex(e => e.migration_id === entry.migration_id);
    const existing = idx >= 0 ? archive.entries[idx]! : undefined;
    const next: EarningMigrationArchiveEntry = {
      ...(existing ?? {}),
      ...entry,
      created_at: existing?.created_at ?? entry.created_at ?? now,
      updated_at: entry.updated_at ?? now,
    };

    if (idx >= 0) {
      archive.entries[idx] = next;
    } else {
      archive.entries.push(next);
    }

    const saved: EarningMigrationArchive = {
      schemaVersion: 1,
      updated_at: now,
      entries: archive.entries,
    };
    await writeJsonAtomic(this.migrationsPath, saved);
    return next;
  }

  async patchFleet(patch: Partial<Omit<FleetState, 'services'>>): Promise<FleetState> {
    const current = await this.load();
    return this.save({ ...current, ...patch });
  }

  async updateService(index: number, patch: Partial<ServiceState>): Promise<FleetState> {
    const current = await this.load();
    const svcIdx = current.services.findIndex(s => s.index === index);
    if (svcIdx === -1) {
      throw new Error(`Service at index ${index} not found in state`);
    }
    current.services[svcIdx] = { ...current.services[svcIdx], ...patch };
    return this.save(current);
  }

  async addService(service: ServiceState): Promise<FleetState> {
    const current = await this.load();
    current.services.push(service);
    return this.save(current);
  }

  /** Remove one service row by its persisted `index` (not array offset). */
  async removeService(index: number): Promise<FleetState> {
    const current = await this.load();
    const next = current.services.filter(s => s.index !== index);
    if (next.length === current.services.length) {
      throw new Error(`Service at index ${index} not found in state`);
    }
    return this.save({ ...current, services: next });
  }
}
