// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3698: the published page states the declared denominator beside the strict all-slots one.
 *
 * The pair is a `/10` presentation capability (operator ruling 2026-09-24), not a new format
 * number. A published page is immutable — `verifyPublicBundleSnapshot` byte-compares every
 * presentation asset against the reader's own rebuild — so the render may appear on `/10` and
 * must not appear on any format allocated before it.
 */

import { describe, expect, test } from "vitest";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { BUNDLE_FORMAT } from "./legacy-closures.js";
import { BUNDLE_V10_FORMAT, SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import { goldenInput } from "./testing/golden-asset-input.js";

const decoder = new TextDecoder();
const decode = (bytes: Uint8Array): string => decoder.decode(bytes);

/** The rendered `index.html`'s wilson arm table for the sealed Report, header row included. */
async function reportArmTable(format: (typeof SUPPORTED_BUNDLE_FORMATS)[number]): Promise<string> {
  return reportArmTableFrom(buildPublicAssets(await goldenInput(format)));
}

function reportArmTableFrom(assets: Readonly<Record<string, Uint8Array>>): string {
  return htmlArmTable(assets, "Exact wilson@1 values from the sealed Report");
}

function claimArmTableFrom(assets: Readonly<Record<string, Uint8Array>>): string {
  return htmlArmTable(assets, "Exact arm values stored in the Claim package");
}

function htmlArmTable(assets: Readonly<Record<string, Uint8Array>>, caption: string): string {
  const html = decode(assets["index.html"]!);
  const start = html.indexOf(caption);
  expect(start, `the page renders ${caption}`).toBeGreaterThan(-1);
  const end = html.indexOf("</table>", start);
  return html.slice(start, end);
}

function claimReadmeTable(readme: string): string {
  const start = readme.indexOf("## Stored Claim facts");
  expect(start, "README has a Stored Claim facts section").toBeGreaterThan(-1);
  const end = readme.indexOf("### Claim method and preregistration", start);
  return readme.slice(start, end);
}

const leftoverReading =
  "-2 — inconsistent: the declared denominator exceeds the planned slots this table's sealed accounting counted for this arm.";
/** `escapeMarkup` encodes the apostrophe; README markdown does not. Pin both. */
const leftoverHtmlAlert = leftoverReading.replaceAll("'", "&#39;");

describe("the denominator pair renders on /10 and on no format before it", () => {
  test("every format allocated before /10 keeps the declared denominator alone", async () => {
    const baseline = buildPublicAssets(await goldenInput(BUNDLE_FORMAT));
    for (const format of SUPPORTED_BUNDLE_FORMATS.filter((candidate) => candidate !== BUNDLE_V10_FORMAT)) {
      const assets = buildPublicAssets(await goldenInput(format));
      for (const [name, bytes] of Object.entries(baseline)) {
        expect(decode(assets[name]!), `${format} ${name}`).toBe(decode(bytes));
      }
      const table = reportArmTableFrom(assets);
      expect(table, format).toContain('<th scope="col">Arm</th><th scope="col">n</th><th scope="col">Pass rate</th>');
      expect(table, format).not.toContain("All planned slots");
    }
  });

  test("/10 states the three numbers adjacently in the report arm table", async () => {
    const table = await reportArmTable(BUNDLE_V10_FORMAT);
    expect(table).toContain(
      '<th scope="col">Judged n</th><th scope="col">All planned slots</th><th scope="col">Not in the denominator</th>',
    );
    // Adjacency is the point: the three cells sit together in the row, in the header's order.
    // The golden fixture's two arms each have declared n 3 and planned slots 3, so the third
    // number is zero, which this page states rather than omits.
    expect(table).toContain('<th scope="row">baseline</th><td>3</td><td>3</td><td>0</td>');
    expect(table).toContain('<th scope="row">sample-uniform</th><td>3</td><td>3</td><td>0</td>');
  });

  test("/10's README states the same three numbers", async () => {
    const readme = decode(buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT))["README.md"]!);
    expect(readme).toContain(
      "| Arm | Judged n | All planned slots | Not in the denominator | Pass rate | Wilson low | Wilson high |",
    );
    expect(readme).toContain("| baseline | 3 | 3 | 0 |");
  });
});

describe("what /10 does when the two sealed records do not line up", () => {
  async function withPlannedSlots(expected: number | undefined): Promise<PublicAssetInput> {
    const input = await goldenInput(BUNDLE_V10_FORMAT);
    const perArm = { ...input.matrix.attrition.perArm } as Record<string, unknown>;
    if (expected === undefined) delete perArm["baseline"];
    else perArm["baseline"] = { ...(perArm["baseline"] as object), expected };
    return {
      ...input,
      matrix: { ...input.matrix, attrition: { ...input.matrix.attrition, perArm } } as PublicAssetInput["matrix"],
    };
  }

  test("an arm the accounting does not carry withholds its strict number rather than guessing zero", async () => {
    const table = reportArmTableFrom(buildPublicAssets(await withPlannedSlots(undefined)));
    expect(table).toContain('<th scope="row">baseline</th><td>3</td><td>Not stated</td><td>Not stated</td>');
  });

  test("a declared denominator larger than the planned slots is stated, with its reading", async () => {
    const table = reportArmTableFrom(buildPublicAssets(await withPlannedSlots(1)));
    expect(table).toContain(
      `<th scope="row">baseline</th><td>3</td><td>1</td><td><span role="alert">${leftoverHtmlAlert}</span></td>`,
    );
    expect(table).not.toContain("Matrix");
  });

  test("the claim mirror reads the claim's own accounting, not the Matrix's", async () => {
    const input = await goldenInput(BUNDLE_V10_FORMAT);
    const assets = buildPublicAssets({
      ...input,
      claim: { ...input.claim, attrition: { perArm: {} } } as PublicAssetInput["claim"],
    });
    expect(claimArmTableFrom(assets)).toContain(
      '<th scope="row">baseline</th><td>3</td><td>Not stated</td><td>Not stated</td>',
    );
    expect(reportArmTableFrom(buildPublicAssets(input))).toContain(
      '<th scope="row">baseline</th><td>3</td><td>3</td><td>0</td>',
    );
  });

  test("a claim-table leftover names this table's accounting, not the Matrix", async () => {
    const input = await goldenInput(BUNDLE_V10_FORMAT);
    const assets = buildPublicAssets({
      ...input,
      claim: {
        ...input.claim,
        attrition: { perArm: { baseline: { expected: 1 } } },
      } as PublicAssetInput["claim"],
    });
    const claimTable = claimArmTableFrom(assets);
    expect(claimTable).toContain(
      `<th scope="row">baseline</th><td>3</td><td>1</td><td><span role="alert">${leftoverHtmlAlert}</span></td>`,
    );
    expect(claimTable).not.toContain("Matrix");
    // The report table still reads Matrix accounting: the pair is allowed to disagree.
    expect(reportArmTableFrom(assets)).toContain(
      '<th scope="row">baseline</th><td>3</td><td>3</td><td>0</td>',
    );

    const claimReadme = claimReadmeTable(decode(assets["README.md"]!));
    expect(claimReadme).toContain(`| baseline | 3 | 1 | ${leftoverReading} |`);
    expect(claimReadme).not.toContain("Matrix");
  });
});
