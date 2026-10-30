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
import type { CommandReport } from "./render-report.js";
import { describeError } from "./results.js";

export interface CommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const EXIT_NOTHING_FAILED = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `Usage: npx @jinn-network/verify <path> [--keys <file>] [--json]

  <path>         One record file, or a directory of records.
  --keys <file>  JSON with objects holding keyId and spkiDerBase64, to verify signatures against.
                 A verified signature shows that key signed, not whose key it is.
  --json         Print the structured report.

Exits 0 when nothing failed, 1 when a record or a set check failed, 2 on usage or environment errors.
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

function readTarget(path: string): { readonly files: readonly TargetFile[]; readonly notRead: number; readonly isSet: boolean } {
  try {
    if (statSync(path).isFile()) return { files: [readTargetFile(path, basename(path))], notRead: 0, isSet: false };
    const entries = readdirSync(path, { withFileTypes: true });
    const names = entries.filter((entry) => entry.isFile()).map(({ name }) => name).sort();
    return {
      files: names.map((name) => readTargetFile(join(path, name), name)),
      notRead: entries.length - names.length,
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
  const { files, notRead, isSet } = readTarget(target);
  if (files.length === 0) throw new EnvironmentError(`${target} holds no files to check`);
  const trust = keys === undefined ? {} : { trust: { keys } };
  const common = { target, notRead, suppliedKeys: keys?.length ?? 0, files: files.map(({ file }) => file) };
  if (!isSet) {
    const { report } = await inspectRecord(files[0]!.bytes, {
      ...(files[0]!.digest === undefined ? {} : { digest: files[0]!.digest }),
      ...trust,
    });
    return { ...common, summary: summarizeRecords([report]), records: [report] };
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
      options: { keys: { type: "string" }, json: { type: "boolean" } },
    });
    if (positionals.length !== 1) throw new Error("name exactly one path");
    path = positionals[0]!;
    keysPath = values.keys;
    json = values.json === true;
  } catch (cause) {
    io.stderr(`${describeError(cause)}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  try {
    const report = await check(path, readKeys(keysPath));
    if (json) {
      const { records, files, ...rest } = report;
      const located = records.map((record, index) => ({ file: files[index]!, ...record }));
      io.stdout(`${JSON.stringify({ ...rest, records: located, checks: report.checks ?? [] })}\n`);
    } else {
      io.stdout(renderReport(report));
    }
    return reportFailed(report) ? EXIT_FAILED : EXIT_NOTHING_FAILED;
  } catch (cause) {
    if (!(cause instanceof EnvironmentError)) throw cause;
    io.stderr(`${cause.message}\n`);
    return EXIT_USAGE;
  }
}
