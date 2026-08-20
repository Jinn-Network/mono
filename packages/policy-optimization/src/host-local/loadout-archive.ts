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
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
} from "node:fs";
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
  /** Exact portable public bytes captured as the optimizer's declared baseline. */
  readonly bytes: Uint8Array;
  readonly archiveDigest: string;
  /** The learner-public.v1 tree identity used by the execution-policy tuple. */
  readonly treeDigest: string;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export interface LocalLoadoutCaptureHooks {
  /** Test-only race seam; production never supplies it. */
  readonly afterFileRead?: (path: string) => void;
}

function stableFileBytes(
  path: string,
  label: string,
  expected: Stats,
  hooks: LocalLoadoutCaptureHooks,
): Uint8Array {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameStat(expected, opened)) {
      refuse(label, "public loadout file moved while it was being captured");
    }
    const bytes = new Uint8Array(readFileSync(descriptor));
    hooks.afterFileRead?.(path);
    const afterRead = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (!sameStat(opened, afterRead) || !sameStat(opened, afterPath)) {
      refuse(label, "public loadout file moved while it was being captured");
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof PolicyOptimizationError) throw cause;
    return refuse(label, "public loadout file could not be read without following links");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Strictly validates exact portable public loadout bytes received from prepared private state. */
export function parseLocalLoadoutArchive(
  bytes: Uint8Array,
  root = "prepared-loadout",
): SealedLocalLoadoutArchive {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { refuse("loadout", "public loadout archive is not UTF-8 JSON"); }
  if (!plain(value)
    || Object.keys(value).sort(compareCodeUnitStrings).join("\0")
      !== ["entries", "formatToken", "hashProfile", "treeDigest"].sort(compareCodeUnitStrings).join("\0")
    || value["formatToken"] !== LOCAL_LOADOUT_ARCHIVE_FORMAT_TOKEN
    || value["hashProfile"] !== "learner-public.v1"
    || !Array.isArray(value["entries"])
    || typeof value["treeDigest"] !== "string") {
    refuse("loadout", "public loadout archive has missing, unknown, or unsupported fields");
  }
  if (!sameBytes(canonicalJsonBytes(value as unknown as JsonValue), bytes)) {
    refuse("loadout", "public loadout archive is not the exact canonical encoding");
  }
  const entries = value["entries"] as TreeEntry[];
  for (const [index, entry] of entries.entries()) {
    if (!plain(entry)
      || Object.keys(entry).sort(compareCodeUnitStrings).join("\0") !== "content\0kind\0path"
      || entry.kind !== "file" || typeof entry.path !== "string" || typeof entry.content !== "string") {
      refuse(`loadout.${index}`, "public loadout archive contains an invalid tree entry");
    }
    const segments = entry.path.split("/");
    if (entry.path === "" || entry.path.startsWith("/") || entry.path.includes("\\")
      || entry.path.includes("\0") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      refuse(`loadout.${index}`, "public loadout archive contains a non-portable path");
    }
    if (index > 0 && compareCodeUnitStrings(entries[index - 1]!.path, entry.path) >= 0) {
      refuse("loadout", "public loadout archive entries must be uniquely path-sorted");
    }
    if (SECRET_MATERIAL.some((pattern) => pattern.test(entry.content!))) {
      refuse(`loadout.${entry.path}`, "secret-bearing material is not allowed in a public loadout");
    }
  }
  try { assertMaterializable(entries); }
  catch { refuse("loadout", "public loadout archive contains non-materializable entries"); }
  let treeDigest: string;
  try { treeDigest = `sha256:${hashTreeLearnerPublicV1(entries)}`; }
  catch { refuse("loadout", "public loadout archive violates learner-public.v1"); }
  if (treeDigest !== value["treeDigest"]) {
    refuse("loadout", "public loadout archive tree digest does not match its exact entries");
  }
  return { root, entries, bytes, archiveDigest: prefixedDigest(bytes), treeDigest };
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
export function sealLocalLoadoutDirectory(
  path: string,
  hooks: LocalLoadoutCaptureHooks = {},
): SealedLocalLoadoutArchive {
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
    const directoryBefore = lstatSync(directory);
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      refuse("loadout", "loadout directory moved while it was being captured");
    }
    const names = readdirSync(directory).sort(compareCodeUnitStrings);
    for (const name of names) {
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
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          stableFileBytes(absolute, `loadout.${relativePath}`, stat, hooks),
        );
      }
      catch (cause) {
        if (cause instanceof PolicyOptimizationError) throw cause;
        refuse(`loadout.${relativePath}`, "public loadout files must be UTF-8 text");
      }
      if (SECRET_MATERIAL.some((pattern) => pattern.test(content))) {
        refuse(`loadout.${relativePath}`, "secret-bearing material is not allowed in a public loadout");
      }
      entries.push({ path: relativePath, kind: "file", content });
    }
    const directoryAfter = lstatSync(directory);
    const namesAfter = readdirSync(directory).sort(compareCodeUnitStrings);
    if (!sameStat(directoryBefore, directoryAfter)
      || names.join("\0") !== namesAfter.join("\0")) {
      refuse("loadout", "loadout directory moved while it was being captured");
    }
  };
  walk(root);
  entries.sort((left, right) => compareCodeUnitStrings(left.path, right.path));
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
