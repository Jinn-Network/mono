/**
 * Synthetic-session fixture for testing Path 1 plug-in slot-registry
 * hand-off without spawning a real Claude Code subprocess. Mirrors the
 * effect of the bundled `hooks/session-start` script: when the env
 * carries `JINN_SLOT_REGISTRY_JSON`, write it to
 * `<workingDir>/.coordinator/slots.json`.
 *
 * See plan
 * docs/superpowers/plans/2026-04-30-plug-in-surface-path-1-mechanism.md
 * Task 5 step 5.7.
 */

import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface SyntheticSession {
  /** Synthesised workingDir for this session. */
  workingDir: string;
  /** Apply the equivalent of the hook script to the supplied env. */
  applySessionStart(env: Record<string, string>): void;
  /** Read the resulting slots.json (returns null if not written). */
  readSlots(): unknown | null;
}

export function makeSyntheticSession(): SyntheticSession {
  const workingDir = mkdtempSync(join(tmpdir(), 'jinn-synth-'));
  return {
    workingDir,
    applySessionStart(env: Record<string, string>) {
      const json = env.JINN_SLOT_REGISTRY_JSON;
      if (!json) return;
      mkdirSync(join(workingDir, '.coordinator'), { recursive: true });
      writeFileSync(join(workingDir, '.coordinator', 'slots.json'), json);
    },
    readSlots() {
      const path = join(workingDir, '.coordinator', 'slots.json');
      return existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as unknown)
        : null;
    },
  };
}
