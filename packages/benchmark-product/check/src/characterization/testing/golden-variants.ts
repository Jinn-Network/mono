// SPDX-License-Identifier: Apache-2.0

/**
 * Detached copies of the conformance kit's golden bundle, edited and re-sealed so that what the
 * checker refuses is the edit and not a stale manifest digest. The golden directory itself is never
 * written to. Temporary directories are swept by the suite's tmp isolation.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonBytes, parseDsseEnvelope } from "@jinn-network/trust-core";
import { BUNDLE_FORMAT, BUNDLE_V6_FORMAT, type LegacyBundleFormat } from "../../legacy-closures.js";
import { buildBundleManifest } from "../../manifest.js";
import { GOLDEN_BUNDLE_DIR } from "../../testing/golden-asset-input.js";
import { sealSigned, type DsseSignatures } from "./signers.js";

export type JsonObject = Record<string, any>;

export function copyGolden(): string {
  const bundleDir = join(mkdtempSync(join(tmpdir(), "checker-characterization-")), "bundle");
  cpSync(GOLDEN_BUNDLE_DIR, bundleDir, { recursive: true });
  return bundleDir;
}

export function readJson(bundleDir: string, path: string): JsonObject {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as JsonObject;
}

export function writeCanonical(bundleDir: string, path: string, value: unknown): void {
  writeFileSync(join(bundleDir, path), canonicalJsonBytes(value as never));
}

export function memberPaths(bundleDir: string): string[] {
  return (readJson(bundleDir, "bundle.json")["files"] as { path: string }[]).map(({ path }) => path);
}

export function reseal(
  bundleDir: string,
  format: LegacyBundleFormat = BUNDLE_FORMAT,
  paths: readonly string[] = memberPaths(bundleDir),
): void {
  writeFileSync(join(bundleDir, "bundle.json"), buildBundleManifest(bundleDir, paths, { format }).bytes);
}

/** The golden bundle with one member's JSON edited in place and the manifest re-sealed. */
export function goldenWith(path: string, edit: (document: JsonObject) => void): string {
  const bundleDir = copyGolden();
  const document = readJson(bundleDir, path);
  edit(document);
  writeCanonical(bundleDir, path, document);
  reseal(bundleDir);
  return bundleDir;
}

/** The golden Report envelope, its payload untouched, carrying these signatures instead. */
export function goldenWithReportSignatures(signatures: DsseSignatures): string {
  const bundleDir = copyGolden();
  const path = join(bundleDir, "report-envelope.json");
  const { payloadType, payloadBytes } = parseDsseEnvelope(new Uint8Array(readFileSync(path)));
  writeFileSync(path, sealSigned(payloadType, payloadBytes, signatures));
  reseal(bundleDir);
  return bundleDir;
}

/** A `/6` copy of the golden bundle carrying these anchor records. */
export function goldenAnchoredBy(
  ...records: readonly { readonly recordSha256: string; readonly bytes: Uint8Array }[]
): string {
  const bundleDir = copyGolden();
  mkdirSync(join(bundleDir, "anchors"));
  const paths = records.map(({ recordSha256, bytes }) => {
    const path = `anchors/${recordSha256}.bin`;
    writeFileSync(join(bundleDir, path), bytes);
    return path;
  });
  reseal(bundleDir, BUNDLE_V6_FORMAT, [...memberPaths(bundleDir), ...paths]);
  return bundleDir;
}
