// SPDX-License-Identifier: Apache-2.0
/**
 * Node filesystem adapters for the bin composition root only (C5-P3 / C6-P3).
 * Library modules must not import `node:fs*`; this file is imported solely from `bin.ts`.
 */

import { constants, readFileSync, statSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
// `os.platform()` rather than `process.platform`: identical value, and the
// plugin tree's custody guard reserves `process.*` for the bin entry point and
// the capture tree. This module is neither.
import { platform } from "node:os";
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
const RUNTIME_CONFIG_FILE_NAME = "config.json";

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
function invalidConfigFile(path: string, detail: string, cause?: unknown): ConfigFileOutcome {
  return {
    error: new PluginRuntimeError(
      RUNTIME_ERROR_CODES.configInvalid,
      `configuration file ${path} ${detail}`,
      cause === undefined ? {} : { cause },
    ),
  };
}

function readRuntimeConfigFile(path: string): ConfigFileOutcome {
  let text: string;
  try {
    // This document is AUTHORITY, not preference: the followed-source list,
    // the per-agent signing keys, the trust policy directory, and the
    // chain-verification posture are all declared here and nowhere else
    // (custody law C2). A group- or world-writable one lets any local user add
    // a source plus a `did:key` and become a trusted publisher of everything
    // this install injects into an agent's context. Every other file in this
    // tree is held owner-only by `ensureOwnerOnlyFile` /
    // `ensureOwnerOnlyDirectory`; a document with more authority than any of
    // them gets the same doctrine, refused rather than tightened because a
    // permission this process did not choose is a decision its owner has to
    // make. Skipped on Windows, where the POSIX mode bits carry no such
    // meaning — exactly where `capture/paths.ts` skips its own chmod.
    if (platform() !== "win32") {
      const mode = statSync(path).mode;
      if ((mode & 0o077) !== 0) {
        return invalidConfigFile(
          path,
          `is accessible to users other than its owner (mode ${(mode & 0o777).toString(8).padStart(3, "0")}); ` +
            "run `chmod 600` on it",
        );
      }
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: undefined };
    return invalidConfigFile(path, "could not be read", error);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return invalidConfigFile(path, "is not valid JSON", error);
  }

  // `null` is valid JSON and the one malformation that used to read as an
  // absent document — following zero archives while the operator who wrote the
  // file believes their sources are live, which is precisely the fail-open
  // direction the paragraph above forbids. ABSENCE of the file is the only
  // legitimate no-document answer.
  if (value === null) {
    return invalidConfigFile(path, "contains `null` rather than a configuration document");
  }
  return { value };
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
