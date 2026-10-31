// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { compareCodeUnitStrings } from "@jinn-network/trust-core";

import type { RecordSetInputRecord } from "./check-record-set.js";
import { parseFileList } from "./file-list.js";
import type { FileListEntry } from "./file-list.js";
import type { RootProblem, RootProblemCode, UnreadFile } from "./render-report.js";
import { describeError, escapeUnprintable } from "./results.js";

/**
 * The most bytes the command will parse as a file list. The list of the public claim this was sized
 * against is 8,156,179 bytes for 46,016 files, so this holds about 370,000. It stops a list growing
 * without end and it does not keep memory small: a hostile list at this size took about 5 GiB to
 * parse, and a Node heap under about 3 GiB stops the command with no report. Files a list names have
 * no limit of their own.
 */
export const MAX_LIST_BYTES = 67_108_864;

const HASH_CHUNK_BYTES = 1_048_576;

export interface TargetFile extends RecordSetInputRecord {
  readonly file: string;
  /** What these exact bytes hashed to, when that is already known. `digest` is only a claim. */
  readonly hashed?: string;
}

interface HashedFile {
  readonly sha256: string;
  readonly size: number;
  readonly hardLinked: boolean;
  /** The bytes that were hashed, when they fit under the size asked for. */
  readonly bytes?: Uint8Array;
}

/** Opens without following a final link. Anything kept is the same read that was hashed. */
function readHashed(path: string, keepUpTo: number): HashedFile {
  // O_NONBLOCK and the type check are for a file swapped after the walk: a pipe would block this open.
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const file = fstatSync(descriptor);
    if (!file.isFile()) throw new Error("not a regular file");
    const hardLinked = file.nlink > 1;
    const hash = createHash("sha256");
    if (file.size <= keepUpTo) {
      const bytes = new Uint8Array(readFileSync(descriptor));
      return { sha256: hash.update(bytes).digest("hex"), size: bytes.length, hardLinked, bytes };
    }
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let size = 0;
    for (let read = readSync(descriptor, chunk); read > 0; read = readSync(descriptor, chunk)) {
      hash.update(chunk.subarray(0, read));
      size += read;
    }
    return { sha256: hash.digest("hex"), size, hardLinked };
  } finally {
    closeSync(descriptor);
  }
}

interface Tree {
  /** Regular files, relative to the root and separated by `/`. */
  readonly files: string[];
  /** Everything that is neither a file nor a directory, and why it was left alone. */
  readonly others: Map<string, string>;
}

/** Directory entries report what they are without following anything, so a link stays a link. */
function walk(directory: string, prefix: string, tree: Tree): Tree {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareCodeUnitStrings(left.name, right.name))) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) walk(join(directory, entry.name), `${path}/`, tree);
    else if (entry.isFile()) tree.files.push(path);
    else tree.others.set(path, entry.isSymbolicLink() ? "a symbolic link, not followed" : "a special file, not opened");
  }
  return tree;
}

interface FoundList {
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly hardLinked: boolean;
}

function findList(directory: string, names: readonly string[], sha256: string): FoundList | undefined {
  for (const file of names) {
    const hashed = readHashed(join(directory, file), MAX_LIST_BYTES);
    if (hashed.sha256 !== sha256) continue;
    if (hashed.bytes === undefined) throw new Error(`${file} is over the ${MAX_LIST_BYTES} byte limit for a list`);
    return { file, bytes: hashed.bytes, hardLinked: hashed.hardLinked };
  }
  return undefined;
}

export interface RootTarget {
  /** The top-level file that hashes to the root. */
  readonly list?: string;
  readonly entries: readonly FileListEntry[];
  /** Whether the listed files were read, which they are not when the list could not be used. */
  readonly checked: boolean;
  /** The listed files small enough to parse, each claiming the digest the list gives it. */
  readonly files: readonly TargetFile[];
  readonly notParsed: readonly UnreadFile[];
  readonly problems: readonly RootProblem[];
}

function problem(code: RootProblemCode, file: string, detail: string): RootProblem {
  return { code, file: escapeUnprintable(file), detail: escapeUnprintable(detail) };
}

function compare(path: string, entry: FileListEntry, parseUpTo: number): {
  readonly file?: TargetFile;
  readonly notParsed?: UnreadFile;
  readonly problems: readonly RootProblem[];
} {
  let read: HashedFile;
  try {
    read = readHashed(path, parseUpTo);
  } catch (cause) {
    return { problems: [problem("unreadable", entry.path, describeError(cause))] };
  }
  const problems = [
    ...(read.hardLinked ? [problem("hard-link", entry.path, "more than one name holds these bytes")] : []),
    ...(read.size !== entry.bytes
      ? [problem("changed", entry.path, `${read.size} bytes, and the list says ${entry.bytes}`)]
      : read.sha256 !== entry.sha256
        ? [problem("changed", entry.path, "does not hash to the digest in the list")]
        : []),
  ];
  return read.bytes === undefined
    ? { notParsed: { file: escapeUnprintable(entry.path), bytes: read.size }, problems }
    : { file: { file: entry.path, bytes: read.bytes, digest: `sha256:${entry.sha256}`, hashed: `sha256:${read.sha256}` }, problems };
}

/**
 * Finds the file at the top of `directory` that hashes to `sha256`, and compares the whole tree with
 * the list it holds. A mismatch is a problem to report. Anything thrown means the comparison could
 * not be made. The bytes returned for parsing are the bytes that were compared, from a single read.
 */
export function readRootTarget(directory: string, sha256: string, parseUpTo: number): RootTarget {
  const tree = walk(directory, "", { files: [], others: new Map() });
  const found = findList(directory, tree.files.filter((file) => !file.includes("/")), sha256);
  if (found === undefined) return { entries: [], checked: false, files: [], notParsed: [], problems: [] };

  const { entries, problems: formatProblems } = parseFileList(found.bytes, found.file);
  const listProblems = found.hardLinked
    ? [problem("hard-link", found.file, "more than one name holds these bytes")]
    : [];
  if (formatProblems.length > 0) {
    return {
      list: found.file,
      entries,
      checked: false,
      files: [],
      notParsed: [],
      problems: [...listProblems, ...formatProblems.map((detail) => problem("list-format", found.file, detail))],
    };
  }

  const regular = new Set<string>();
  const listed = new Set(entries.map(({ path }) => path));
  const files: TargetFile[] = [];
  const notParsed: UnreadFile[] = [];
  const problems: RootProblem[] = [...listProblems];
  for (const file of tree.files) {
    // Node decodes a name that is not UTF-8 lossily, so a second file could pass as the listed one.
    if (regular.has(file)) problems.push(problem("name-collision", file, "two names on disk read as this text"));
    regular.add(file);
  }
  for (const entry of entries) {
    if (tree.others.has(entry.path)) continue;
    if (!regular.has(entry.path)) {
      problems.push(problem("missing", entry.path, "listed, and not here"));
      continue;
    }
    const compared = compare(join(directory, ...entry.path.split("/")), entry, parseUpTo);
    if (compared.file !== undefined) files.push(compared.file);
    if (compared.notParsed !== undefined) notParsed.push(compared.notParsed);
    problems.push(...compared.problems);
  }
  for (const [file, detail] of tree.others) problems.push(problem("not-regular", file, detail));
  for (const file of tree.files) {
    if (!listed.has(file) && file !== found.file) problems.push(problem("not-listed", file, "not in the list"));
  }
  return { list: found.file, entries, checked: true, files, notParsed, problems };
}
