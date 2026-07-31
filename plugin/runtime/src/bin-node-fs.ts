// SPDX-License-Identifier: Apache-2.0
/**
 * Node filesystem adapters for the bin composition root only (C5-P3 / C6-P3).
 * Library modules must not import `node:fs*`; this file is imported solely from `bin.ts`.
 */

import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./capture/paths.js";
import { createCorpusFilesystem, type CorpusFilesystem } from "./corpus/fs.js";
import type { IndexDatabaseIO } from "./relevance/database.js";
import type { SensitivityNonceIO } from "./relevance/nonce.js";

export const nodeIndexDatabaseIo: IndexDatabaseIO = {
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  removeFile: (path) => rm(path, { force: true }),
};

export const nodeSensitivityNonceIo: SensitivityNonceIO = {
  readFile,
  writeFile,
  ensureOwnerOnlyFile,
};

export function createNodeCorpusFilesystem(): CorpusFilesystem {
  return createCorpusFilesystem({
    mkdir,
    readFile,
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return {
        writeFile: (data, encoding) => handle.writeFile(data, encoding),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    rename,
    unlink,
    lstat,
    constants: {
      O_CREAT: constants.O_CREAT,
      O_EXCL: constants.O_EXCL,
      O_RDWR: constants.O_RDWR,
      O_NOFOLLOW: constants.O_NOFOLLOW,
    },
  });
}
