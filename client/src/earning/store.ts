/**
 * Earning state persistence.
 *
 * Follows the same atomic-write + Zod-validation pattern as profile-store.ts.
 * State lives at ~/.jinn-client/earning/earning_state.json.
 * Keystore lives at ~/.jinn-client/earning/agent_keystore.json.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  type EarningState,
  EarningStateSchema,
  createDefaultEarningState,
} from './types.js';

export const DEFAULT_EARNING_DIR = path.join(os.homedir(), '.jinn-client', 'earning');
export const DEFAULT_EARNING_STATE_PATH = path.join(DEFAULT_EARNING_DIR, 'earning_state.json');
export const DEFAULT_KEYSTORE_PATH = path.join(DEFAULT_EARNING_DIR, 'agent_keystore.json');

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

function parseStateOrNull(raw: string): EarningState | null {
  try {
    const parsed = JSON.parse(raw);
    const result = EarningStateSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }

    console.error(
      '[earning-store] Invalid earning_state.json schema; resetting state. Issues:',
      result.error.issues.map((issue) => issue.path.join('.')),
    );
    return null;
  } catch (error) {
    console.error('[earning-store] Failed to parse earning_state.json; resetting state:', error);
    return null;
  }
}

export class EarningStateStore {
  private readonly statePath: string;
  private readonly keystorePath: string;
  private readonly earningDir: string;

  constructor(earningDir: string = DEFAULT_EARNING_DIR) {
    this.earningDir = earningDir;
    this.statePath = path.join(earningDir, 'earning_state.json');
    this.keystorePath = path.join(earningDir, 'agent_keystore.json');
  }

  get dir(): string {
    return this.earningDir;
  }

  getStatePath(): string {
    return this.statePath;
  }

  getKeystorePath(): string {
    return this.keystorePath;
  }

  hasKeystore(): boolean {
    return existsSync(this.keystorePath);
  }

  async loadKeystore(): Promise<string> {
    return readFile(this.keystorePath, 'utf8');
  }

  async saveKeystore(json: string): Promise<void> {
    await writeJsonAtomic(this.keystorePath, JSON.parse(json));
  }

  async load(): Promise<EarningState> {
    if (!existsSync(this.statePath)) {
      const state = createDefaultEarningState();
      await writeJsonAtomic(this.statePath, state);
      return state;
    }

    const raw = await readFile(this.statePath, 'utf8');
    const parsed = parseStateOrNull(raw);

    if (parsed) {
      return parsed;
    }

    const backupPath = `${this.statePath}.invalid-${Date.now()}`;
    await rename(this.statePath, backupPath);

    const state = createDefaultEarningState();
    await writeJsonAtomic(this.statePath, state);
    console.error(`[earning-store] Backed up invalid earning state to ${backupPath} and created a fresh one`);
    return state;
  }

  async save(state: EarningState): Promise<EarningState> {
    const next: EarningState = {
      ...state,
      updated_at: new Date().toISOString(),
    };

    const validated = EarningStateSchema.parse(next);
    await writeJsonAtomic(this.statePath, validated);
    return validated;
  }

  async patch(patch: Partial<EarningState>): Promise<EarningState> {
    const current = await this.load();
    return this.save({ ...current, ...patch });
  }
}
