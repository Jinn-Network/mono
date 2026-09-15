// SPDX-License-Identifier: Apache-2.0

/**
 * The composed presentation generation, round-tripped through the portable reader (issue #4191).
 *
 * `v10-closure.test.ts` in the reader package states `/10`'s allocation against the constants;
 * this is the other half, and the half no constant can supply: a real anchored bundle, relabelled
 * `/10` and re-rendered at `/10`, verifies — with v6's closure, v6's seven checks, and v6's
 * mandatory members — under the same `verifyPublicBundle` a third party runs.
 *
 * That matters because the two places `/10` reaches the verification path are wiring, not data:
 * the closure selection (`verify.ts`, which must resolve `/10` to v6's row) and the claim rebuild's
 * `anchoredBundleFormat` (which must be read from the manifest so a `/10` bundle is required to
 * carry `/10`'s reader pin, and a `/6` bundle `/6`'s). Neither is exercised by a test that only
 * reads constants, and a drift in either would be silent.
 *
 * No producer emits `/10` — its claim seals a reader that predates the format and refuses it at
 * manifest parse — so the bundle here is BUILT as `/6` and converted. That conversion is exactly
 * what a producer flipping to `/10` would do, and doing it in the test rather than in the producer
 * is what keeps `/10` unemittable while still proving it readable.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseMatrix, parseReport } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import {
  BUNDLE_V10_FORMAT,
  PUBLIC_BUNDLE_V10_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V10_VERIFICATION_COMMAND,
  verifyPublicBundle,
  verifyPublicBundleSnapshot,
} from "@colophon-claims/verify";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { buildBundleManifest } from "./manifest.js";
import { BUNDLE_V6_FORMAT } from "../legacy-closures.js";
import { createSyntheticV6BundleFixture } from "./testing/v6-synthetic-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A detached copy, so the conversion below runs against bytes with no workspace behind them. */
function detach(bundleDir: string): string {
  const root = mkdtempSync(join(tmpdir(), "composed-v10-detached-"));
  roots.push(root);
  const copy = join(root, "bundle");
  cpSync(bundleDir, copy, { recursive: true });
  return copy;
}

function json(bundleDir: string, path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as Record<string, any>;
}

/**
 * Converts a materialized `/6` bundle in place into the `/10` bundle the same facts produce.
 *
 * Three edits, in the order a producer would make them: repin the claim's reader line, re-render
 * every presentation asset at `/10`, then relabel the manifest over the members the directory now
 * holds. Nothing about the records moves — that is the whole claim `/10` makes — so the sealed
 * Run, Matrix, Report, evidence catalog, and anchors are untouched.
 *
 * Every input to the re-render is read from the bundle's own bytes rather than carried over from
 * the fixture's build, so a conversion that drifted from what the verifier assembles would fail
 * the verifier's own byte-compare rather than passing against a private copy of the facts.
 */
function convertToComposedPresentation(
  bundleDir: string,
  comparison: PublicAssetInput["comparison"],
  options: { readonly repinReader?: boolean } = {},
): void {
  const claim = json(bundleDir, "claim-package.json");
  if (options.repinReader !== false) {
    claim["verification"] = {
      ...claim["verification"],
      command: PUBLIC_BUNDLE_V10_VERIFICATION_COMMAND,
      compatibleCommand: PUBLIC_BUNDLE_V10_COMPATIBLE_VERIFICATION_COMMAND,
    };
    // Canonical JSON, because the verifier re-encodes the parsed claim and refuses any byte that
    // differs -- a pretty-printed rewrite is rejected before claim-consistency is ever reached.
    writeFileSync(join(bundleDir, "claim-package.json"), canonicalJsonBytes(claim));
  }

  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(bundleDir, name)));
  const manifest = json(bundleDir, "bundle.json") as { files: { path: string }[] };
  const assets = buildPublicAssets({
    format: BUNDLE_V10_FORMAT,
    claim: claim as unknown as PublicAssetInput["claim"],
    matrix: parseMatrix(read("matrix.json")),
    report: parseReport(read("report.json")),
    reportSha256: claim["records"].reportSha256,
    matrixSha256: claim["records"].matrixSha256,
    recordSha256s: manifest.files.flatMap((file) => {
      const match = /^records\/([a-f0-9]{64})\.bin$/u.exec(file.path);
      return match === null ? [] : [match[1]!];
    }),
    // Derived by the verifier's own rule -- a cell dissents when its verdicts disagree -- because
    // that is the projection the byte-compare below is against. The claim's `conflicted.cellKeys`
    // is a different fact and would render a different page.
    dissentCellKeys: readFileSync(join(bundleDir, "verification/assembly.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => (JSON.parse(line) as { cells?: { cellKey: string; verdicts: { verdict: string }[] }[] }).cells ?? [])
      .filter((cell) => new Set(cell.verdicts.map((verdict) => verdict.verdict)).size > 1)
      .map((cell) => cell.cellKey)
      .sort(),
    ...(comparison === undefined ? {} : { comparison }),
  });
  for (const [path, bytes] of Object.entries(assets)) writeFileSync(join(bundleDir, path), bytes);

  writeFileSync(
    join(bundleDir, "bundle.json"),
    buildBundleManifest(bundleDir, manifest.files.map((file) => file.path), { format: BUNDLE_V10_FORMAT }).bytes,
  );
}

describe("composed presentation bundle v10 — portable verification", () => {
  test("a relabelled, re-rendered anchored bundle verifies with v6's closure", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "composed-v10-"));
    roots.push(workspaceDir);
    const built = await createSyntheticV6BundleFixture({ workspaceDir, plans: [{ kind: "rfc3161-lock" }] });
    const bundleDir = detach(built.bundle.bundleDir);

    // The `/6` bundle first, both as the control and as the source of the comparison projection.
    // The projection is taken from the SNAPSHOT rather than re-derived here: it is what the
    // verifier byte-compares the page against, so deriving it anywhere else would re-render a
    // page nobody verifies.
    const asSix = await verifyPublicBundleSnapshot(bundleDir);
    expect(asSix.verification.format).toBe(BUNDLE_V6_FORMAT);

    convertToComposedPresentation(bundleDir, asSix.comparison);
    // The originating workspace is gone before a single byte is verified.
    rmSync(built.workspaceDir, { recursive: true, force: true });

    const verified = await verifyPublicBundle(bundleDir);
    expect(verified.format).toBe(BUNDLE_V10_FORMAT);
    // v6's seven, in v6's order. The presentation generation adds none: a check it grew would be
    // claiming the render proves something the records did not already prove.
    expect(verified.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
      "integrity-anchors",
    ]);
    // `integrity-anchors` is in that list because `/10` resolves to v6's `carriesAnchors`. Stated
    // separately so a closure that silently lost the anchor axis fails on the axis, not just on a
    // check name.
    if (verified.format === "benchmark-product-public-bundle/5") throw new Error("unreachable");
    expect(verified.anchors?.anchors).toHaveLength(1);
    // The four rulings are on the page the verifier just byte-compared against its own rebuild.
    const page = readFileSync(join(bundleDir, "index.html"), "utf8");
    expect(page).not.toContain("Open a cell to inspect its evidence");
    expect(page.split('<p class="about">').length - 1).toBe(1);
    expect(page.split("values below are copied without reconciliation").length - 1).toBe(1);
  }, 180_000);

  test("a /10 bundle carrying /6's reader pin is refused on the field that disagrees", async () => {
    // The binding that makes the pin honest: the claim rebuild reads the format from the MANIFEST,
    // never from the claim under test, so the claim cannot satisfy itself. Both reader pairs are
    // legal `claim-package/4` — the admission schema accepts either — so if this binding were
    // absent the mismatch would pass every check.
    const workspaceDir = mkdtempSync(join(tmpdir(), "composed-v10-pin-"));
    roots.push(workspaceDir);
    const built = await createSyntheticV6BundleFixture({ workspaceDir, plans: [{ kind: "rfc3161-lock" }] });
    const bundleDir = detach(built.bundle.bundleDir);

    const asSix = await verifyPublicBundleSnapshot(bundleDir);
    // Relabelled and re-rendered as `/10`, but the claim keeps `/6`'s reader line.
    convertToComposedPresentation(bundleDir, asSix.comparison, { repinReader: false });

    let message = "";
    try {
      await verifyPublicBundle(bundleDir);
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain("verification.command");
  }, 180_000);
});
