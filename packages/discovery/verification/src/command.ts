// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { recordDigest } from "@jinn-network/trust-core";

import { inspectRecord } from "./check-record.js";
import { checkRecordSet, summarizeRecords } from "./check-record-set.js";
import type { DsseVerificationKey } from "./dsse.js";
import { KeysFileError, parseKeysFile } from "./keys-file.js";
import { loadPublishedDocuments } from "./published-documents.js";
import { renderReport, reportFailed } from "./render-report.js";
import type { CommandReport, RootReport, UnreadFile } from "./render-report.js";
import { describeError, printable } from "./results.js";
import { MAX_LIST_BYTES, readRootTarget } from "./root-target.js";
import type { RootTarget, TargetFile } from "./root-target.js";

export interface CommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const EXIT_NOTHING_FAILED = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

/**
 * The most bytes the command reads from any one file. A file's worst case is quadratic in its size,
 * because each signature hashes the whole payload: about 3 s at this limit and 12 s at twice it. The
 * largest record in the public claim this was sized against is 436,248 bytes, and this is also the
 * one limit the specification states for a stored object, in the IPFS repository profile.
 */
export const MAX_FILE_BYTES = 2_097_152;

const JSON_FORMAT_VERSION = 1;

const USAGE = `Usage: npx @jinn-network/verify <path> [--root sha256:<hex>] [--keys <file>] [--json]

  <path>               One record file, or a directory of records. Subdirectories are not read.
  --root sha256:<hex>  The digest of a file list at the top of the directory <path>. Checks that the
                       directory holds exactly the files listed, subdirectories included, then
                       checks each of them. The digest has to come from somewhere you trust.
                       It pins what was published, not who published it.
  --keys <file>        JSON with objects holding keyId and spkiDerBase64, to verify signatures against.
                       A verified signature shows that key signed, not whose key it is.
  --json               Print the structured report.
  --help               Print this.

Exits 0 when nothing failed, 1 when a record, a set check or the root failed, 2 on usage or environment
errors, including a file that matches the root and cannot be read as a list.
A file over ${MAX_FILE_BYTES} bytes is not read, and counts as a failure. With --root it is still hashed
and compared, and it is not parsed.
`;

/** The caller's input or environment is wrong. Nothing was checked. */
class EnvironmentError extends Error {}

/** A file named by digest, the way a record store keeps them, claims that digest. */
const DIGEST_NAME = /^([0-9a-f]{64})(?:\.[^.]+)?$/u;

const ROOT = /^sha256:([0-9a-f]{64})$/u;

function readTargetFile(path: string, file: string): TargetFile {
  const hex = DIGEST_NAME.exec(file)?.[1];
  return { file, bytes: new Uint8Array(readFileSync(path)), ...(hex === undefined ? {} : { digest: `sha256:${hex}` }) };
}

interface Target {
  readonly files: readonly TargetFile[];
  readonly notRead: number;
  readonly tooLarge: readonly UnreadFile[];
  readonly isSet: boolean;
}

function readTarget(path: string): Target {
  try {
    const target = statSync(path);
    if (target.isFile()) {
      const file = basename(path);
      return target.size > MAX_FILE_BYTES
        ? { files: [], notRead: 0, tooLarge: [{ file, bytes: target.size }], isSet: false }
        : { files: [readTargetFile(path, file)], notRead: 0, tooLarge: [], isSet: false };
    }
    const entries = readdirSync(path, { withFileTypes: true });
    const names = entries.filter((entry) => entry.isFile()).map(({ name }) => name).sort();
    const sized = names.map((name) => ({ file: name, bytes: statSync(join(path, name)).size }));
    return {
      files: sized.filter(({ bytes }) => bytes <= MAX_FILE_BYTES).map(({ file }) => readTargetFile(join(path, file), file)),
      notRead: entries.length - names.length,
      tooLarge: sized.filter(({ bytes }) => bytes > MAX_FILE_BYTES),
      isSet: true,
    };
  } catch (cause) {
    throw new EnvironmentError(`cannot read ${path}: ${describeError(cause)}`);
  }
}

interface SuppliedKeys {
  readonly keys: readonly DsseVerificationKey[];
  /** Of the exact bytes the keys were read from, for telling whether a root covers them. */
  readonly sha256: string;
}

function readKeys(path: string | undefined): SuppliedKeys | undefined {
  if (path === undefined) return undefined;
  let bytes: Buffer;
  try {
    // A pipe never ends and a device may not, and a keys file can come with the records.
    const file = statSync(path);
    if (!file.isFile()) throw new Error("not a regular file");
    if (file.size > MAX_FILE_BYTES) throw new Error(`over the ${MAX_FILE_BYTES} byte limit`);
    bytes = readFileSync(path);
  } catch (cause) {
    throw new EnvironmentError(`cannot read the keys file ${path}: ${describeError(cause)}`);
  }
  try {
    return { keys: parseKeysFile(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (cause) {
    if (cause instanceof KeysFileError) throw new EnvironmentError(`${path}: ${cause.message}`);
    throw cause;
  }
}

function trustFrom(supplied: SuppliedKeys | undefined) {
  return supplied === undefined ? {} : { trust: { keys: supplied.keys } };
}

function checkSet(files: readonly TargetFile[], supplied: SuppliedKeys | undefined) {
  return checkRecordSet({
    records: files,
    // A directory has no entry point of its own, so every record is one.
    roots: files.map(({ bytes }) => recordDigest(bytes)),
    published: loadPublishedDocuments(),
    ...trustFrom(supplied),
  });
}

function readRoot(target: string, sha256: string): RootTarget {
  try {
    return readRootTarget(target, sha256, MAX_FILE_BYTES);
  } catch (cause) {
    throw new EnvironmentError(`cannot check ${target} against the root: ${describeError(cause)}`);
  }
}

function keysCoverage(read: RootTarget, supplied: SuppliedKeys): NonNullable<RootReport["keys"]> {
  const entry = read.entries.find(({ sha256 }) => sha256 === supplied.sha256);
  return entry === undefined ? { covered: false } : { covered: true, listedAs: printable(entry.path) };
}

async function checkRoot(target: string, sha256: string, supplied: SuppliedKeys | undefined): Promise<CommandReport> {
  const read = readRoot(target, sha256);
  const root: RootReport = {
    digest: `sha256:${sha256}`,
    ...(read.list === undefined ? {} : { list: printable(read.list) }),
    listed: read.entries.length,
    checked: read.checked,
    problems: read.problems,
    notParsed: read.notParsed,
    ...(supplied === undefined ? {} : { keys: keysCoverage(read, supplied) }),
  };
  const common = {
    target,
    notRead: 0,
    tooLarge: [],
    suppliedKeys: supplied?.keys.length ?? 0,
    files: read.files.map(({ file }) => file),
    root,
  };
  if (!read.checked) return { ...common, summary: summarizeRecords([]), records: [] };
  const report = await checkSet(read.files, supplied);
  return { ...common, summary: report.summary, records: report.records, checks: report.checks };
}

async function check(target: string, supplied: SuppliedKeys | undefined): Promise<CommandReport> {
  const { files, notRead, tooLarge, isSet } = readTarget(target);
  if (files.length === 0 && tooLarge.length === 0) throw new EnvironmentError(`${target} holds no files to check`);
  const common = { target, notRead, tooLarge, suppliedKeys: supplied?.keys.length ?? 0, files: files.map(({ file }) => file) };
  if (!isSet) {
    const inspected = files[0] === undefined ? [] : [await inspectRecord(files[0].bytes, {
      ...(files[0].digest === undefined ? {} : { digest: files[0].digest }),
      ...trustFrom(supplied),
    })];
    const records = inspected.map(({ report }) => report);
    return { ...common, summary: summarizeRecords(records), records };
  }
  const report = await checkSet(files, supplied);
  return { ...common, summary: report.summary, records: report.records, checks: report.checks };
}

/** Runs the command and returns its exit code. It reads only what it is pointed at, and no network. */
export async function runCommand(argv: readonly string[], io: CommandIo): Promise<number> {
  let path: string;
  let keysPath: string | undefined;
  let rootHex: string | undefined;
  let json: boolean;
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        root: { type: "string" },
        keys: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    if (values.help === true) {
      io.stdout(USAGE);
      return EXIT_NOTHING_FAILED;
    }
    if (positionals.length !== 1) throw new Error("name exactly one path");
    const root = values.root === undefined ? undefined : ROOT.exec(values.root);
    if (root === null) throw new Error("--root takes sha256: and 64 lowercase hex digits");
    path = positionals[0]!;
    keysPath = values.keys;
    rootHex = root?.[1];
    json = values.json === true;
  } catch (cause) {
    io.stderr(`${printable(describeError(cause))}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  try {
    const supplied = readKeys(keysPath);
    const report = await (rootHex === undefined ? check(path, supplied) : checkRoot(path, rootHex, supplied));
    if (json) {
      const { records, files, ...rest } = report;
      const located = records.map((record, index) => ({ file: files[index]!, ...record }));
      io.stdout(`${JSON.stringify({
        formatVersion: JSON_FORMAT_VERSION,
        failed: reportFailed(report),
        ...rest,
        records: located,
        checks: report.checks ?? [],
      })}\n`);
    } else {
      io.stdout(renderReport(report));
    }
    return reportFailed(report) ? EXIT_FAILED : EXIT_NOTHING_FAILED;
  } catch (cause) {
    if (!(cause instanceof EnvironmentError)) throw cause;
    io.stderr(`${printable(cause.message)}\n`);
    return EXIT_USAGE;
  }
}
