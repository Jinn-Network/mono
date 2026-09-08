// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #4191: the four report-prose rulings (#3016) render behind `/10`, and behind nothing else.
 *
 * The report page is byte-pinned. `verifyPublicBundleSnapshot` rebuilds every presentation asset
 * and refuses the bundle on any mismatch, and every published claim seals the exact `npx` line
 * that performs that rebuild — so a rendered string that moved under a format someone has already
 * published breaks that bundle under the command printed on its own page, and no repo change can
 * reach it. That makes the FIRST block below the load-bearing one: it renders the same golden
 * facts at every non-`/10` format and requires every asset key to come back byte-identical.
 *
 * The remaining blocks are the feature: the composed page carries each ruling, the prose review
 * finds nothing on it, and — the sharpest real hazard, since the golden fixture is `wilson@1` —
 * no disclosure is lost under a method whose header claim line does not carry it.
 */

import { describe, expect, test } from "vitest";
import {
  buildPublicAssets,
  type PublicAssetInput,
} from "./assets.js";
import { BUNDLE_FORMAT } from "./legacy-closures.js";
import { BUNDLE_V10_FORMAT, SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import { reportProseWordCount, reviewReportProse } from "./report-prose-review.js";
import { GOLDEN_PUBLISHED_PAGE, goldenInput } from "./testing/golden-asset-input.js";

const decoder = new TextDecoder();
const decode = (bytes: Uint8Array): string => decoder.decode(bytes);

/** The rendered `index.html` for the golden facts at one format. */
async function page(format: (typeof SUPPORTED_BUNDLE_FORMATS)[number]): Promise<string> {
  return decode(buildPublicAssets(await goldenInput(format))["index.html"]!);
}

describe("no already-published format's presentation bytes move", () => {
  test("the /2 rendering reproduces the golden bundle's published assets exactly", async () => {
    // The anchor for everything below. If the facts this suite reconstructs ever drifted from the
    // ones the verifier assembles, the loop that follows would still pass — it compares renderings
    // against each other — while every page it compared was wrong. This compares against bytes a
    // third party already holds.
    const assets = buildPublicAssets(await goldenInput(BUNDLE_FORMAT));
    expect(decode(assets["index.html"]!)).toBe(GOLDEN_PUBLISHED_PAGE);
  });

  test("every format but /10 renders every asset key byte-identically", async () => {
    const baseline = buildPublicAssets(await goldenInput(BUNDLE_FORMAT));
    for (const format of SUPPORTED_BUNDLE_FORMATS.filter((candidate) => candidate !== BUNDLE_V10_FORMAT)) {
      const assets = buildPublicAssets(await goldenInput(format));
      // Every key, not just `index.html`: `README.md`, `badge.svg`, `social-card.svg`, and
      // `share.txt` are byte-pinned by the same rebuild, and "the rulings did not touch them" is
      // an assertion, not an observation.
      expect(Object.keys(assets).sort(), format).toEqual(Object.keys(baseline).sort());
      for (const [name, bytes] of Object.entries(baseline)) {
        expect(decode(assets[name]!), `${format} ${name}`).toBe(decode(bytes));
      }
    }
  });

  test("/10 changes the report page and nothing else", async () => {
    const baseline = buildPublicAssets(await goldenInput(BUNDLE_FORMAT));
    const composed = buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT));
    const changed = Object.entries(baseline)
      .filter(([name, bytes]) => decode(composed[name]!) !== decode(bytes))
      .map(([name]) => name);
    // Pinned exactly, in both directions: an empty set would mean the allocation renders nothing
    // new, and a larger one would mean a ruling reached an asset no ruling names (design §6).
    expect(changed).toEqual(["index.html"]);
  });
});

describe("the composed page carries the four rulings", () => {
  test("the header states no comparative winner exactly once, and no other site repeats it", async () => {
    const composed = await page(BUNDLE_V10_FORMAT);
    expect(composed).toContain("No comparative winner is stated; wilson@1 reports neutral per-arm facts only.");
    expect(composed).not.toContain("derived from the sample consensus inputs. No comparative winner is stated.");
    expect(composed).not.toContain("This is descriptive evidence, not a registered comparative winner.");
    // The disclosures the same sentences carry survive: only the winner clause is dropped.
    expect(composed).toContain("Its outcomes are synthetic and derived from the sample consensus inputs.");
    expect(composed).toContain("Lower is better.");
  });

  test("the non-reconciliation disclosure is stated once, on the first sealed-source section", async () => {
    const composed = await page(BUNDLE_V10_FORMAT);
    const stated = composed.split("values below are copied without reconciliation").length - 1;
    expect(stated).toBe(1);
    // On the Matrix section, and with every section's authenticated record link retained.
    expect(composed).toContain(
      '<a href="matrix.json">matrix.json</a>; values below are copied without reconciliation.',
    );
    expect(composed).toContain('Source: authenticated <a href="report.json">report.json</a>.</p>');
    expect(composed).toContain('Source: authenticated <a href="claim-package.json">claim-package.json</a>.</p>');
  });

  test("attribution renders once, in the footer imprint", async () => {
    const composed = await page(BUNDLE_V10_FORMAT);
    expect(composed.split('<p class="about">').length - 1).toBe(1);
    // The verification section keeps its trust root and now ends there; the surviving imprint is
    // the footer's, which the golden page renders after the report digest.
    expect(composed).toContain("<h3>Trust root</h3>");
    expect(composed).toMatch(/<h3>Trust root<\/h3><p>[^<]*<\/p><\/section>/u);
    expect(GOLDEN_PUBLISHED_PAGE.split('<p class="about">').length - 1).toBe(2);
  });

  test("the narrated control is cut and its disclosure controls remain", async () => {
    const composed = await page(BUNDLE_V10_FORMAT);
    expect(composed).not.toContain("Open a cell to inspect its evidence");
    expect(composed).toContain('<details id="cell-');
  });
});

describe("the composed page's prose review", () => {
  test("finds nothing", async () => {
    expect(reviewReportProse(await page(BUNDLE_V10_FORMAT))).toEqual([]);
  });

  test("measures the count REPORT_PROSE_WORD_CEILING is re-pinned to", async () => {
    // The exact number, not merely "fewer than before": the ceiling is a ratchet, and a ratchet
    // pinned to an approximation ratchets nothing.
    expect(reportProseWordCount(await page(BUNDLE_V10_FORMAT))).toBe(327);
    expect(reportProseWordCount(GOLDEN_PUBLISHED_PAGE)).toBe(363);
  });
});

/**
 * The AC4 hazard, stated as a test.
 *
 * Ruling 1's premise — "the header claim line becomes the page's single statement of it" — holds
 * only for methods whose `neutralClaimHtml` branch actually carries the winner statement.
 * `paired-delta@1` and `paired-majority-delta@1` render an estimate line instead, which carries no
 * winner disclaimer at all, so an unconditional drop at the comparison sites would delete the only
 * statement of it from those pages. The golden fixture is `wilson@1` and would never catch that.
 */
describe("no disclosure is lost under a method whose claim line does not carry it", () => {
  const WINNER = "No comparative winner is stated";

  /** The golden facts re-methoded. Only the Report and claim method/results move; every other
   * verified fact, including the comparison view, is the golden bundle's own. */
  async function methodPage(
    method: { readonly id: string; readonly parameters: Record<string, string> },
    results: Record<string, unknown>,
  ): Promise<string> {
    const base = await goldenInput(BUNDLE_V10_FORMAT);
    const perSubject = { perSubject: [{ subjectSha256: base.matrixSha256, results }] };
    const input = {
      ...base,
      report: { ...base.report, method: { ...method, version: "1" }, results: perSubject },
      claim: {
        ...base.claim,
        method: { ...method, version: "1", preregistered: true },
        results: perSubject,
      },
    } as unknown as PublicAssetInput;
    return decode(buildPublicAssets(input)["index.html"]!);
  }

  const PAIRED_DELTA = {
    id: "jinn.benchmarking.method/paired-delta",
    parameters: { baseline: "baseline", candidate: "sample-uniform", alpha: "0.05" },
  };

  const pairedDeltaResults = {
    pairs: 3,
    delta: "0.083333",
    interval: { alpha: "0.05", low: "-0.041667", high: "0.208333" },
    reasons: [],
    conflicted: { count: 0, cellKeys: [] },
  };

  const PAIRED_MAJORITY_DELTA = {
    id: "jinn.benchmarking.method/paired-majority-delta",
    parameters: { alpha: "0.05" },
  };

  const pairedMajorityDeltaResults = {
    baseline: "baseline",
    candidate: "sample-uniform",
    n: 3,
    delta: "0.083333",
    interval: { lower: "-0.041667", upper: "0.208333", alpha: "0.05" },
    reasons: [],
    conflicted: { count: 0, cellKeys: [] },
  };

  test("paired-delta@1 keeps it, because its header renders an estimate line instead", async () => {
    const composed = await methodPage(PAIRED_DELTA, pairedDeltaResults);
    expect(composed).not.toContain(WINNER + "; wilson@1");
    expect(composed.split(WINNER).length - 1).toBe(1);
  });

  test("paired-majority-delta@1 keeps it, for the same reason", async () => {
    const composed = await methodPage(PAIRED_MAJORITY_DELTA, pairedMajorityDeltaResults);
    expect(composed).not.toContain(WINNER + "; wilson@1");
    expect(composed.split(WINNER).length - 1).toBe(1);
  });

  test("wilson@1 states it once, from the header, where the published page stated it twice", async () => {
    expect((await page(BUNDLE_V10_FORMAT)).split(WINNER).length - 1).toBe(1);
    expect(GOLDEN_PUBLISHED_PAGE.split(WINNER).length - 1).toBe(2);
  });
});
