// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { createCorpusFilesystem, type CorpusFilesystem } from "./fs.js";

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

describe("node corpus filesystem helper", () => {
  test("exposes open flags from node:fs constants", () => {
    expect(createNodeCorpusFilesystem().constants.O_CREAT).toBe(constants.O_CREAT);
  });
});
