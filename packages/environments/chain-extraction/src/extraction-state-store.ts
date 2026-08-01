// SPDX-License-Identifier: Apache-2.0

// The only production filesystem surface in this package besides fixture loading. The
// directory is an argument, never ambient: nothing here reads the ambient environment.

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parseExtractionStateFile,
  serializeExtractionStateFile,
  type ExtractionStateFile,
  type ExtractionStateStore,
} from "./extraction-state.js";

const STATE_FILE = "extraction-state.json";

let temporarySequence = 0;

/**
 * Crash-safe extraction-state persistence: write and fsync a unique temporary file,
 * rename it over the state file, then fsync the directory so the rename itself survives
 * power loss.
 */
export function createFileExtractionStateStore(directory: string): ExtractionStateStore {
  const root = resolve(directory);
  const file = join(root, STATE_FILE);

  return {
    async read(): Promise<ExtractionStateFile | null> {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(file);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
      return parseExtractionStateFile(bytes);
    },

    async write(state: ExtractionStateFile): Promise<void> {
      await mkdir(root, { recursive: true, mode: 0o700 });
      temporarySequence += 1;
      const temporary = `${file}.${process.pid}.${temporarySequence}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(serializeExtractionStateFile(state));
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
