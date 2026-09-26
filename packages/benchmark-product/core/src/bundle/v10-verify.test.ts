// SPDX-License-Identifier: Apache-2.0

/**
 * The composed generation, round-tripped through the portable reader (issue #4191 for the page,
 * issue #3403 for the capability vector).
 *
 * `v10-closure.test.ts` and `composed-verify.test.ts` in the reader package state `/10`'s
 * allocation against the constants and against the conformance kit's unanchored golden bundle; this
 * is the half neither can supply: a real ANCHORED bundle, converted to the composed bundle the same
 * facts produce under the vector `["anchoring"]`, verifies -- with v6's closure, v6's seven checks,
 * and v6's mandatory members -- under the same `verifyPublicBundle` a third party runs.
 *
 * That matters because the places `/10` reaches the verification path are wiring, not data: the
 * closure selection (`verify.ts`, which must derive the closure from the declared vector) and the
 * claim rebuild's `composedCapabilities` (which must be read from the manifest, so a `/10` bundle is
 * required to carry the composed claim its own vector derives). Neither is exercised by a test that
 * only reads constants, and a drift in either would be silent.
 *
 * The producer also emits `/10` by default (issue #3405). The bundle here is still BUILT as `/6`
 * and converted, so this file proves the reader independently of the producer.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseMatrix, parseReport } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import {
  BUNDLE_V10_FORMAT,
  COMPOSED_CLAIM_PACKAGE_SCHEMA_ID,
  readerInstructions,
  verifyPublicBundle,
  verifyPublicBundleSnapshot,
} from "@colophon-claims/check";
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

/** The vector an anchored, non-qualifying run declares: exactly what `/6` implied by its number. */
const ANCHORED = ["anchoring"] as const;

/**
 * Converts a materialized `/6` bundle in place into the composed bundle the same facts produce.
 *
 * Three edits, in the order a producer would make them: the claim becomes the composed generation's
 * claim package and pins the reader line its vector derives, every presentation asset is
 * re-rendered at `/10`, and the manifest is re-sealed with the vector over the members the
 * directory now holds. Nothing about the records moves, so the sealed Run, Matrix, Report, evidence
 * catalog, and anchors are untouched.
 *
 * Every input to the re-render is read from the bundle's own bytes rather than carried over from
 * the fixture's build, so a conversion that drifted from what the verifier assembles would fail
 * the verifier's own byte-compare rather than passing against a private copy of the facts.
 */
function convertToComposed(
  bundleDir: string,
  comparison: PublicAssetInput["comparison"],
  options: { readonly keepLegacyClaim?: boolean; readonly capabilities?: readonly string[] } = {},
): void {
  if (comparison === undefined) {
    throw new Error("convertToComposed requires the verifier's comparison projection");
  }
  const claim = json(bundleDir, "claim-package.json");
  if (options.keepLegacyClaim !== true) {
    claim["claimSchema"] = COMPOSED_CLAIM_PACKAGE_SCHEMA_ID;
    claim["verification"] = { ...claim["verification"], ...readerInstructions(ANCHORED) };
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
    comparison,
  });
  for (const [path, bytes] of Object.entries(assets)) writeFileSync(join(bundleDir, path), bytes);

  writeFileSync(
    join(bundleDir, "bundle.json"),
    buildBundleManifest(bundleDir, manifest.files.map((file) => file.path), {
      format: BUNDLE_V10_FORMAT,
      capabilities: options.capabilities ?? ANCHORED,
    }).bytes,
  );
}

async function refusal(bundleDir: string): Promise<{ path: string; message: string }> {
  try {
    await verifyPublicBundle(bundleDir);
  } catch (cause) {
    const issue = (cause as { readonly issues?: readonly { path?: string; message?: string }[] }).issues?.[0];
    return { path: issue?.path ?? "", message: issue?.message ?? String(cause) };
  }
  return { path: "NOT REFUSED", message: "NOT REFUSED" };
}

describe("composed bundle v10 — portable verification", () => {
  test("a converted anchored bundle verifies with v6's closure, derived from its vector", async () => {
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

    convertToComposed(bundleDir, asSix.comparison);
    // The originating workspace is gone before a single byte is verified.
    rmSync(built.workspaceDir, { recursive: true, force: true });

    const verified = await verifyPublicBundle(bundleDir);
    expect(verified.format).toBe(BUNDLE_V10_FORMAT);
    if (verified.format !== BUNDLE_V10_FORMAT) throw new Error("unreachable");
    expect(verified.capabilities).toEqual(ANCHORED);
    // v6's seven, in v6's order -- the same verification outcome the pre-composition cell gives.
    expect(verified.checks).toEqual(asSix.verification.checks);
    expect(verified.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
      "integrity-anchors",
    ]);
    // `integrity-anchors` is in that list because the vector declares `anchoring`. Stated
    // separately so a closure that silently lost the anchor axis fails on the axis, not just on a
    // check name.
    expect(verified.anchors?.anchors).toHaveLength(1);
    // The four rulings are on the page the verifier just byte-compared against its own rebuild.
    const page = readFileSync(join(bundleDir, "index.html"), "utf8");
    expect(page).not.toContain("Open a cell to inspect its evidence");
    expect(page.split('<p class="about">').length - 1).toBe(1);
    expect(page.split("values below are copied without reconciliation").length - 1).toBe(1);

    // ── The same real bundle, under every other declaration ─────────────────────────────────────
    //
    // Re-sealed each time, so what the reader refuses is the declaration and not a stale digest.
    // Members without declaration: the anchor record is still in the tree, and nothing allowlists
    // it once the vector stops declaring `anchoring`. Stripping the declaration is never a quieter
    // bundle (P2, P3).
    convertToComposed(bundleDir, asSix.comparison, { capabilities: [] });
    expect(await refusal(bundleDir)).toEqual({
      path: expect.stringMatching(/^anchors\/[a-f0-9]{64}\.bin$/u),
      message: expect.stringContaining("non-allowlisted"),
    });
    // Declared without members: nothing in this bundle is a qualification document.
    convertToComposed(bundleDir, asSix.comparison, { capabilities: ["anchoring", "binary-qualification"] });
    expect(await refusal(bundleDir)).toEqual({
      path: "qualification.json",
      message: expect.stringContaining("is missing"),
    });
    // A token this reader does not implement refuses the bundle whole, by name.
    const manifest = json(bundleDir, "bundle.json");
    writeFileSync(join(bundleDir, "bundle.json"), canonicalJsonBytes({ ...manifest, capabilities: ["anchoring", "zz-unknown"] } as never));
    expect(await refusal(bundleDir)).toEqual({
      path: "bundle.manifest.capabilities",
      message: expect.stringContaining('"zz-unknown"'),
    });
  }, 180_000);

  test("a /10 bundle carrying /6's own claim is refused on the field that disagrees", async () => {
    // The binding that makes the claim honest: the rebuild reads the vector from the MANIFEST,
    // never from the claim under test, so the claim cannot satisfy itself. claim-package/4 is a
    // well-formed claim -- the admission schema accepts it -- so if this binding were absent the
    // mismatch would pass every check.
    const workspaceDir = mkdtempSync(join(tmpdir(), "composed-v10-claim-"));
    roots.push(workspaceDir);
    const built = await createSyntheticV6BundleFixture({ workspaceDir, plans: [{ kind: "rfc3161-lock" }] });
    const bundleDir = detach(built.bundle.bundleDir);

    const asSix = await verifyPublicBundleSnapshot(bundleDir);
    // Relabelled and re-rendered as `/10`, but the claim is still `/6`'s.
    convertToComposed(bundleDir, asSix.comparison, { keepLegacyClaim: true });

    expect(await refusal(bundleDir)).toEqual({
      path: "claim-consistency",
      message: expect.stringContaining("claimSchema"),
    });
  }, 180_000);
});
