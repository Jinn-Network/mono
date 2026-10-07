// SPDX-License-Identifier: Apache-2.0

/**
 * How much of the dataset a run brought onto the official Terminal-Bench 2.1 slate covers, stated
 * in words on the report face (issue #4972).
 *
 * The page of such a run names each task and prints the comparability sentence, but the count of
 * the dataset's tasks it carries was only in `claim-package.json`
 * (`terminalBench21Comparability.selectedTaskCount` and `datasetTaskCount`). A reader of a
 * three-task page had no readable line saying the dataset has 89.
 *
 * The line is a header fact, under the scope line and so above every rate. It is projected from
 * the bundle's VERIFIED `terminalBench21Comparability` claim section and from nothing else, as the
 * rate name and the task-name projector are. Every page without the section renders exactly what
 * it did: every earlier format, and every `/10` bundle that does not declare the capability.
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

/** The claim section a declaring bundle carries, as the checker projects it from a verified slate. */
function section(selectedTaskCount: number, datasetTaskCount: number = FULL): ClaimTerminalBench21ComparabilitySection {
  return {
    datasetId: PINS.datasetId,
    datasetRevision: PINS.datasetRevision,
    upstreamCommit: PINS.upstreamCommit,
    slateDigest: PINS.slateDigest,
    coverage: selectedTaskCount === datasetTaskCount ? "full" : "custom",
    selectedTaskCount,
    datasetTaskCount,
    limit: TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
  };
}

async function declaring(claimSection: ClaimTerminalBench21ComparabilitySection): Promise<PublicAssetInput> {
  const input = await goldenInput(BUNDLE_V10_FORMAT);
  return { ...input, claim: { ...input.claim, terminalBench21Comparability: claimSection } } as PublicAssetInput;
}

const htmlRow = (value: string): string => `\n<dl class="facts"><div><dt>Tasks</dt><dd>${value}</dd></div></dl>`;
const textLine = (value: string): string => `Tasks: ${value}.`;

const SLICE = "10 of the 89 in Terminal-Bench 2.1";
const WHOLE = "all 89 in Terminal-Bench 2.1";

describe("the dataset coverage line of a page whose claim carries the Terminal-Bench 2.1 section", () => {
  test("index.html states a slice in the header, under the scope line and above every rate", async () => {
    const html = decode(buildPublicAssets(await declaring(section(10)))["index.html"]);
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    expect(header).toContain(`</p>${htmlRow(SLICE)}\n<p class="neutral">`);
    expect(header.indexOf(htmlRow(SLICE))).toBeGreaterThan(header.indexOf('<p class="lede">'));
    expect(html.split("in Terminal-Bench 2.1</dd>")).toHaveLength(2);
    expect(html.indexOf(htmlRow(SLICE))).toBeLessThan(html.indexOf("Pass rate over judged cells"));
  });

  test("README.md states it beside the scope line, above every rate", async () => {
    const readme = decode(buildPublicAssets(await declaring(section(10)))["README.md"]);
    expect(readme).toMatch(/\nScope: [^\n]+\.\n\nTasks: 10 of the 89 in Terminal-Bench 2\.1\.\n\nReport SHA-256: /u);
    expect(readme.split("in Terminal-Bench 2.1.")).toHaveLength(2);
    expect(readme.indexOf(textLine(SLICE))).toBeLessThan(readme.indexOf("Pass rate over judged cells"));
  });

  test("share.txt states it directly after the scope", async () => {
    const share = decode(buildPublicAssets(await declaring(section(10)))["share.txt"]);
    expect(share).toMatch(/ replicates · self-run\. Tasks: 10 of the 89 in Terminal-Bench 2\.1\. /u);
    expect(share.split("in Terminal-Bench 2.1.")).toHaveLength(2);
  });

  test("a run that carries every task of the dataset says all of them", async () => {
    const assets = buildPublicAssets(await declaring(section(FULL)));
    expect(decode(assets["index.html"])).toContain(htmlRow(WHOLE));
    expect(decode(assets["README.md"])).toContain(`\n\n${textLine(WHOLE)}\n\n`);
    expect(decode(assets["share.txt"])).toContain(` ${textLine(WHOLE)} `);
    for (const name of ["index.html", "README.md", "share.txt"]) {
      expect(decode(assets[name]), name).not.toContain("89 of the 89");
    }
  });

  test("a one-task run says one of them", async () => {
    const assets = buildPublicAssets(await declaring(section(1)));
    expect(decode(assets["index.html"])).toContain(htmlRow("1 of the 89 in Terminal-Bench 2.1"));
    expect(decode(assets["README.md"])).toContain(textLine("1 of the 89 in Terminal-Bench 2.1"));
    expect(decode(assets["share.txt"])).toContain(textLine("1 of the 89 in Terminal-Bench 2.1"));
  });

  test("both numbers are the section's, not the scope line's and not a constant", async () => {
    // The golden claim's own scope counts another number of tasks. The line does not read it.
    const input = await declaring(section(7, 40));
    expect(input.claim.scope.taskCount).not.toBe(7);
    const assets = buildPublicAssets(input);
    expect(decode(assets["index.html"])).toContain(htmlRow("7 of the 40 in Terminal-Bench 2.1"));
    expect(decode(assets["README.md"])).toContain(textLine("7 of the 40 in Terminal-Bench 2.1"));
    expect(decode(assets["share.txt"])).toContain(textLine("7 of the 40 in Terminal-Bench 2.1"));
    const whole = buildPublicAssets(await declaring(section(40, 40)));
    expect(decode(whole["index.html"])).toContain(htmlRow("all 40 in Terminal-Bench 2.1"));
  });

  test("it stands above the task-selection fact when a page carries both", async () => {
    const input = await declaring(section(10));
    const both = buildPublicAssets({
      ...input,
      claim: { ...input.claim, taskSelection: { mode: "claimant-chosen" } },
    } as PublicAssetInput);
    expect(decode(both["index.html"])).toContain(
      `</p>${htmlRow(SLICE)}\n<dl class="facts"><div><dt>Task selection</dt><dd>claimant-chosen</dd></div></dl>\n<p class="neutral">`,
    );
    expect(decode(both["README.md"])).toContain(`\n\n${textLine(SLICE)}\n\nTask selection: claimant-chosen.\n\n`);
    expect(decode(both["share.txt"])).toContain(` ${textLine(SLICE)} Task selection: claimant-chosen. `);
  });

  test("the badge and the social card do not move", async () => {
    const plain = buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT));
    const assets = buildPublicAssets(await declaring(section(10)));
    expect(assets["badge.svg"]).toEqual(plain["badge.svg"]);
    expect(assets["social-card.svg"]).toEqual(plain["social-card.svg"]);
  });
});

describe("a page whose claim carries no Terminal-Bench 2.1 section", () => {
  test("carries no coverage line, on any format", async () => {
    for (const format of SUPPORTED_BUNDLE_FORMATS) {
      const assets = buildPublicAssets(await goldenInput(format));
      for (const [name, bytes] of Object.entries(assets)) {
        expect(decode(bytes), `${format} ${name}`).not.toContain("in Terminal-Bench 2.1");
        expect(decode(bytes), `${format} ${name}`).not.toContain("<dt>Tasks</dt><dd>all ");
        expect(decode(bytes), `${format} ${name}`).not.toMatch(/Tasks: (all )?\d+ /u);
      }
    }
  });

  test("a stray top-level section is not a declaration", async () => {
    // Only the verified claim section renders. A caller that passes one beside the claim gets the
    // page of a bundle that declared nothing.
    const plain = buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT));
    const stray = buildPublicAssets({
      ...(await goldenInput(BUNDLE_V10_FORMAT)),
      terminalBench21Comparability: section(10),
    } as unknown as PublicAssetInput);
    for (const [name, bytes] of Object.entries(plain)) expect(stray[name], name).toEqual(bytes);
  });
});
