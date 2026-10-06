// SPDX-License-Identifier: Apache-2.0

/**
 * The name of the rate on the report page of a run brought onto the official Terminal-Bench 2.1
 * slate (operator rulings of 2026-10-06, decision 2).
 *
 * The ruling: the number is called Terminal-Bench 2.1 accuracy only when every cell was judged;
 * otherwise it is the pass rate over judged cells. This page reads "every cell" as every cell of
 * the dataset: all 89 tasks are present, and every slot each arm planned entered the rate. A slice
 * with every cell judged is still a pass rate over judged cells.
 *
 * Two things decide the name, and neither is the Matrix's judged count:
 *
 * - the bundle's VERIFIED `terminalBench21Comparability` claim section, which is what entitles a
 *   page to the suite's name at all and carries how many of the dataset's tasks are present;
 * - each arm's `wilson@1` `n` against its planned slots, from `armDenominators`. A cell whose
 *   reward is neither 0 nor 1 has a valid `inconclusive` verdict, so the Matrix counts it as
 *   judged while `wilson@1` leaves it out of the rate. Reading the Matrix count would call that
 *   run "accuracy".
 *
 * The Report table and the Claim table are each named from their own source, as their denominator
 * pair is. A page without the section keeps "Pass rate": every earlier format, and every `/10`
 * bundle that does not declare the capability.
 */

import { describe, expect, test } from "vitest";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { BUNDLE_V10_FORMAT, SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import {
  TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
  type ClaimTerminalBench21ComparabilitySection,
} from "./profile/terminal-bench-2-1-comparability.js";
import { TERMINAL_BENCH_21_PINS } from "./profile/terminal-bench-2-1-pins.js";
import { goldenInput } from "./testing/golden-asset-input.js";

const decoder = new TextDecoder();
const decode = (bytes: Uint8Array | undefined): string => decoder.decode(bytes);

const PINS = TERMINAL_BENCH_21_PINS;
const FULL = PINS.datasetTaskCount;

const ACCURACY = "Terminal-Bench 2.1 accuracy";
const OVER_JUDGED = "Pass rate over judged cells";
const PLAIN = "Pass rate";

/** The claim section a declaring bundle carries, as the checker projects it from a verified slate. */
function section(selectedTaskCount: number): ClaimTerminalBench21ComparabilitySection {
  return {
    datasetId: PINS.datasetId,
    datasetRevision: PINS.datasetRevision,
    upstreamCommit: PINS.upstreamCommit,
    slateDigest: PINS.slateDigest,
    coverage: selectedTaskCount === FULL ? "full" : "custom",
    selectedTaskCount,
    datasetTaskCount: FULL,
    limit: TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
  };
}

/** One arm: the cells `wilson@1` took into its rate, the slots the run planned, and how many of
 * them the Matrix counts as judged (every one that carries a valid verdict, decisive or not). */
interface ArmFacts {
  readonly n: number;
  readonly expected: number;
  readonly matrixJudged?: number;
}

interface Facts {
  readonly arms: Readonly<Record<string, ArmFacts>>;
  /** Stored-claim accounting, when it should differ from the Matrix's. */
  readonly claimExpected?: Readonly<Record<string, number>>;
  /** Cells `wilson@1` dropped as conflicted. */
  readonly conflictedCellKeys?: readonly string[];
  readonly section?: ClaimTerminalBench21ComparabilitySection;
}

/** The golden bundle's verified `/10` facts with the per-arm results and accounting replaced. */
async function pageInput(facts: Facts): Promise<PublicAssetInput> {
  const base = await goldenInput(BUNDLE_V10_FORMAT);
  const conflictedCellKeys = facts.conflictedCellKeys ?? [];
  const results = {
    perSubject: [{
      subjectSha256: base.matrixSha256,
      results: {
        arms: Object.fromEntries(Object.entries(facts.arms).map(([armId, arm]) =>
          [armId, { n: arm.n, passRate: "1.0000", wilsonInterval: { low: "0.9586", high: "1.0000" } }])),
        conflicted: { count: conflictedCellKeys.length, cellKeys: conflictedCellKeys },
        verdictRule: "sole",
      },
    }],
  };
  const perArm = (expectedOf: (armId: string, arm: ArmFacts) => number) =>
    Object.fromEntries(Object.entries(facts.arms).map(([armId, arm]) => {
      const expected = expectedOf(armId, arm);
      const judged = arm.matrixJudged ?? arm.n;
      return [armId, {
        expected, judged, unjudged: 0, unscorable: expected - judged, expired: 0, invalidated: 0, excluded: 0, replacements: 0,
      }];
    }));
  const expected = Object.values(facts.arms).reduce((total, arm) => total + arm.expected, 0);
  const judged = Object.values(facts.arms).reduce((total, arm) => total + (arm.matrixJudged ?? arm.n), 0);
  const completeness = { expected, judged, floor: "1", runOutcome: judged === expected ? "complete" : "partial" };
  return {
    ...base,
    matrix: {
      ...base.matrix,
      completeness,
      attrition: { asymmetryFlags: [], perArm: perArm((_armId, arm) => arm.expected) },
    },
    report: { ...base.report, results },
    claim: {
      ...base.claim,
      results,
      completeness,
      attrition: {
        asymmetryFlags: [],
        perArm: perArm((armId, arm) => facts.claimExpected?.[armId] ?? arm.expected),
      },
      ...(facts.section === undefined ? {} : { terminalBench21Comparability: facts.section }),
    },
  } as unknown as PublicAssetInput;
}

/** Every planned cell of both arms entered the rate. */
const ALL_JUDGED = { oracle: { n: FULL, expected: FULL }, "terminus-2": { n: FULL, expected: FULL } } as const;

function htmlHeader(html: string, caption: string): string {
  const start = html.indexOf(caption);
  expect(start, `the page renders ${caption}`).toBeGreaterThan(-1);
  return html.slice(html.indexOf("<thead>", start) + "<thead>".length, html.indexOf("</thead>", start));
}
const reportHeader = (html: string): string => htmlHeader(html, "Exact wilson@1 values from the sealed Report");
const claimHeader = (html: string): string => htmlHeader(html, "Exact arm values stored in the Claim package");

function readmeHeader(readme: string, heading: string): string {
  const start = readme.indexOf(heading);
  expect(start, `README has ${heading}`).toBeGreaterThan(-1);
  const row = readme.indexOf("| Arm |", start);
  return readme.slice(row, readme.indexOf("\n", row));
}
const reportReadmeHeader = (readme: string): string => readmeHeader(readme, "## Sealed Report facts");
const claimReadmeHeader = (readme: string): string => readmeHeader(readme, "## Stored Claim facts");

const htmlColumns = (name: string): string =>
  '<tr><th scope="col">Arm</th><th scope="col">Judged n</th><th scope="col">All planned slots</th>'
  + `<th scope="col">Not in the denominator</th><th scope="col">${name}</th>`
  + '<th scope="col">Interval low</th><th scope="col">Interval high</th></tr>';
const readmeColumns = (name: string): string =>
  `| Arm | Judged n | All planned slots | Not in the denominator | ${name} | Wilson low | Wilson high |`;

/** All four renderings of the name: both tables, on the page and in README.md. */
function names(assets: Readonly<Record<string, Uint8Array>>): {
  readonly report: readonly string[];
  readonly claim: readonly string[];
} {
  const html = decode(assets["index.html"]);
  const readme = decode(assets["README.md"]);
  return {
    report: [reportHeader(html), reportReadmeHeader(readme)],
    claim: [claimHeader(html), claimReadmeHeader(readme)],
  };
}

function expectNames(
  assets: Readonly<Record<string, Uint8Array>>,
  expected: { readonly report: string; readonly claim: string },
): void {
  const rendered = names(assets);
  expect(rendered.report).toEqual([htmlColumns(expected.report), readmeColumns(expected.report)]);
  expect(rendered.claim).toEqual([htmlColumns(expected.claim), readmeColumns(expected.claim)]);
}

describe("the name of the rate on a page whose claim carries the Terminal-Bench 2.1 section", () => {
  test("is Terminal-Bench 2.1 accuracy when all 89 tasks are present and every planned cell entered the rate", async () => {
    const assets = buildPublicAssets(await pageInput({ arms: ALL_JUDGED, section: section(FULL) }));
    expectNames(assets, { report: ACCURACY, claim: ACCURACY });
  });

  test("is the pass rate over judged cells when one cell at full coverage is inconclusive", async () => {
    // A reward of 0.5 seals a valid `inconclusive` verdict. The Matrix counts the cell as judged,
    // and `wilson@1` drops it from the rate as conflicted. The Matrix's count says every cell was
    // judged; the rate's own denominator says one was not.
    const input = await pageInput({
      arms: { oracle: { n: FULL, expected: FULL }, "terminus-2": { n: FULL - 1, expected: FULL, matrixJudged: FULL } },
      conflictedCellKeys: [`${"a".repeat(64)}/terminus-2/1`],
      section: section(FULL),
    });
    expect(input.matrix.completeness.judged).toBe(input.matrix.completeness.expected);
    expect(input.matrix.completeness.runOutcome).toBe("complete");
    expectNames(buildPublicAssets(input), { report: OVER_JUDGED, claim: OVER_JUDGED });
  });

  test("is the pass rate over judged cells on a slice, though every cell of it was judged", async () => {
    const assets = buildPublicAssets(await pageInput({
      arms: { oracle: { n: 10, expected: 10 }, "terminus-2": { n: 10, expected: 10 } },
      section: section(10),
    }));
    expectNames(assets, { report: OVER_JUDGED, claim: OVER_JUDGED });
  });

  test("is the pass rate over judged cells when one arm is short", async () => {
    const assets = buildPublicAssets(await pageInput({
      arms: { oracle: { n: FULL, expected: FULL }, "terminus-2": { n: FULL - 3, expected: FULL } },
      section: section(FULL),
    }));
    expectNames(assets, { report: OVER_JUDGED, claim: OVER_JUDGED });
  });

  test("is the pass rate over judged cells when the accounting does not carry an arm", async () => {
    // A withheld strict number cannot show that every planned cell entered the rate.
    const input = await pageInput({ arms: ALL_JUDGED, section: section(FULL) });
    const perArm = { ...input.matrix.attrition.perArm } as Record<string, unknown>;
    delete perArm["terminus-2"];
    const assets = buildPublicAssets({
      ...input,
      matrix: { ...input.matrix, attrition: { ...input.matrix.attrition, perArm } },
    } as PublicAssetInput);
    expectNames(assets, { report: OVER_JUDGED, claim: ACCURACY });
  });

  test("is the pass rate over judged cells when a declared denominator exceeds the planned slots", async () => {
    const assets = buildPublicAssets(await pageInput({
      arms: { oracle: { n: FULL, expected: FULL }, "terminus-2": { n: FULL, expected: FULL - 1, matrixJudged: FULL - 1 } },
      section: section(FULL),
    }));
    expectNames(assets, { report: OVER_JUDGED, claim: OVER_JUDGED });
  });

  test("is never accuracy over an arm that states no rate", async () => {
    // An arm that planned nothing has judged n 0 equal to its planned slots. The page states no
    // rate for it, so the column is not called accuracy.
    const assets = buildPublicAssets(await pageInput({
      arms: { oracle: { n: FULL, expected: FULL }, "terminus-2": { n: 0, expected: 0 } },
      section: section(FULL),
    }));
    expectNames(assets, { report: OVER_JUDGED, claim: OVER_JUDGED });
  });

  test("each table is named from its own source", async () => {
    // The Report table reads the Matrix accounting and the Claim table the claim's own. No
    // verified bundle carries two that disagree; a mirror that could not disagree proves nothing.
    const assets = buildPublicAssets(await pageInput({
      arms: ALL_JUDGED,
      claimExpected: { "terminus-2": FULL + 1 },
      section: section(FULL),
    }));
    expectNames(assets, { report: ACCURACY, claim: OVER_JUDGED });
  });

  test("the name is all the section moves in these assets", async () => {
    const plain = buildPublicAssets(await pageInput({ arms: ALL_JUDGED }));
    const declaring = buildPublicAssets(await pageInput({ arms: ALL_JUDGED, section: section(FULL) }));
    for (const name of ["index.html", "README.md"]) {
      expect(decode(declaring[name]).split(ACCURACY), name).toHaveLength(3);
      expect(decode(declaring[name]).replaceAll(ACCURACY, PLAIN), name).toBe(decode(plain[name]));
    }
    // The badge, the social card and the share text carry no rate and no rate name.
    for (const name of ["badge.svg", "social-card.svg", "share.txt"]) {
      expect(decode(declaring[name]), name).toBe(decode(plain[name]));
      expect(decode(declaring[name]), name).not.toContain("accuracy");
    }
  });
});

describe("a page whose claim carries no Terminal-Bench 2.1 section", () => {
  test("keeps Pass rate on /10, whatever was judged", async () => {
    expectNames(buildPublicAssets(await pageInput({ arms: ALL_JUDGED })), { report: PLAIN, claim: PLAIN });
    const short = buildPublicAssets(await pageInput({
      arms: { oracle: { n: FULL, expected: FULL }, "terminus-2": { n: FULL - 1, expected: FULL } },
    }));
    expectNames(short, { report: PLAIN, claim: PLAIN });
  });

  test("keeps Pass rate on every format, and names no suite", async () => {
    for (const format of SUPPORTED_BUNDLE_FORMATS) {
      const assets = buildPublicAssets(await goldenInput(format));
      const html = decode(assets["index.html"]);
      expect(html.split(`<th scope="col">${PLAIN}</th>`), format).toHaveLength(3);
      expect(decode(assets["README.md"]).split(`| ${PLAIN} |`), format).toHaveLength(3);
      for (const [name, bytes] of Object.entries(assets)) {
        expect(decode(bytes), `${format} ${name}`).not.toContain(ACCURACY);
        expect(decode(bytes), `${format} ${name}`).not.toContain(OVER_JUDGED);
      }
    }
  });
});
