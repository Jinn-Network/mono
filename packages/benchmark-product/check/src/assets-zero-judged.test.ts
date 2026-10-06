// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #4939: an arm none of whose cells entered the rate states no rate (operator rulings of
 * 2026-10-06, decision 6, option c).
 *
 * `wilson@1` seals a `passRate` of `0.0000` and an interval of `0.0000` to `0.0000` for an arm
 * with `n` 0, because the claim package schema requires the strings. Printed as they are sealed,
 * they read as "failed every task, with certainty" about an arm that was never scored. The ruling
 * keeps the sealed values and changes only what is shown: the page and the claim text say that no
 * rate is stated for that arm.
 *
 * The wording is the `/10` presentation capability `zero-judged-rate-unstated`. It is format-level,
 * not a declared capability, so it reaches every `/10` page with such an arm. That is deliberate:
 * the ruling covers every run, and no `/10` bundle has been published. It must not reach any format
 * allocated before `/10`, whose pages are byte-pinned to readers that print the sealed strings.
 *
 * The digests pinned at the bottom were measured before the capability existed.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { BUNDLE_FORMAT } from "./legacy-closures.js";
import { BUNDLE_V10_FORMAT, SUPPORTED_BUNDLE_FORMATS, type SupportedBundleFormat } from "./manifest.js";
import { goldenInput } from "./testing/golden-asset-input.js";

const decoder = new TextDecoder();
const decode = (bytes: Uint8Array | undefined): string => decoder.decode(bytes);
const sha256 = (bytes: Uint8Array | undefined): string => createHash("sha256").update(bytes!).digest("hex");

/** Every format allocated before `/10`. Their pages must not move. */
const EARLIER_FORMATS = SUPPORTED_BUNDLE_FORMATS.filter((format) => format !== BUNDLE_V10_FORMAT);

/** One arm of a `wilson@1` Report: the cells that entered its rate, and the slots it planned. */
interface ArmFacts {
  readonly n: number;
  readonly expected: number;
}

/** What `wilson@1` seals. The zero row is the degenerate result issue #4939 reports. */
const SEALED_ZERO = { passRate: "0.0000", wilsonInterval: { low: "0.0000", high: "0.0000" } };
const SEALED_RATE = { passRate: "1.0000", wilsonInterval: { low: "0.4385", high: "1.0000" } };

function wilsonResults(matrixSha256: string, arms: Readonly<Record<string, ArmFacts>>): unknown {
  return {
    perSubject: [{
      subjectSha256: matrixSha256,
      results: {
        arms: Object.fromEntries(Object.entries(arms).map(([armId, arm]) =>
          [armId, { n: arm.n, ...(arm.n === 0 ? SEALED_ZERO : SEALED_RATE) }])),
        conflicted: { count: 0, cellKeys: [] },
        verdictRule: "sole",
      },
    }],
  };
}

/**
 * The golden bundle's verified facts with the per-arm results and accounting replaced. `claimArms`
 * lets the stored claim disagree with the sealed Report, which no verified bundle does and which
 * the two tables must still render independently.
 */
async function withArms(
  format: SupportedBundleFormat,
  arms: Readonly<Record<string, ArmFacts>>,
  claimArms: Readonly<Record<string, ArmFacts>> = arms,
): Promise<PublicAssetInput> {
  const base = await goldenInput(format);
  const accounting = (source: Readonly<Record<string, ArmFacts>>) => {
    const expected = Object.values(source).reduce((total, arm) => total + arm.expected, 0);
    const judged = Object.values(source).reduce((total, arm) => total + arm.n, 0);
    return {
      completeness: { expected, judged, floor: "1", runOutcome: judged === expected ? "complete" : "partial" },
      attrition: {
        asymmetryFlags: [],
        perArm: Object.fromEntries(Object.entries(source).map(([armId, arm]) => [armId, {
          expected: arm.expected,
          judged: arm.n,
          unjudged: 0,
          unscorable: arm.expected - arm.n,
          expired: 0,
          invalidated: 0,
          excluded: 0,
          replacements: 0,
        }])),
      },
    };
  };
  return {
    ...base,
    matrix: { ...base.matrix, ...accounting(arms) },
    report: { ...base.report, results: wilsonResults(base.matrixSha256, arms) },
    claim: { ...base.claim, ...accounting(claimArms), results: wilsonResults(base.matrixSha256, claimArms) },
  } as unknown as PublicAssetInput;
}

const ONE_ARM_AT_ZERO = { baseline: { n: 0, expected: 3 }, "sample-uniform": { n: 3, expected: 3 } } as const;
const BOTH_ARMS_AT_ZERO = { baseline: { n: 0, expected: 3 }, "sample-uniform": { n: 0, expected: 3 } } as const;

const unstated = (armId: string): string =>
  `No rate is stated for arm ${armId}: none of its cells reached a pass or fail verdict.`;

function htmlTable(html: string, caption: string): string {
  const start = html.indexOf(caption);
  expect(start, `the page renders ${caption}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</table>", start));
}
const reportTable = (html: string): string => htmlTable(html, "Exact wilson@1 values from the sealed Report");
const claimTable = (html: string): string => htmlTable(html, "Exact arm values stored in the Claim package");

function readmeSection(readme: string, heading: string, next: string): string {
  const start = readme.indexOf(heading);
  expect(start, `README has ${heading}`).toBeGreaterThan(-1);
  return readme.slice(start, readme.indexOf(next, start));
}
const reportReadme = (readme: string): string =>
  readmeSection(readme, "## Sealed Report facts", "### Report method and preregistration");
const claimReadme = (readme: string): string =>
  readmeSection(readme, "## Stored Claim facts", "### Claim method and preregistration");

const adverseHtml = (html: string): string => {
  const start = html.indexOf('<section class="adverse"');
  return html.slice(start, html.indexOf("</section>", start));
};

describe("a /10 page states no rate for an arm with judged n 0", () => {
  const ZERO_ROW =
    '<th scope="row">baseline</th><td>0</td><td>3</td><td>3</td><td>No rate is stated</td><td>Not stated</td><td>Not stated</td></tr>';
  const SCORED_ROW =
    '<th scope="row">sample-uniform</th><td>3</td><td>3</td><td>0</td><td>1.0000</td><td>0.4385</td><td>1.0000</td></tr>';

  test("the Report table and the Claim table print no rate and no interval bound for it", async () => {
    const html = decode(buildPublicAssets(await withArms(BUNDLE_V10_FORMAT, ONE_ARM_AT_ZERO))["index.html"]);
    for (const table of [reportTable(html), claimTable(html)]) {
      expect(table).toContain(ZERO_ROW);
      // The arm that was scored keeps its sealed strings.
      expect(table).toContain(SCORED_ROW);
      expect(table).not.toContain("0.0000");
    }
  });

  test("README.md prints the same in both tables", async () => {
    const readme = decode(buildPublicAssets(await withArms(BUNDLE_V10_FORMAT, ONE_ARM_AT_ZERO))["README.md"]);
    for (const section of [reportReadme(readme), claimReadme(readme)]) {
      expect(section).toContain("| baseline | 0 | 3 | 3 | No rate is stated | Not stated | Not stated |");
      expect(section).toContain("| sample-uniform | 3 | 3 | 0 | 1.0000 | 0.4385 | 1.0000 |");
    }
  });

  test("one adverse fact names the arm, on the page and in README.md", async () => {
    const assets = buildPublicAssets(await withArms(BUNDLE_V10_FORMAT, ONE_ARM_AT_ZERO));
    const html = decode(assets["index.html"]);
    expect(adverseHtml(html)).toContain(
      `<li>Matrix: Partial comparison; incomplete cells remain accounted below.</li><li>${unstated("baseline")}</li>`,
    );
    expect(html.split("No rate is stated for arm")).toHaveLength(2);
    const readme = decode(assets["README.md"]);
    expect(readme).toContain(
      `## Prominent adverse facts\n\n- Matrix: Partial comparison; incomplete cells remain accounted below.\n- ${unstated("baseline")}\n`,
    );
    expect(readme.split("No rate is stated for arm")).toHaveLength(2);
  });

  test("share.txt carries the same clause, and it is the only change to it", async () => {
    const earlier = decode(buildPublicAssets(await withArms(BUNDLE_FORMAT, ONE_ARM_AT_ZERO))["share.txt"]);
    const share = decode(buildPublicAssets(await withArms(BUNDLE_V10_FORMAT, ONE_ARM_AT_ZERO))["share.txt"]);
    expect(share).toMatch(/ Claim limitations \d+\. No rate is stated for arm baseline: none of its cells reached a pass or fail verdict\. Report [a-f0-9]{64}\. /u);
    expect(share.replace(` ${unstated("baseline")}`, "")).toBe(earlier);
    expect(share.endsWith("\n")).toBe(true);
    expect(share.trimEnd()).not.toContain("\n");
  });

  test("the badge and the social card do not move", async () => {
    // Neither carries a rate. Both are format-independent, so the earlier format's bytes are the
    // comparison: an asset that moved under `/10` would differ from them.
    const earlier = buildPublicAssets(await withArms(BUNDLE_FORMAT, ONE_ARM_AT_ZERO));
    const composed = buildPublicAssets(await withArms(BUNDLE_V10_FORMAT, ONE_ARM_AT_ZERO));
    expect(decode(composed["badge.svg"])).toBe(decode(earlier["badge.svg"]));
    expect(decode(composed["social-card.svg"])).toBe(decode(earlier["social-card.svg"]));
    for (const name of ["badge.svg", "social-card.svg"]) {
      expect(decode(composed[name]), name).not.toContain("No rate is stated");
    }
  });

  test("every arm at zero is stated, one line and one clause each, in the Report's arm order", async () => {
    const assets = buildPublicAssets(await withArms(BUNDLE_V10_FORMAT, BOTH_ARMS_AT_ZERO));
    const html = decode(assets["index.html"]);
    expect(adverseHtml(html)).toContain(`<li>${unstated("baseline")}</li><li>${unstated("sample-uniform")}</li>`);
    for (const table of [reportTable(html), claimTable(html)]) {
      expect(table.split("<td>No rate is stated</td><td>Not stated</td><td>Not stated</td>")).toHaveLength(3);
    }
    expect(decode(assets["README.md"])).toContain(`- ${unstated("baseline")}\n- ${unstated("sample-uniform")}\n`);
    expect(decode(assets["share.txt"])).toContain(`. ${unstated("baseline")} ${unstated("sample-uniform")} Report `);
  });

  test("an arm with judged n 1 keeps its sealed rate and interval", async () => {
    const assets = buildPublicAssets(await withArms(BUNDLE_V10_FORMAT, {
      baseline: { n: 1, expected: 3 },
      "sample-uniform": { n: 3, expected: 3 },
    }));
    const html = decode(assets["index.html"]);
    expect(reportTable(html)).toContain(
      '<th scope="row">baseline</th><td>1</td><td>3</td><td>2</td><td>1.0000</td><td>0.4385</td><td>1.0000</td></tr>',
    );
    for (const name of Object.keys(assets)) expect(decode(assets[name]), name).not.toContain("No rate is stated");
  });

  test("each table reads its own source", async () => {
    // No verified bundle carries a claim that disagrees with its Report. The two tables are still
    // rendered from two records, and a mirror that could not disagree would prove nothing.
    const scored = { baseline: { n: 3, expected: 3 }, "sample-uniform": { n: 3, expected: 3 } };
    const claimAtZero = decode(buildPublicAssets(await withArms(BUNDLE_V10_FORMAT, scored, ONE_ARM_AT_ZERO))["index.html"]);
    expect(reportTable(claimAtZero)).not.toContain("No rate is stated");
    expect(claimTable(claimAtZero)).toContain(ZERO_ROW);
    const reportAtZero = decode(buildPublicAssets(await withArms(BUNDLE_V10_FORMAT, ONE_ARM_AT_ZERO, scored))["index.html"]);
    expect(reportTable(reportAtZero)).toContain(ZERO_ROW);
    expect(claimTable(reportAtZero)).not.toContain("No rate is stated");
  });

  test("an arm id is escaped in the adverse fact like every other rendered fact", async () => {
    const hostile = "<script>x</script>";
    const assets = buildPublicAssets(await withArms(BUNDLE_V10_FORMAT, { [hostile]: { n: 0, expected: 3 } }));
    const html = decode(assets["index.html"]);
    expect(html).toContain("<li>No rate is stated for arm &lt;script&gt;x&lt;/script&gt;: none of its cells reached a pass or fail verdict.</li>");
    expect(html).not.toContain(hostile);
    expect(decode(assets["README.md"])).toContain("- No rate is stated for arm &lt;script&gt;x&lt;/script&gt;: none of its cells reached a pass or fail verdict.");
  });
});

describe("no format allocated before /10 moves", () => {
  test("an arm with judged n 0 still prints its sealed strings there, in every asset", async () => {
    const baseline = buildPublicAssets(await withArms(BUNDLE_FORMAT, ONE_ARM_AT_ZERO));
    for (const format of EARLIER_FORMATS) {
      const assets = buildPublicAssets(await withArms(format, ONE_ARM_AT_ZERO));
      for (const [name, bytes] of Object.entries(baseline)) {
        expect(decode(assets[name]), `${format} ${name}`).toBe(decode(bytes));
        expect(decode(assets[name]), `${format} ${name}`).not.toContain("No rate is stated");
      }
      expect(reportTable(decode(assets["index.html"])), format).toContain(
        '<th scope="row">baseline</th><td>0</td><td>0.0000</td><td>0.0000</td><td>0.0000</td></tr>',
      );
      expect(decode(assets["README.md"]), format).toContain("| baseline | 0 | 0.0000 | 0.0000 | 0.0000 |");
    }
  });

  test("those bytes are the ones rendered before the capability existed", async () => {
    const assets = buildPublicAssets(await withArms(BUNDLE_FORMAT, ONE_ARM_AT_ZERO));
    expect(Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, sha256(bytes)]))).toEqual(
      ZERO_JUDGED_V2_ASSET_SHA256,
    );
  });
});

describe("a /10 page with no such arm does not move", () => {
  test("the golden facts render the bytes they rendered before the capability existed", async () => {
    const assets = buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT));
    expect(Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, sha256(bytes)]))).toEqual(
      GOLDEN_V10_ASSET_SHA256,
    );
    for (const name of Object.keys(assets)) expect(decode(assets[name]), name).not.toContain("No rate is stated");
  });
});

/** `/2` assets for `ONE_ARM_AT_ZERO`, measured on the commit before `zero-judged-rate-unstated`. */
const ZERO_JUDGED_V2_ASSET_SHA256: Readonly<Record<string, string>> = {
  "README.md": "199cff24f68dc36a76902a5fb71ec0e3aa4f2914f3245f6b80c7e2c6da2f9970",
  "badge.svg": "b03190abe7071f47186d37418f1a34b44cb319f70d19c98b10797fb7aef7bca3",
  "index.html": "f55383f69166ab3293f3b4173cba70954333e1e3d48791a15aa4ad2b70ca0948",
  "share.txt": "9770d84e2d0989f81521ea8580864a7fd9b97cfc7c09f5e65160f73847c12013",
  "social-card.svg": "e1abd1f901e3e3ff5c1d6f963f3416ac17720245ab4b0ca4b660c455f4b397be",
};

/** `/10` assets for the golden facts, measured on the commit before `zero-judged-rate-unstated`. */
const GOLDEN_V10_ASSET_SHA256: Readonly<Record<string, string>> = {
  "README.md": "2611863d1762ebadd75625b5bee5c7851d8746637d2fc4a9445eddf749b5e546",
  "badge.svg": "030c5f09198857deae3e48367a5ad119f493bf93e88049e08ceb672b8fc16a4b",
  "index.html": "1ce09781b9741489a2d3c067ae503a79cd78738bb37cbb28eebbf98fe3d8570e",
  "share.txt": "a6fdc31f6db9568189569b3b8084a56545d57796ab127c531a62256575be92d5",
  "social-card.svg": "e073b7597569808e32e068a951840384119c2ce90992ca16b341b24354143f15",
};
