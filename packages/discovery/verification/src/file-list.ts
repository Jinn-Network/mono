// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "@jinn-network/trust-core";

import { iJsonViolation } from "./i-json.js";
import { describeError } from "./results.js";

export interface FileListEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface FileList {
  readonly entries: readonly FileListEntry[];
  /** The entries that break the format, up to a bound. One is enough to refuse the whole list. */
  readonly problems: readonly string[];
}

/** These bytes are not a file list at all, so there is nothing to compare a directory with. */
export class FileListError extends Error {}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** One bad entry refuses a list, so stop here: a hostile list under its size limit holds millions. */
const MAX_LIST_PROBLEMS = 100;

function isRelativeAndNormalized(path: string): boolean {
  return !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function entryProblem(entry: unknown, listName: string): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "is not an object";
  const { path, bytes, sha256 } = entry as Record<string, unknown>;
  if (typeof path !== "string") return "path is not a string";
  if (!isRelativeAndNormalized(path)) return `path ${JSON.stringify(path)} is not relative and normalized`;
  if (path === listName) return "names the list itself";
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return `${path}: bytes is not a length`;
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) return `${path}: sha256 is not a SHA-256 in lowercase hex`;
  if (Object.keys(entry).length !== 3) return `${path} holds something other than path, bytes and sha256`;
  return undefined;
}

/**
 * Reads the bytes a root commits to as a list of files: `{ "files": [{ path, bytes, sha256 }] }`,
 * sorted by path in UTF-16 code-unit order. Other top-level members are not read. A path is only
 * ever compared with the names found on disk, and is never opened, so a list cannot aim a read.
 */
export function parseFileList(bytes: Uint8Array, listName: string): FileList {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new FileListError(`${listName} is not UTF-8 JSON: ${describeError(cause)}`);
  }
  const violation = iJsonViolation(text);
  if (violation !== undefined) throw new FileListError(`${listName} is not I-JSON: ${violation}`);
  const files = typeof parsed === "object" && parsed !== null ? (parsed as { readonly files?: unknown }).files : undefined;
  if (!Array.isArray(files) || files.length === 0) throw new FileListError(`${listName} has no files array with entries in it`);

  const entries: FileListEntry[] = [];
  const problems: string[] = [];
  let previous: string | undefined;
  for (const [index, entry] of files.entries()) {
    if (problems.length >= MAX_LIST_PROBLEMS) break;
    const problem = entryProblem(entry, listName);
    if (problem !== undefined) {
      problems.push(`entry ${index + 1}: ${problem}`);
      continue;
    }
    const valid = entry as FileListEntry;
    const order = previous === undefined ? 1 : compareCodeUnitStrings(valid.path, previous);
    if (order === 0) problems.push(`entry ${index + 1}: ${valid.path} is listed twice`);
    if (order < 0) problems.push(`entry ${index + 1}: ${valid.path} is out of order`);
    previous = valid.path;
    entries.push(valid);
  }
  return { entries, problems };
}
