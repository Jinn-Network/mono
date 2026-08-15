import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "../errors.js";
import { BUNDLE_V3_FORMAT, verifyBundleSnapshot, type VerifyBundleSnapshotDeps } from "./manifest.js";
import {
  assertBundleV3Input,
  bundleV3SourcePositions,
  type BundleV3NativeArtifactInput,
  type MaterializeBundleV3Input,
} from "./v3-materialize.js";
import { BundleV3IndexSchema, type BundleV3Index } from "./v3-schema.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function parseIndex(bytes: Uint8Array): BundleV3Index {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("record-integrity", "bundle-v3.json", "v3 index is not valid UTF-8 JSON");
  }
  const index = BundleV3IndexSchema.safeParse(raw);
  if (!index.success) refuse("record-integrity", "bundle-v3.json", "v3 index does not satisfy its schema");
  if (!equalBytes(bytes, canonicalJsonBytes(index.data))) {
    refuse("record-integrity", "bundle-v3.json", "v3 index is not the exact canonical encoding");
  }
  return index.data;
}

export interface VerifyBundleV3Deps extends VerifyBundleSnapshotDeps {
  /**
   * Bytes read from independently announced records. They are compared, never normalized;
   * this catches a product projection that labels substituted bytes with an announced digest.
   */
  readonly announced?: {
    readonly accountingBytes?: Uint8Array;
    readonly matrixBytes?: Uint8Array;
    readonly reportEnvelopeBytes?: Uint8Array;
  };
}

export interface BundleV3VerificationResult {
  readonly identity: string;
  readonly accountingSha256: string;
  readonly matrixSha256: string;
  readonly reportRecordSha256?: string;
  readonly checks: readonly ["manifest", "closure", "source-positions", "native-disclosures", "report"];
}

/** Verify a v3 projection from one authenticated byte snapshot. It opens no workspace paths. */
export function verifyBundleV3(bundleDir: string, deps: VerifyBundleV3Deps = {}): BundleV3VerificationResult {
  const snapshot = verifyBundleSnapshot(bundleDir, deps);
  if (snapshot.manifest.format !== BUNDLE_V3_FORMAT) {
    refuse("record-integrity", "bundle.json", "bundle manifest is not a v3 bundle");
  }
  const read = (path: string): Uint8Array => {
    const bytes = snapshot.fileBytes.get(path);
    if (bytes === undefined) refuse("record-integrity", path, "v3 closure is missing an authenticated file");
    return bytes;
  };
  const index = parseIndex(read("bundle-v3.json"));
  const accountingBytes = read(index.accounting.path);
  const matrixBytes = read(index.matrix.path);
  if (sha256(accountingBytes) !== index.accounting.sha256 || sha256(matrixBytes) !== index.matrix.sha256) {
    refuse("record-integrity", "bundle-v3.json", "v3 core record digest differs from exact bundled bytes");
  }
  const nativeArtifacts: BundleV3NativeArtifactInput[] = index.nativeArtifacts.map((disclosure) => ({
    disclosure,
    ...((disclosure.state === "public" || disclosure.state === "scrub-derived") ? { bytes: read(disclosure.path) } : {}),
  }));
  const materializeInput: MaterializeBundleV3Input = {
    bundleDir: "unused-by-verifier",
    accountingBytes,
    matrixBytes,
    ...(index.report === undefined ? {} : { report: {
      payloadBytes: read(index.report.payload.path),
      envelopeBytes: read(index.report.envelope.path),
    } }),
    nativeArtifacts,
  };
  assertBundleV3Input(materializeInput);
  if (index.report !== undefined) {
    if (sha256(materializeInput.report!.payloadBytes) !== index.report.payload.sha256
      || sha256(materializeInput.report!.envelopeBytes) !== index.report.envelope.sha256) {
      refuse("record-integrity", "bundle-v3.json", "Report v2 identities differ from exact bundled bytes");
    }
  }
  const expectedReceipts = bundleV3SourcePositions(accountingBytes).map((position) => {
    const positionBytes = canonicalJsonBytes(position);
    const digest = sha256(positionBytes);
    return { position, sha256: digest, path: `sources/${digest}.json` };
  });
  if (expectedReceipts.length !== index.sourceReceipts.length) {
    refuse("record-integrity", "sourceReceipts", "source receipt closure differs from BenchmarkAccounting positions");
  }
  expectedReceipts.forEach((expected, indexAt) => {
    const declared = index.sourceReceipts[indexAt];
    const positionBytes = canonicalJsonBytes(expected.position);
    if (
      declared === undefined
      || !equalBytes(canonicalJsonBytes(declared), canonicalJsonBytes(expected))
      || !equalBytes(read(expected.path), positionBytes)
    ) {
      refuse("record-integrity", "sourceReceipts", "source receipt bytes or position differ from BenchmarkAccounting");
    }
  });
  const allowed = new Set<string>([
    "bundle-v3.json",
    index.accounting.path,
    index.matrix.path,
    ...index.sourceReceipts.map((value) => value.path),
    ...index.nativeArtifacts.flatMap((value) => value.state === "public" || value.state === "scrub-derived" ? [value.path] : []),
    ...(index.report === undefined ? [] : [index.report.payload.path, index.report.envelope.path]),
  ]);
  for (const path of snapshot.manifest.files.map((file) => file.path)) {
    if (!allowed.has(path) && !path.startsWith("human/")) {
      refuse("record-integrity", path, "v3 bundle contains a file outside its closed projection");
    }
  }
  const announced = deps.announced;
  if (announced?.accountingBytes !== undefined && !equalBytes(announced.accountingBytes, accountingBytes)) {
    refuse("record-integrity", "announced.accounting", "bundled BenchmarkAccounting bytes differ from announced bytes");
  }
  if (announced?.matrixBytes !== undefined && !equalBytes(announced.matrixBytes, matrixBytes)) {
    refuse("record-integrity", "announced.matrix", "bundled Matrix bytes differ from announced bytes");
  }
  if (announced?.reportEnvelopeBytes !== undefined) {
    if (index.report === undefined || !equalBytes(announced.reportEnvelopeBytes, materializeInput.report!.envelopeBytes)) {
      refuse("record-integrity", "announced.report", "bundled Report envelope bytes differ from announced bytes");
    }
  }
  return {
    identity: snapshot.identity,
    accountingSha256: index.accounting.sha256,
    matrixSha256: index.matrix.sha256,
    ...(index.report === undefined ? {} : { reportRecordSha256: index.report.envelope.sha256 }),
    checks: ["manifest", "closure", "source-positions", "native-disclosures", "report"],
  };
}
