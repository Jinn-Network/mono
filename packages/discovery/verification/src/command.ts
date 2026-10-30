// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { recordDigest } from "@jinn-network/trust-core";

import { inspectRecord } from "./check-record.js";
import { checkRecordSet, summarizeRecords } from "./check-record-set.js";
import type { RecordSetInputRecord } from "./check-record-set.js";
import type { DsseVerificationKey } from "./dsse.js";
import { KeysFileError, parseKeysFile } from "./keys-file.js";
import { loadPublishedDocuments } from "./published-documents.js";
import { renderReport, reportFailed } from "./render-report.js";
import type { CommandReport, UnreadFile } from "./render-report.js";
import { describeError, printable } from "./results.js";

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

const USAGE = `Usage: npx @jinn-network/verify <path> [--keys <file>] [--json]

  <path>         One record file, or a directory of records. Subdirectories are not read.
  --keys <file>  JSON with objects holding keyId and spkiDerBase64, to verify signatures against.
                 A verified signature shows that key signed, not whose key it is.
  --json         Print the structured report.
  --help         Print this.

Exits 0 when nothing failed, 1 when a record or a set check failed, 2 on usage or environment errors.
A file over ${MAX_FILE_BYTES} bytes is not read, and counts as a failure.
`;

/** The caller's input or environment is wrong. Nothing was checked. */
class EnvironmentError extends Error {}

/** A file named by digest, the way a record store keeps them, claims that digest. */
const DIGEST_NAME = /^([0-9a-f]{64})(?:\.[^.]+)?$/u;

interface TargetFile extends RecordSetInputRecord {
  readonly file: string;
}

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

function readKeys(path: string | undefined): readonly DsseVerificationKey[] | undefined {
  if (path === undefined) return undefined;
  let text: string;
  try {
    // A pipe never ends and a device may not, and a keys file can come with the records.
    const file = statSync(path);
    if (!file.isFile()) throw new Error("not a regular file");
    if (file.size > MAX_FILE_BYTES) throw new Error(`over the ${MAX_FILE_BYTES} byte limit`);
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new EnvironmentError(`cannot read the keys file ${path}: ${describeError(cause)}`);
  }
  try {
    return parseKeysFile(text);
  } catch (cause) {
    if (cause instanceof KeysFileError) throw new EnvironmentError(`${path}: ${cause.message}`);
    throw cause;
  }
}

async function check(target: string, keys: readonly DsseVerificationKey[] | undefined): Promise<CommandReport> {
  const { files, notRead, tooLarge, isSet } = readTarget(target);
  if (files.length === 0 && tooLarge.length === 0) throw new EnvironmentError(`${target} holds no files to check`);
  const trust = keys === undefined ? {} : { trust: { keys } };
  const common = { target, notRead, tooLarge, suppliedKeys: keys?.length ?? 0, files: files.map(({ file }) => file) };
  if (!isSet) {
    const inspected = files[0] === undefined ? [] : [await inspectRecord(files[0].bytes, {
      ...(files[0].digest === undefined ? {} : { digest: files[0].digest }),
      ...trust,
    })];
    const records = inspected.map(({ report }) => report);
    return { ...common, summary: summarizeRecords(records), records };
  }
  const report = await checkRecordSet({
    records: files,
    // A directory has no entry point of its own, so every record is one.
    roots: files.map(({ bytes }) => recordDigest(bytes)),
    published: loadPublishedDocuments(),
    ...trust,
  });
  return { ...common, summary: report.summary, records: report.records, checks: report.checks };
}

/** Runs the command and returns its exit code. It reads only what it is pointed at, and no network. */
export async function runCommand(argv: readonly string[], io: CommandIo): Promise<number> {
  let path: string;
  let keysPath: string | undefined;
  let json: boolean;
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { keys: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } },
    });
    if (values.help === true) {
      io.stdout(USAGE);
      return EXIT_NOTHING_FAILED;
    }
    if (positionals.length !== 1) throw new Error("name exactly one path");
    path = positionals[0]!;
    keysPath = values.keys;
    json = values.json === true;
  } catch (cause) {
    io.stderr(`${printable(describeError(cause))}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  try {
    const report = await check(path, readKeys(keysPath));
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
