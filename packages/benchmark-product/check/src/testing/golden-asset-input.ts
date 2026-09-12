// SPDX-License-Identifier: Apache-2.0

/**
 * The conformance golden bundle's own verified facts, as a `buildPublicAssets` input (issue #4191).
 *
 * Shared by `assets-report-prose.test.ts` and `report-prose-review.test.ts` because both must read
 * the SAME page: one proves the composed generation renders the rulings and no earlier format's
 * bytes moved, the other pins the prose review's ceiling and frozen list against it. Two
 * independent reconstructions of the same input would let those two pins disagree silently.
 *
 * Nothing here is a hand-copied constant. Every digest comes from the bundle's own stored claim,
 * the record identities from its own manifest, and the comparison view from the verifier's own
 * derivation over the bundle's authenticated bytes — so a fixture that drifted would fail loudly
 * rather than quietly rendering a page built from stale facts.
 *
 * Lives under `testing/` rather than beside a test file because `tsconfig.build.json` excludes that
 * directory from the published tarball, which is what keeps a helper that reads fixtures off every
 * consumer's disk, and because two sibling suites share it — so it cannot be named `*.test.ts`
 * without a test runner collecting it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseMatrix, parseReport } from "@jinn-network/benchmarking-records";
import type { PublicAssetInput } from "../assets.js";
import type { SupportedBundleFormat } from "../manifest.js";
import { verifyPublicBundleSnapshot } from "../verify.js";

/** The published `/2` bundle the conformance kit ships. Its bytes are never written to. */
export const GOLDEN_BUNDLE_DIR = fileURLToPath(
  new URL("../../fixtures/public-bundle-conformance-v1/golden/", import.meta.url),
);

/** The golden bundle's own `index.html`, exactly as it was published. */
export const GOLDEN_PUBLISHED_PAGE = readFileSync(join(GOLDEN_BUNDLE_DIR, "index.html"), "utf8");

/** Only what the dissent projection reads. The assembly's full grammar is the verifier's business. */
interface AssemblyCell {
  readonly cellKey: string;
  readonly verdicts: readonly { readonly verdict: string }[];
}

type GoldenFacts = Omit<PublicAssetInput, "format">;

let cached: GoldenFacts | undefined;

/**
 * Every asset fact the verifier itself assembles for the golden bundle, minus the format.
 *
 * The comparison view is taken from `verifyPublicBundleSnapshot`'s own result rather than
 * re-derived here: it is the projection the verifier byte-compares the published page against, so
 * taking it from anywhere else would be building a page nobody verifies. Verification is run once
 * and memoized — it authenticates the whole bundle, and repeating that per format would dominate
 * these suites' runtime for no additional proof.
 */
async function goldenFacts(): Promise<GoldenFacts> {
  if (cached !== undefined) return cached;
  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(GOLDEN_BUNDLE_DIR, name)));
  const claim = JSON.parse(readFileSync(join(GOLDEN_BUNDLE_DIR, "claim-package.json"), "utf8")) as
    PublicAssetInput["claim"] & {
      readonly records: { readonly matrixSha256: string; readonly reportSha256: string };
    };
  const manifest = JSON.parse(readFileSync(join(GOLDEN_BUNDLE_DIR, "bundle.json"), "utf8")) as {
    readonly files: readonly { readonly path: string }[];
  };
  const verified = await verifyPublicBundleSnapshot(GOLDEN_BUNDLE_DIR);
  if (verified.comparison === undefined) {
    throw new Error("the golden conformance bundle must carry a comparison projection");
  }
  cached = {
    claim,
    matrix: parseMatrix(read("matrix.json")),
    report: parseReport(read("report.json")),
    reportSha256: claim.records.reportSha256,
    matrixSha256: claim.records.matrixSha256,
    recordSha256s: manifest.files.flatMap((file) => {
      const match = /^records\/([a-f0-9]{64})\.bin$/u.exec(file.path);
      return match === null ? [] : [match[1]!];
    }),
    // Derived by the verifier's own rule — a cell dissents when its verdicts disagree — rather than
    // pinned to the empty list the golden fixture happens to produce. A helper that hard-coded the
    // answer would render a page from facts the fixture no longer carries.
    dissentCellKeys: readFileSync(join(GOLDEN_BUNDLE_DIR, "verification/assembly.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => (JSON.parse(line) as { readonly cells?: readonly AssemblyCell[] }).cells ?? [])
      .filter((cell) => new Set(cell.verdicts.map((verdict) => verdict.verdict)).size > 1)
      .map((cell) => cell.cellKey)
      .sort(),
    comparison: verified.comparison,
  };
  return cached;
}

/** The golden bundle's facts rendered at one format. */
export async function goldenInput(format: SupportedBundleFormat): Promise<PublicAssetInput> {
  return { ...(await goldenFacts()), format };
}
