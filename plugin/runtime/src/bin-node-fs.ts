// SPDX-License-Identifier: Apache-2.0
/**
 * Node filesystem adapters for the bin composition root only (C5-P3 / C6-P3).
 * Library modules must not import `node:fs*`; this file is imported solely from `bin.ts`.
 */

import { constants, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./capture/paths.js";
import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
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

/**
 * The runtime's optional configuration document, always at this name inside the
 * runtime home. It is the only way an operator declares a `corpus` block, which
 * is file-only authority: which archives may inject content into an agent's
 * context is a written, reviewable decision, never an ambient one (custody law
 * C2, and `CorpusConfigSchema` in `config.ts`).
 */
export const RUNTIME_CONFIG_FILE_NAME = "config.json";

type ConfigFileOutcome = { readonly value: unknown } | { readonly error: unknown };

/**
 * An ABSENT file resolves to `undefined`: a default install writes none, and
 * the schema defaults are then the whole configuration.
 *
 * Every other failure is an error rather than an empty document. A corpus block
 * that cannot be read would otherwise degrade into following no archives at all
 * while the operator who wrote it believes their sources are live — the
 * fail-open direction custody law C2 forbids.
 */
function readRuntimeConfigFile(path: string): ConfigFileOutcome {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: undefined };
    return {
      error: new PluginRuntimeError(
        RUNTIME_ERROR_CODES.configInvalid,
        `configuration file ${path} could not be read`,
        { cause: error },
      ),
    };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return {
      error: new PluginRuntimeError(
        RUNTIME_ERROR_CODES.configInvalid,
        `configuration file ${path} is not valid JSON`,
        { cause: error },
      ),
    };
  }
}

/**
 * Reads `<homeDirectory>/config.json` once and replays that outcome — value or
 * error — to every later call.
 *
 * The home here is the PRE-resolution one (`JINN_PLUGIN_HOME`, else the default
 * `~/.jinn-plugin`), never `RuntimeConfig.homeDirectory`. The document may
 * itself carry a `home` key, and honoring that for the document's own location
 * would mean having to read the file to learn where to read it from. So `home`
 * relocates the runtime's data tree, and the file stays where the environment
 * says the home is.
 *
 * Memoized because a process has two consumers — `main`'s `resolveRuntimeConfig`
 * and the corpus composition root's — and they must resolve over the SAME
 * document. Two independent reads could straddle an edit and leave the composed
 * corpus ports following one set of archives while the resolved configuration
 * named another, which is a split nothing in either process could report.
 *
 * The read is synchronous so the corpus composition root stays synchronous at
 * both process entry points; it happens once, before any loop starts.
 */
export function createNodeRuntimeConfigFileReader(homeDirectory: string): () => unknown {
  const path = join(homeDirectory, RUNTIME_CONFIG_FILE_NAME);
  let outcome: ConfigFileOutcome | undefined;
  return () => {
    outcome ??= readRuntimeConfigFile(path);
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  };
}
