/**
 * Mode-switch metadata persistence.
 *
 * Tracks `lastModeSwitchAt` so the dashboard's HarnessStatusPanel can report
 * when the operator most recently flipped between train and frozen. Written
 * by `jinn harnesses mode <train|frozen>`; read by the harness-status API
 * endpoint and by `harness status`.
 *
 * Stored at `<configDir>/harness/mode-state.json` (configDir defaults to
 * `~/.jinn-client/`). Failure to read is non-fatal — callers fall back to
 * `lastModeSwitchAt: undefined`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDefaultStateDir } from '../state-dir.js';

export interface ModeState {
  mode: 'train' | 'frozen';
  switchedAt: number;
}

export function defaultModeStatePath(): string {
  // Tests + CI set JINN_HARNESS_MODE_STATE_PATH to a tmp path so they don't
  // leak writes into the developer's `~/.jinn-client/`.
  const env = process.env['JINN_HARNESS_MODE_STATE_PATH'];
  if (env && env.length > 0) return env;
  return join(resolveDefaultStateDir(), 'harness', 'mode-state.json');
}

export function readModeState(path: string = defaultModeStatePath()): ModeState | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ModeState>;
    if (raw.mode !== 'train' && raw.mode !== 'frozen') return null;
    if (typeof raw.switchedAt !== 'number') return null;
    return { mode: raw.mode, switchedAt: raw.switchedAt };
  } catch {
    return null;
  }
}

export function writeModeState(state: ModeState, path: string = defaultModeStatePath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}
