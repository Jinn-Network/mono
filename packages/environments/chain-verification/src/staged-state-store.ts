// SPDX-License-Identifier: Apache-2.0

// The only production filesystem surface in this package. The directory is an
// argument, never ambient: nothing here reads the ambient environment, and the guard's
// filesystem allowlist names exactly this file (Finding F-CE3-6).

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parseStagedStateFile,
  serializeStagedStateFile,
  type StagedStateFile,
  type StagedStateStore,
} from "./staged-state.js";

const STATE_FILE = "staged-state.json";

function temporaryCounter(updatedAt: string): string {
  const millis = new Date(updatedAt).getTime();
  if (!Number.isFinite(millis)) {
    return updatedAt.replace(/[^0-9]/g, "");
  }
  return String(millis);
}

/**
 * Crash-safe staged-state persistence: write and fsync a temporary file derived from
 * the state's own `updatedAt`, rename it over the state file, then fsync the
 * directory so the rename itself survives power loss. A crash mid-write leaves the
 * previous state intact and an abandoned `.tmp` sibling that no read ever consults.
 */
export function createFileStagedStateStore(directory: string): StagedStateStore {
  const root = resolve(directory);
  const file = join(root, STATE_FILE);

  return {
    async load(): Promise<StagedStateFile | null> {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(file);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
      return parseStagedStateFile(bytes);
    },

    async save(state: StagedStateFile): Promise<void> {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = join(root, `.staged-state.${temporaryCounter(state.updatedAt)}.tmp`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(serializeStagedStateFile(state));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
        const directoryHandle = await open(root, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
