// SPDX-License-Identifier: MIT

import {
  LEARNER_PUBLIC_V1_ALLOWED_DIRS,
  LEARNER_PUBLIC_V1_ALLOWED_FILES,
  LEARNER_PUBLIC_V1_EXCLUDED_ROOTS,
  assertMaterializable,
  canonicalJsonBytes,
  compareCodeUnitStrings,
  hashTreeLearnerPublicV1,
  prefixedDigest,
  type JsonValue,
  type TreeEntry,
} from "@jinn-network/policy-identity";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { PolicyOptimizationError } from "../errors.js";

export const LOCAL_LOADOUT_ARCHIVE_FORMAT_TOKEN =
  "network.jinn.policy-optimization.local-loadout-archive/1.0" as const;

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const ALLOWED_DIRS = new Set<string>(LEARNER_PUBLIC_V1_ALLOWED_DIRS);
const ALLOWED_FILES = new Set<string>(LEARNER_PUBLIC_V1_ALLOWED_FILES);
const EXCLUDED_ROOTS = new Set<string>(LEARNER_PUBLIC_V1_EXCLUDED_ROOTS);
const SECRET_MATERIAL = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]/iu,
  /\bauthorization\b\s*[:=]\s*["']?bearer\s+/iu,
] as const;

export interface SealedLocalLoadoutArchive {
  readonly root: string;
  readonly entries: readonly TreeEntry[];
  /** Exact portable public bytes captured by NextRunPolicySnapshot. */
  readonly bytes: Uint8Array;
  readonly archiveDigest: string;
  /** The learner-public.v1 tree identity used by the execution-policy tuple. */
  readonly treeDigest: string;
}

function refuse(path: string, message: string): never {
  throw new PolicyOptimizationError("invalid-document", [{ path, code: "invalid-document", message }]);
}

function normalizedRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (value === "" || value === "." || value.startsWith("../") || value.includes("/../")) {
    refuse("loadout", "loadout path escapes its selected directory");
  }
  return value;
}

/**
 * Walks only learner-public.v1's classified public roots. Ignored private roots are never read,
 * and symlinks/special files are refused instead of followed.
 */
export function sealLocalLoadoutDirectory(path: string): SealedLocalLoadoutArchive {
  const root = resolve(path);
  let rootStat;
  try { rootStat = lstatSync(root); }
  catch { refuse("loadout", "selected loadout directory does not exist"); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    refuse("loadout", "selected loadout must be a real directory, not a link or special file");
  }

  const entries: TreeEntry[] = [];
  let totalBytes = 0;
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort(compareCodeUnitStrings)) {
      const absolute = join(directory, name);
      const relativePath = normalizedRelative(root, absolute);
      const top = relativePath.split("/", 1)[0]!;
      if (directory === root && EXCLUDED_ROOTS.has(top)) continue;
      if (directory === root && !ALLOWED_DIRS.has(top) && !ALLOWED_FILES.has(top)) {
        refuse(`loadout.${top}`, "unclassified top-level loadout entry");
      }
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) refuse(`loadout.${relativePath}`, "loadout symlinks are not allowed");
      if (stat.isDirectory()) {
        if (directory === root && !ALLOWED_DIRS.has(top)) {
          refuse(`loadout.${relativePath}`, "this learner-public.v1 entry must be a file");
        }
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) refuse(`loadout.${relativePath}`, "loadout special files are not allowed");
      if (directory === root && !ALLOWED_FILES.has(basename(absolute))) {
        refuse(`loadout.${relativePath}`, "this learner-public.v1 entry must be a directory");
      }
      if (stat.size > MAX_FILE_BYTES) refuse(`loadout.${relativePath}`, "public loadout file exceeds 4 MiB");
      totalBytes += stat.size;
      if (totalBytes > MAX_ARCHIVE_BYTES) refuse("loadout", "public loadout archive exceeds 32 MiB");
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute)); }
      catch { refuse(`loadout.${relativePath}`, "public loadout files must be UTF-8 text"); }
      if (SECRET_MATERIAL.some((pattern) => pattern.test(content))) {
        refuse(`loadout.${relativePath}`, "secret-bearing material is not allowed in a public loadout");
      }
      entries.push({ path: relativePath, kind: "file", content });
    }
  };
  walk(root);
  assertMaterializable(entries);
  const treeDigest = `sha256:${hashTreeLearnerPublicV1(entries)}`;
  const bytes = canonicalJsonBytes({
    formatToken: LOCAL_LOADOUT_ARCHIVE_FORMAT_TOKEN,
    entries,
    hashProfile: "learner-public.v1",
    treeDigest,
  } as unknown as JsonValue);
  return { root, entries, bytes, archiveDigest: prefixedDigest(bytes), treeDigest };
}
