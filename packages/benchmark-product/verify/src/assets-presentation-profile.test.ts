// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #2984: a bundle must byte-match the one presentation profile its closure selects.
 *
 * Before this guard, `verify.ts` accepted a second profile by byte-guessing: it rendered the
 * assets a pre-comparison ("Reader v1") producer would have written and, if the bundle happened
 * to match those bytes, adopted them as the expectation. No bundle the verifier accepts is in
 * that profile — the current producer cannot emit it (`core/src/bundle/materialize.ts` derives a
 * comparison for every non-binary bundle), and every conformance fixture carries the comparison
 * section — so the branch only widened what the verifier would accept. (The one committed bundle
 * rendered without a comparison, `docs/proofs/2026-08-10-inspect-runtime/bundle`, refuses at its
 * claim-package schema long before the asset check, as its own README records.)
 *
 * This test builds exactly that legacy rendering from the golden fixture's own verified facts and
 * requires the verifier to refuse it.
 */

import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseMatrix, parseReport } from "@jinn-network/benchmarking-records";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { buildBundleManifest } from "./manifest.js";
import { verifyPublicBundle } from "./verify.js";

const GOLDEN = new URL("../fixtures/public-bundle-conformance-v1/golden/", import.meta.url);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copyGolden(): string {
  const root = mkdtempSync(join(tmpdir(), "colophon-presentation-profile-"));
  roots.push(root);
  const bundleDir = join(root, "bundle");
  cpSync(GOLDEN, bundleDir, { recursive: true });
  return bundleDir;
}

/**
 * The legacy profile's asset input: the same verified facts the verifier assembles, with neither
 * `comparison` (the non-binary profile) nor `binaryQualification` (the `/4` and `/7` profile).
 * Every digest is read from the bundle's own stored claim, so nothing here is a hand-copied
 * constant that could drift from the fixture.
 */
function legacyAssetInput(bundleDir: string): PublicAssetInput {
  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(bundleDir, name)));
  const claim = JSON.parse(readFileSync(join(bundleDir, "claim-package.json"), "utf8")) as PublicAssetInput["claim"] & {
    readonly records: { readonly matrixSha256: string; readonly reportSha256: string };
    readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
  };
  const manifest = JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf8")) as {
    readonly files: readonly { readonly path: string }[];
  };
  return {
    claim,
    matrix: parseMatrix(read("matrix.json")),
    report: parseReport(read("report.json")),
    reportSha256: claim.records.reportSha256,
    matrixSha256: claim.records.matrixSha256,
    recordSha256s: manifest.files.flatMap((file) => {
      const match = /^records\/([a-f0-9]{64})\.bin$/u.exec(file.path);
      return match === null ? [] : [match[1]!];
    }),
    // The golden fixture reports no verdict conflict, so its dissent projection is empty; asserted
    // below rather than assumed, because a non-empty one would silently change the rendered bytes.
    dissentCellKeys: [...claim.conflicted.cellKeys],
  };
}

function rewriteAsLegacyPresentation(bundleDir: string): void {
  const input = legacyAssetInput(bundleDir);
  expect(input.dissentCellKeys, "golden fixture dissent projection").toEqual([]);
  const legacy = buildPublicAssets(input);
  const changed = Object.entries(legacy).filter(([name, bytes]) =>
    createHash("sha256").update(bytes).digest("hex")
      !== createHash("sha256").update(readFileSync(join(bundleDir, name))).digest("hex"));
  // Guards the guard, twice over. If the legacy rendering were byte-identical to the published
  // one, the refusal below would prove nothing about which profile the verifier accepted. And the
  // set is pinned exactly, not merely searched: `comparison` reaches the bytes only through
  // `index.html` and `README.md`, so if the facts reconstructed above ever drifted from the ones
  // the verifier assembles internally, every asset would differ instead and this assertion would
  // fail — rather than the refusal below passing for an unrelated reason.
  expect(changed.map(([name]) => name).sort(), "legacy rendering differs from the published profile")
    .toEqual(["README.md", "index.html"]);
  for (const [name, bytes] of Object.entries(legacy)) writeFileSync(join(bundleDir, name), bytes);
  const manifest = JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf8")) as {
    readonly format: "benchmark-product-public-bundle/2";
    readonly files: readonly { readonly path: string }[];
  };
  writeFileSync(
    join(bundleDir, "bundle.json"),
    buildBundleManifest(bundleDir, manifest.files.map((file) => file.path), { format: manifest.format }).bytes,
  );
}

test("the golden fixture verifies on its own published presentation profile", async () => {
  await expect(verifyPublicBundle(copyGolden())).resolves.toMatchObject({
    format: "benchmark-product-public-bundle/2",
  });
});

test("a bundle rendered in the legacy comparison-absent profile is refused", async () => {
  const bundleDir = copyGolden();
  rewriteAsLegacyPresentation(bundleDir);
  await expect(verifyPublicBundle(bundleDir)).rejects.toMatchObject({
    code: "record-integrity",
    message: "index.html is not the exact projection of verified public facts",
  });
});
