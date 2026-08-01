// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertBareHex, documentDigest } from "../digest.js";
import { DerivationError } from "../errors.js";
import type { GoldRef, GoldStore } from "../gold.js";

export const GOLD_STORE_MARKER_FILE = "DO-NOT-PUBLISH";

const MARKER_TEXT =
  "Local-only gold-patch store.\n"
  + "These files are the answers to admitted tasks. Do not publish, sync, or serve this\n"
  + "directory. The supply pool deliberately contains none of these bytes.\n";

export interface FilesystemGoldStoreOptions {
  readonly dir: string;
  /** See the pool's option of the same name: injected, never ambient. */
  readonly uniqueSuffix: () => string;
}

function addressOf(goldPatchHash: string): string {
  return assertBareHex(
    goldPatchHash.startsWith("sha256:") ? goldPatchHash.slice("sha256:".length) : goldPatchHash,
    "goldPatchHash",
  );
}

export function createFilesystemGoldStore(options: FilesystemGoldStoreOptions): GoldStore {
  return {
    async put(goldPatch: Uint8Array): Promise<GoldRef> {
      if (goldPatch.byteLength === 0) {
        throw new DerivationError("invalid-input", "gold patch must be non-empty.");
      }
      const goldPatchHash = documentDigest(goldPatch);
      const address = goldPatchHash.slice("sha256:".length);

      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      await writeFile(join(options.dir, GOLD_STORE_MARKER_FILE), MARKER_TEXT, { mode: 0o600 });

      const staging = join(options.dir, `.${address}.${options.uniqueSuffix()}`);
      try {
        await writeFile(staging, goldPatch, { mode: 0o600 });
        await chmod(staging, 0o600);
        await rename(staging, join(options.dir, `${address}.patch`));
      } catch (error) {
        await rm(staging, { force: true });
        throw error;
      }
      return { goldPatchHash };
    },

    async get(goldPatchHash: string): Promise<Uint8Array | undefined> {
      const address = addressOf(goldPatchHash);
      try {
        return new Uint8Array(await readFile(join(options.dir, `${address}.patch`)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}
