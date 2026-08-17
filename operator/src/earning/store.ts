/**
 * Fleet state persistence.
 *
 * State lives at ~/.jinn-client/earning/earning_state.json.
 * Mnemonic keystore lives at ~/.jinn-client/earning/master_keystore.json.
 * Legacy keystore (if present) at ~/.jinn-client/earning/agent_keystore.json.
 */

import { existsSync } from 'fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import {
  type FleetState,
  type ServiceState,
  FleetStateSchema,
  createDefaultFleetState,
} from './types.js';
import { resolveDefaultStateDir } from '../state-dir.js';

export const DEFAULT_EARNING_DIR = path.join(resolveDefaultStateDir(), 'earning');

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
  /**
   * True iff the migration explicitly suppressed the local-state wipe because
   * the on-chain retire failed (jinn-mono-hjex.1). Pre-PR archive entries do
   * NOT have this field — readers that filter on it MUST treat undefined as
   * `false` so legacy entries (where state was wiped even though retire
   * failed) are not surfaced as preserved-state retire failures.
   */
  wipe_suppressed?: boolean;
}

export interface EarningMigrationArchive {
  schemaVersion: 1;
  updated_at: string;
  entries: EarningMigrationArchiveEntry[];
}

export interface ArchivedMismatchedFleetState {
  expectedChain: 'base' | 'base-sepolia';
  actualChain: 'base' | 'base-sepolia';
  archivedPaths: string[];
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

/**
 * Non-destructive migration: when a state file is loaded with the legacy
 * shape (no `fleet_*` fields), promote `services[0]`'s identity to the
 * fleet level. Existing operators upgrading to nghf get a coherent
 * fleet-level identity without re-minting or re-deploying their Safe.
 *
 * Rules:
 *   - If the parsed file already has `fleet_agent_id` set (nullable), do
 *     nothing — recent state already has fleet identity.
 *   - Else if `services[0].agent_id` is set, copy `agent_id`,
 *     `safe_address`, `identity_registry_address` to the fleet level.
 *     Set `fleet_stage = 'stage1_and_2'` if any service has reached
 *     `complete`/`safe_binding_pending`, else `stage1`.
 *   - Else if any service is operational (`complete`/`safe_binding_pending`)
 *     but no agent_id exists yet (pre-j07), set `fleet_stage = 'stage1_and_2'`
 *     without populating fleet_* identity — these operators run through the
 *     legacy agent-id backfill path in main.ts and ensureStage1 becomes a
 *     no-op (`stage1_and_2 >= stage1`).
 *   - Else leave `fleet_stage = 'none'` (fresh fleet).
 *
 * Per-service identity fields on `services[]` are NOT cleared. The promotion
 * is non-destructive and idempotent.
 *
 * See docs/superpowers/specs/2026-05-14-nghf-staged-bootstrap-fit-findings.md §5.
 */
function applyNghfMigration(state: FleetState): FleetState {
  if (state.fleet_agent_id) return state;

  const firstService = state.services[0];
  const anyOperational = state.services.some(
    (s) => s.step === 'complete' || s.step === 'safe_binding_pending',
  );

  if (firstService?.agent_id) {
    return {
      ...state,
      fleet_agent_id: firstService.agent_id,
      fleet_safe_address: firstService.safe_address ?? state.fleet_safe_address ?? null,
      fleet_identity_registry:
        firstService.identity_registry_address ?? state.fleet_identity_registry ?? null,
      fleet_stage: anyOperational ? 'stage1_and_2' : 'stage1',
    };
  }

  if (anyOperational) {
    return {
      ...state,
      fleet_stage: 'stage1_and_2',
    };
  }

  return state;
}

/** Parse fleet JSON without side effects (for status / read-only tools). */
export function parseFleetStateJson(raw: string): FleetState | null {
  try {
    const parsed = JSON.parse(raw);
    const result = FleetStateSchema.safeParse(parsed);
    if (result.success) {
      return applyNghfMigration(result.data);
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

  async archiveIfChainMismatch(
    expectedChain: 'base' | 'base-sepolia',
  ): Promise<ArchivedMismatchedFleetState | null> {
    const existing = await this.tryLoadExisting();
    if (!existing || existing.chain === expectedChain) {
      return null;
    }

    await mkdir(this.earningDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = `.chain-${existing.chain}-archived-for-${expectedChain}.${stamp}.bak`;
    const archivedPaths: string[] = [];
    const archiveFile = async (fileName: string): Promise<void> => {
      const src = path.join(this.earningDir, fileName);
      if (!existsSync(src)) return;
      const dest = path.join(this.earningDir, `${fileName}${suffix}`);
      await rename(src, dest);
      archivedPaths.push(dest);
    };

    await archiveFile(STATE_FILE);
    await archiveFile(MIGRATIONS_FILE);
    await archiveFile('bootstrap-funding.json');
    await archiveFile('bootstrap-error.json');

    return {
      expectedChain,
      actualChain: existing.chain,
      archivedPaths,
    };
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

  async archiveMnemonicKeystore(label: string): Promise<string | null> {
    if (!existsSync(this.mnemonicKeystorePath)) {
      return null;
    }
    await mkdir(this.earningDir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(
      this.earningDir,
      `${MNEMONIC_KEYSTORE_FILE}.${safeLabel}.${stamp}.bak`,
    );
    await rename(this.mnemonicKeystorePath, archivePath);
    return archivePath;
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
