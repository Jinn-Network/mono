// SPDX-License-Identifier: Apache-2.0

// The only production filesystem surface in this package. The directory is an
// argument, never ambient: nothing here reads process.env, and the guard's
// filesystem allowlist names exactly this file (Findings F-C2-5).

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parseStagedStateFile,
  serializeStagedStateFile,
  type StagedStateFile,
  type StagedStateStore,
} from "./staged-state.js";

const STATE_FILE = "staged-state.json";

/**
 * Crash-safe staged-state persistence: write to a unique temporary file, then
 * rename it over the state file. A crash mid-write leaves the previous state
 * intact and an abandoned `.tmp` sibling that no read ever consults.
 */
export function createFileStagedStateStore(directory: string): StagedStateStore {
  const root = resolve(directory);
  const file = join(root, STATE_FILE);
  let sequence = 0;

  return {
    async read(): Promise<StagedStateFile | null> {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(file);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
      return parseStagedStateFile(bytes);
    },

    async write(state: StagedStateFile): Promise<void> {
      await mkdir(root, { recursive: true, mode: 0o700 });
      sequence += 1;
      const temporary = `${file}.${process.pid}.${sequence}.tmp`;
      try {
        await writeFile(temporary, serializeStagedStateFile(state), { mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
