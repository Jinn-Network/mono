// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3698: the published page states the declared denominator beside the strict all-slots one.
 *
 * Two properties, and the second is the reason the first needed a format allocation at all. A
 * published page is immutable — `verify.ts` byte-compares every presentation asset against the
 * reader's own rebuild — so the render may appear on `benchmark-product-public-bundle/9` and must
 * not appear on any format allocated before it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseMatrix, parseReport } from "@jinn-network/benchmarking-records";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { derivePublicComparison } from "./comparison.js";
import { SUPPORTED_BUNDLE_FORMATS, type SupportedBundleFormat } from "./manifest.js";

const GOLDEN = new URL("../fixtures/public-bundle-conformance-v1/golden/", import.meta.url);

const read = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, GOLDEN)));
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * The golden fixture's own verified facts, as the verifier assembles them. A `wilson@1` report over
 * two arms, each with a declared `n` of 3 and a planned-slot count of 3 — so the pair's third
 * number is zero, which this page states rather than omits.
 */
function goldenInput(format: SupportedBundleFormat): PublicAssetInput {
  const claim = JSON.parse(readFileSync(new URL("claim-package.json", GOLDEN), "utf8")) as PublicAssetInput["claim"] & {
    readonly records: { readonly matrixSha256: string; readonly reportSha256: string };
    readonly conflicted: { readonly cellKeys: readonly string[] };
  };
  const manifest = JSON.parse(readFileSync(new URL("bundle.json", GOLDEN), "utf8")) as {
    readonly files: readonly { readonly path: string }[];
  };
  const matrix = parseMatrix(read("matrix.json"));
  const records = new Map(
    manifest.files.flatMap((file) => {
      const match = /^records\/([a-f0-9]{64})\.bin$/u.exec(file.path);
      return match === null ? [] : [[match[1]!, read(file.path)] as const];
    }),
  );
  const assembly = decode(read("verification/assembly.jsonl"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { readonly cellKey: string; readonly verdicts: readonly { readonly verdict: string }[] });
  return {
    format,
    claim,
    matrix,
    report: parseReport(read("report.json")),
    reportSha256: claim.records.reportSha256,
    matrixSha256: claim.records.matrixSha256,
    recordSha256s: [...records.keys()],
    dissentCellKeys: [],
    comparison: derivePublicComparison({
      benchmark: JSON.parse(decode(read("benchmark.json"))) as never,
      matrix,
      assemblyCells: assembly as never,
      recordBytes: records,
    }),
  };
}

/** The rendered `index.html`'s wilson arm table for the sealed Report, header row included. */
function reportArmTable(assets: Readonly<Record<string, Uint8Array>>): string {
  const html = decode(assets["index.html"]!);
  const caption = "Exact wilson@1 values from the sealed Report";
  const start = html.indexOf(caption);
  expect(start, "the page renders a wilson arm table").toBeGreaterThan(-1);
  const end = html.indexOf("</table>", start);
  return html.slice(start, end);
}

describe("the denominator pair renders on /9 and on no format before it", () => {
  test("every format allocated before /9 renders byte-identically to every other", () => {
    // One input, every earlier format: the assets must not move. This is the property the
    // allocation exists to protect — a page element that leaked into an earlier format would break
    // every report already published under it, and no test that renders only `/9` would notice.
    const earlier = SUPPORTED_BUNDLE_FORMATS.filter((format) => format !== "benchmark-product-public-bundle/9");
    const baseline = buildPublicAssets(goldenInput("benchmark-product-public-bundle/2"));
    for (const format of earlier) {
      const assets = buildPublicAssets(goldenInput(format));
      for (const [name, bytes] of Object.entries(baseline)) {
        expect(decode(assets[name]!), `${format} ${name}`).toBe(decode(bytes));
      }
    }
  });

  test("/9 changes exactly the two assets that carry the arm tables", () => {
    const before = buildPublicAssets(goldenInput("benchmark-product-public-bundle/6"));
    const after = buildPublicAssets(goldenInput("benchmark-product-public-bundle/9"));
    const changed = Object.keys(before)
      .filter((name) => decode(after[name]!) !== decode(before[name]!))
      .sort();
    // The badge, the social card, and the share text carry no per-arm denominator, so a change
    // there would mean the gate had reached further than the arm tables.
    expect(changed).toEqual(["README.md", "index.html"]);
  });

  test("/9 states the three numbers adjacently in the report arm table", () => {
    const table = reportArmTable(buildPublicAssets(goldenInput("benchmark-product-public-bundle/9")));
    expect(table).toContain(
      '<th scope="col">Judged n</th><th scope="col">All planned slots</th><th scope="col">Not in the denominator</th>',
    );
    // Adjacency is the point: the three cells sit together in the row, in the header's order.
    expect(table).toContain('<th scope="row">baseline</th><td>3</td><td>3</td><td>0</td>');
    // Zero is a result, not an absence, and is stated (`denominators.ts`).
    expect(table).toContain('<th scope="row">sample-uniform</th><td>3</td><td>3</td><td>0</td>');
  });

  test("a format before /9 states the declared denominator alone", () => {
    const table = reportArmTable(buildPublicAssets(goldenInput("benchmark-product-public-bundle/6")));
    expect(table).toContain('<th scope="col">Arm</th><th scope="col">n</th><th scope="col">Pass rate</th>');
    expect(table).not.toContain("All planned slots");
  });

  test("/9's README states the same three numbers", () => {
    const readme = decode(buildPublicAssets(goldenInput("benchmark-product-public-bundle/9"))["README.md"]!);
    expect(readme).toContain("| Arm | Judged n | All planned slots | Not in the denominator | Pass rate | Wilson low | Wilson high |");
    expect(readme).toContain("| baseline | 3 | 3 | 0 |");
  });
});

describe("what /9 does when the two sealed records do not line up", () => {
  /** The same golden facts with one arm's planned-slot count replaced, or removed entirely. */
  function withPlannedSlots(expected: number | undefined): PublicAssetInput {
    const input = goldenInput("benchmark-product-public-bundle/9");
    const perArm = { ...input.matrix.attrition.perArm } as Record<string, unknown>;
    if (expected === undefined) delete perArm["baseline"];
    else perArm["baseline"] = { ...(perArm["baseline"] as object), expected };
    return {
      ...input,
      matrix: { ...input.matrix, attrition: { ...input.matrix.attrition, perArm } } as PublicAssetInput["matrix"],
    };
  }

  test("an arm the accounting does not carry withholds its strict number rather than guessing zero", () => {
    const table = reportArmTable(buildPublicAssets(withPlannedSlots(undefined)));
    // A withheld number is not a zero: a zero would read as "this arm planned nothing" and would
    // understate the exclusion, which is the flattering direction.
    expect(table).toContain('<th scope="row">baseline</th><td>3</td><td>Not stated</td><td>Not stated</td>');
  });

  test("a declared denominator larger than the planned slots is stated, with its reading", () => {
    const table = reportArmTable(buildPublicAssets(withPlannedSlots(1)));
    expect(table).toContain(
      '<th scope="row">baseline</th><td>3</td><td>1</td>'
      + '<td><span role="alert">-2 — inconsistent: the declared denominator exceeds the planned'
      + ' slots the sealed Matrix counted for this arm.</span></td>',
    );
  });

  test("the claim mirror reads the claim's own accounting, not the Matrix's", () => {
    // The two tables state what their own source says. A mirror that silently sourced the other
    // record could not disagree with it, and disagreement between two sealed records is exactly
    // what this page must be able to show.
    const input = goldenInput("benchmark-product-public-bundle/9");
    const html = decode(buildPublicAssets({
      ...input,
      claim: { ...input.claim, attrition: { perArm: {} } } as PublicAssetInput["claim"],
    })["index.html"]!);
    const claimStart = html.indexOf("Exact arm values stored in the Claim package");
    const claimTable = html.slice(claimStart, html.indexOf("</table>", claimStart));
    expect(claimTable).toContain('<th scope="row">baseline</th><td>3</td><td>Not stated</td><td>Not stated</td>');
    // The Report table, reading the Matrix, is unaffected.
    expect(reportArmTable(buildPublicAssets(input))).toContain('<th scope="row">baseline</th><td>3</td><td>3</td><td>0</td>');
  });
});
