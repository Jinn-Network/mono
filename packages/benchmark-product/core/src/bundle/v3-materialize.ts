import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  parseBenchmarkAccounting,
  parseMatrix,
  parseReport,
  parseSignedReportRecord,
  readMatrixPublicationExtension,
  BENCHMARK_PUBLICATION_EXTENSION,
  checkPublicRegistrationOrder,
} from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "../errors.js";
import { atomicWriteFileSync, fsyncDirectorySync } from "../fs/atomic.js";
import { buildBundleManifest, BUNDLE_MANIFEST_FILENAME, BUNDLE_V3_FORMAT } from "./manifest.js";
import { BundleV3IndexSchema, type BundleV3NativeDisclosure } from "./v3-schema.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function nativeKey(value: Pick<BundleV3NativeDisclosure, "cellKey" | "dispatch" | "ordinal">): string {
  return `${value.cellKey}\u001f${value.dispatch}\u001f${value.ordinal}`;
}

export interface BundleV3NativeArtifactInput {
  readonly disclosure: BundleV3NativeDisclosure;
  /** Required exactly for public and scrub-derived artifacts. */
  readonly bytes?: Uint8Array;
}

export interface MaterializeBundleV3Input {
  /** A new, empty target directory. It becomes the immutable portable bundle. */
  readonly bundleDir: string;
  readonly accountingBytes: Uint8Array;
  readonly matrixBytes: Uint8Array;
  /** Optional by design: accounting-only bundles are valid public products. */
  readonly report?: { readonly payloadBytes: Uint8Array; readonly envelopeBytes: Uint8Array };
  readonly nativeArtifacts?: readonly BundleV3NativeArtifactInput[];
  /** Product presentation is deliberately non-canonical, but manifest authenticated. */
  readonly humanFiles?: Readonly<Record<string, Uint8Array>>;
}

export interface MaterializedBundleV3 {
  readonly bundleDir: string;
  readonly identity: string;
  readonly accountingSha256: string;
  readonly matrixSha256: string;
  readonly reportRecordSha256?: string;
}

function assertNativeInput(input: MaterializeBundleV3Input): void {
  const accounting = parseBenchmarkAccounting(input.accountingBytes);
  const expected = new Map<string, { role: string; availability: string; artifact?: { digest: { sha256: string } } }>();
  for (const cell of accounting.cells) for (const dispatch of cell.dispatches) {
    dispatch.nativeArtifacts.forEach((artifact, index) => {
      expected.set(nativeKey({ cellKey: cell.cellKey, dispatch: dispatch.index, ordinal: index + 1 }), artifact);
    });
  }
  const actual = new Map<string, BundleV3NativeArtifactInput>();
  for (const value of input.nativeArtifacts ?? []) {
    const parsed = BundleV3IndexSchema.shape.nativeArtifacts.element.parse(value.disclosure);
    const key = nativeKey(parsed);
    if (actual.has(key)) refuse("record-integrity", "nativeArtifacts", `duplicate native disclosure ${key}`);
    actual.set(key, value);
    const byteBearing = parsed.state === "public" || parsed.state === "scrub-derived";
    if (byteBearing) {
      if (value.bytes === undefined || sha256(value.bytes) !== parsed.artifact.sha256) {
        refuse("record-integrity", `nativeArtifacts.${key}`, "public native artifact bytes do not match their declared digest");
      }
      if (parsed.path !== `native/${parsed.artifact.sha256}.bin`) {
        refuse("record-integrity", `nativeArtifacts.${key}`, "native artifact path must be derived from its exact digest");
      }
    } else if (value.bytes !== undefined) {
      refuse("record-integrity", `nativeArtifacts.${key}`, "non-public native artifact disclosure must not carry bytes");
    }
  }
  if (actual.size !== expected.size) refuse("record-integrity", "nativeArtifacts", "bundle native disclosures do not close over BenchmarkAccounting");
  for (const [key, accountingArtifact] of expected) {
    const projected = actual.get(key);
    if (projected === undefined) refuse("record-integrity", `nativeArtifacts.${key}`, "BenchmarkAccounting native artifact has no bundle disclosure");
    const disclosure = projected.disclosure;
    if (disclosure.role !== accountingArtifact.role) refuse("record-integrity", `nativeArtifacts.${key}`, "native disclosure role differs from BenchmarkAccounting");
    if (disclosure.state !== "scrub-derived") {
      if (disclosure.state !== accountingArtifact.availability) {
        refuse("record-integrity", `nativeArtifacts.${key}`, "native disclosure state differs from BenchmarkAccounting");
      }
      const original = accountingArtifact.artifact?.digest.sha256;
      if (original !== undefined && "artifact" in disclosure && disclosure.artifact !== undefined && disclosure.artifact.sha256 !== original) {
        refuse("record-integrity", `nativeArtifacts.${key}`, "native disclosure digest differs from BenchmarkAccounting");
      }
    } else {
      const original = accountingArtifact.artifact?.digest.sha256;
      if (original !== undefined && disclosure.source?.sha256 !== original) {
        refuse("record-integrity", `nativeArtifacts.${key}`, "scrub derivation must name the BenchmarkAccounting source artifact");
      }
      if (original === undefined && disclosure.source !== undefined) {
        refuse("record-integrity", `nativeArtifacts.${key}`, "scrub derivation cannot invent a source identity absent from BenchmarkAccounting");
      }
      if (original !== undefined && disclosure.artifact.sha256 === original) {
        refuse("record-integrity", `nativeArtifacts.${key}`, "scrub-derived artifact must have a new digest");
      }
    }
  }
}

/** Shared strict semantic boundary for both materialization and portable verification. */
export function assertBundleV3Input(input: MaterializeBundleV3Input): void {
  const accounting = parseBenchmarkAccounting(input.accountingBytes);
  const matrix = parseMatrix(input.matrixBytes);
  const accountingSha256 = sha256(input.accountingBytes);
  const extension = readMatrixPublicationExtension(matrix);
  if (extension?.accounting.digest.sha256 !== accountingSha256) {
    refuse("record-integrity", "matrix", "Matrix v2 does not bind the exact BenchmarkAccounting bytes");
  }
  if (matrix.run.digest.sha256 !== accounting.run.digest.sha256) {
    refuse("record-integrity", "matrix", "Matrix and BenchmarkAccounting refer to different Run identities");
  }
  const matrixCells = new Map(matrix.cells.map((cell) => [cell.cellKey, cell]));
  if (matrixCells.size !== accounting.cells.length) {
    refuse("record-integrity", "matrix", "Matrix and BenchmarkAccounting have different cell closures");
  }
  for (const cell of accounting.cells) {
    const matrixCell = matrixCells.get(cell.cellKey);
    if (matrixCell === undefined || matrixCell.dispatches !== cell.dispatches.length || matrixCell.accounted !== cell.dispatches.length) {
      refuse("record-integrity", "matrix", `Matrix accounting differs for ${cell.cellKey}`);
    }
  }
  if (input.report !== undefined) {
    const signed = parseSignedReportRecord(input.report.envelopeBytes);
    const report = parseReport(input.report.payloadBytes);
    if (!equalBytes(signed.payloadBytes, input.report.payloadBytes)) {
      refuse("record-integrity", "report", "Report envelope payload is not the exact bundled Report payload bytes");
    }
    if (!signed.payload.subjects.some((subject) => subject.digest.sha256 === sha256(input.matrixBytes))) {
      refuse("record-integrity", "report", "Report does not close over the bundled Matrix identity");
    }
    // Report v2's publication disclosure is a canonical, exact derivation over the same Matrix
    // subject and Accounting bytes; accepting merely a matching subject would permit a forged
    // public-registration assertion.
    const matrixDigest = sha256(input.matrixBytes);
    if (report.subjects.length !== 1 || report.subjects[0]?.digest.sha256 !== matrixDigest) {
      refuse("record-integrity", "report", "Report v2 must have the bundled Matrix as its one exact subject");
    }
    const expectedDisclosure = {
      publicRegistration: {
        perSubject: [{
          subjectSha256: matrixDigest,
          status: accounting.publicRegistration.status,
          accounting: extension?.accounting,
          check: checkPublicRegistrationOrder(accounting),
        }],
      },
    };
    if (!equalBytes(canonicalJsonBytes((report as Record<string, unknown>)[BENCHMARK_PUBLICATION_EXTENSION]), canonicalJsonBytes(expectedDisclosure))) {
      refuse("record-integrity", "report", "Report v2 public-registration disclosure is not derived from bundled Matrix and BenchmarkAccounting");
    }
  }
  assertNativeInput(input);
}

export function bundleV3SourcePositions(accountingBytes: Uint8Array): readonly unknown[] {
  const accounting = parseBenchmarkAccounting(accountingBytes);
  const positions: unknown[] = [];
  for (const stream of accounting.scope.streams) {
    if (stream.kind === "record-discovery") positions.push({ kind: "scope", role: stream.role, source: stream.source, position: stream.through });
  }
  if (accounting.publicRegistration.status === "pre-dispatch") {
    const boundaries = [
      ["runBoundary", accounting.publicRegistration.runBoundary],
      ["firstDispatchBoundary", accounting.publicRegistration.firstDispatchBoundary],
    ] as const;
    for (const [name, boundary] of boundaries) {
      if (boundary.kind === "record-discovery") positions.push({ kind: name, source: boundary.source, position: boundary.position });
    }
  } else if (accounting.publicRegistration.status === "unverifiable") {
    const boundaries = [
      ["runBoundary", accounting.publicRegistration.runBoundary],
      ["firstDispatchBoundary", accounting.publicRegistration.firstDispatchBoundary],
    ] as const;
    for (const [name, boundary] of boundaries) {
      if (boundary?.kind === "record-discovery") positions.push({ kind: name, source: boundary.source, position: boundary.position });
    }
  }
  return positions;
}

/** Materializes an additive v3 bundle. It deliberately has no workspace/operation dependency. */
export function materializeBundleV3(input: MaterializeBundleV3Input): MaterializedBundleV3 {
  if (existsSync(input.bundleDir)) refuse("conflict", "bundleDir", "v3 bundle target already exists");
  assertBundleV3Input(input);
  const staging = `${input.bundleDir}.tmp-${randomUUID()}`;
  mkdirSync(staging, { recursive: true });
  const files: string[] = [];
  const write = (path: string, bytes: Uint8Array): void => {
    atomicWriteFileSync(join(staging, path), bytes);
    files.push(path);
  };
  write("records/accounting.json", input.accountingBytes);
  write("records/matrix.json", input.matrixBytes);
  if (input.report !== undefined) {
    write("records/report-payload.json", input.report.payloadBytes);
    write("records/report-envelope.json", input.report.envelopeBytes);
  }
  const nativeArtifacts = (input.nativeArtifacts ?? []).map(({ disclosure, bytes }) => {
    if (bytes !== undefined) {
      if (disclosure.state !== "public" && disclosure.state !== "scrub-derived") {
        refuse("record-integrity", "nativeArtifacts", "non-public disclosure cannot materialize bytes");
      }
      write(disclosure.path, bytes);
    }
    return disclosure;
  });
  for (const [path, bytes] of Object.entries(input.humanFiles ?? {})) {
    if (!path.startsWith("human/") || path.includes("..")) refuse("validation", "humanFiles", "human files must remain under human/");
    write(path, bytes);
  }
  const sourceReceipts = bundleV3SourcePositions(input.accountingBytes).map((position) => {
    const bytes = canonicalJsonBytes(position);
    const digest = sha256(bytes);
    const path = `sources/${digest}.json`;
    write(path, bytes);
    return { position, sha256: digest, path };
  });
  const index = BundleV3IndexSchema.parse({
    format: "benchmark-product-public-bundle-index/3",
    accounting: { sha256: sha256(input.accountingBytes), path: "records/accounting.json" },
    matrix: { sha256: sha256(input.matrixBytes), path: "records/matrix.json" },
    ...(input.report === undefined ? {} : { report: {
      payload: { sha256: sha256(input.report.payloadBytes), path: "records/report-payload.json" },
      envelope: { sha256: sha256(input.report.envelopeBytes), path: "records/report-envelope.json" },
    } }),
    sourceReceipts,
    nativeArtifacts,
  });
  write("bundle-v3.json", canonicalJsonBytes(index));
  const manifest = buildBundleManifest(staging, files, { format: BUNDLE_V3_FORMAT });
  atomicWriteFileSync(join(staging, BUNDLE_MANIFEST_FILENAME), manifest.bytes);
  renameSync(staging, input.bundleDir);
  fsyncDirectorySync(join(input.bundleDir, ".."));
  return {
    bundleDir: input.bundleDir,
    identity: manifest.identity,
    accountingSha256: index.accounting.sha256,
    matrixSha256: index.matrix.sha256,
    ...(index.report === undefined ? {} : { reportRecordSha256: index.report.envelope.sha256 }),
  };
}
