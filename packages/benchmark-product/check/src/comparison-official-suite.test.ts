// SPDX-License-Identifier: Apache-2.0

/**
 * The Terminal-Bench 2.1 task-name projector (operator rulings of 2026-10-06, decision 7).
 *
 * The report page of a run brought onto the official Terminal-Bench 2.1 slate names each task by
 * its official name, says which dataset, revision and package it is, and shows each cell's
 * verdict and reward. Without the projector such a page labels every task by a digest and states
 * no score.
 *
 * The projector is keyed on the bundle's VERIFIED `terminalBench21Comparability` claim section,
 * handed to `derivePublicComparison` as `officialSuite`. It is not keyed on the Task's profile.
 * The page is byte-pinned to the reader a claim names, and a slate draft can be published in a
 * rollback format whose pinned reader predates the projector. A branch keyed on the profile would
 * move that page under a reader that cannot rebuild it. So a view derived without the section is
 * exactly the view derived before the projector existed, whatever profile its Tasks carry, and
 * the first block below pins that view literally.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { BenchmarkRecord, MatrixRecord } from "@jinn-network/benchmarking-records";
import { TASK_EXECUTION_PROTOCOL_URI, sealTask } from "@jinn-network/task-execution-protocol";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { derivePublicComparison, type DerivePublicComparisonInput, type PublicComparisonView } from "./comparison.js";
import { BUNDLE_V10_FORMAT, BUNDLE_V5_FORMAT, SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import {
  TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
  type ClaimTerminalBench21ComparabilitySection,
} from "./profile/terminal-bench-2-1-comparability.js";
import { TERMINAL_BENCH_21_PINS } from "./profile/terminal-bench-2-1-pins.js";
import type { BundleAssemblyCell } from "./schema.js";
import { goldenInput } from "./testing/golden-asset-input.js";

const decoder = new TextDecoder();
const decode = (bytes: Uint8Array | undefined): string => decoder.decode(bytes);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const digest = (fill: string): string => fill.repeat(64);

const PINS = TERMINAL_BENCH_21_PINS;
/** The profile the product core seals an official item under. The projector never reads it. */
const ITEM_PROFILE_URI = "https://product.jinn.network/profiles/terminal-bench-2-1-item/1";
const PACKAGE_REFS = {
  first: `sha256:${"ab12".repeat(16)}`,
  second: `sha256:${"cd34".repeat(16)}`,
} as const;
const REVISION_12 = PINS.datasetRevision.slice("sha256:".length, "sha256:".length + 12);

/** One official item, sealed through the platform as the product core seals it. */
function sealItem(taskName: unknown, packageRef: unknown = PACKAGE_REFS.first): { readonly bytes: Uint8Array; readonly sha256: string } {
  const bytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: { uri: ITEM_PROFILE_URI, digest: { sha256: digest("9") } },
    instructions: `Terminal-Bench 2.1 task ${String(taskName)} at dataset ${PINS.datasetId}@${PINS.datasetRevision}.`,
    payload: {
      datasetId: PINS.datasetId,
      datasetRevision: PINS.datasetRevision,
      upstreamCommit: PINS.upstreamCommit,
      ...(taskName === undefined ? {} : { taskName }),
      packageRef,
    },
    outputs: [{ name: "result", mediaType: "application/json", required: false }],
    author: "urn:jinn:benchmark-product:terminal-bench-2.1-official-slate",
  });
  return { bytes, sha256: sha256(bytes) };
}

const FIRST_NAME = PINS.tasks[0]!.name;
const SECOND_NAME = PINS.tasks[1]!.name;
const FIRST = sealItem(FIRST_NAME, PACKAGE_REFS.first);
const SECOND = sealItem(SECOND_NAME, PACKAGE_REFS.second);

/** The claim section a declaring bundle carries, as the checker projects it from a verified slate. */
const SECTION: ClaimTerminalBench21ComparabilitySection = {
  datasetId: PINS.datasetId,
  datasetRevision: PINS.datasetRevision,
  upstreamCommit: PINS.upstreamCommit,
  slateDigest: PINS.slateDigest,
  coverage: "custom",
  selectedTaskCount: 2,
  datasetTaskCount: PINS.datasetTaskCount,
  limit: TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
};

type Verdict = BundleAssemblyCell["verdicts"][number];
type Measurements = Verdict["measurements"];

let verdictCount = 0;
function verdict(outcome: Verdict["verdict"], measurements: Measurements, evalIndex = 1): Verdict {
  verdictCount += 1;
  return {
    sha256: verdictCount.toString(16).padStart(64, "0"),
    evalIndex,
    evaluator: `urn:colophon:evaluator:${evalIndex}`,
    verdict: outcome,
    evaluationSpecSha256: digest("e"),
    measurements,
  };
}

interface CellSpec {
  readonly task: { readonly sha256: string };
  readonly armId: string;
  readonly replicate?: number;
  readonly outcome?: MatrixRecord["cells"][number]["outcome"];
  readonly verdicts: readonly Verdict[];
  readonly outputs?: readonly { readonly name: string; readonly bytes: Uint8Array }[];
}

/** A comparison input over sealed Tasks: the Benchmark items, one Matrix cell and one assembly
 * cell per spec, and every record the cells name. */
function inputFor(
  tasks: readonly { readonly bytes: Uint8Array; readonly sha256: string }[],
  cells: readonly CellSpec[],
): DerivePublicComparisonInput {
  const recordBytes = new Map<string, Uint8Array>(tasks.map((task) => [task.sha256, task.bytes]));
  const assemblyCells: BundleAssemblyCell[] = [];
  const matrixCells: unknown[] = [];
  for (const cell of cells) {
    const replicate = cell.replicate ?? 1;
    const cellKey = `${cell.task.sha256}/${cell.armId}/${replicate}`;
    const solveOutputs = (cell.outputs ?? []).map((output) => {
      const outputSha256 = sha256(output.bytes);
      recordBytes.set(outputSha256, output.bytes);
      return { name: output.name, sha256: outputSha256 };
    });
    matrixCells.push({
      cellKey,
      taskDigest: cell.task.sha256,
      armId: cell.armId,
      replicate,
      outcome: cell.outcome ?? (cell.verdicts.length === 0 ? "unjudged" : "judged"),
    });
    assemblyCells.push({
      kind: "cell",
      cellKey,
      armId: cell.armId,
      replicate,
      taskDigest: cell.task.sha256,
      dispatches: 0,
      ...(solveOutputs.length === 0 ? {} : { solveOutputs }),
      verdicts: [...cell.verdicts],
    });
  }
  return {
    benchmark: {
      name: "terminal-bench-2.1",
      items: tasks.map((task) => ({ task: { digest: { sha256: task.sha256 } } })),
    } as unknown as BenchmarkRecord,
    matrix: { cells: matrixCells } as unknown as MatrixRecord,
    assemblyCells,
    recordBytes,
  };
}

/** Two tasks, two arms: the oracle passes both, the agent fails one and has no verdict on the other. */
function slateInput(): DerivePublicComparisonInput {
  return inputFor([FIRST, SECOND], [
    { task: FIRST, armId: "oracle", verdicts: [verdict("pass", { reward: 1 })] },
    { task: FIRST, armId: "terminus-2", verdicts: [verdict("fail", { reward: 0 })] },
    { task: SECOND, armId: "oracle", verdicts: [verdict("pass", { reward: 1 })] },
    { task: SECOND, armId: "terminus-2", verdicts: [] },
  ]);
}

const declared = (input: DerivePublicComparisonInput): PublicComparisonView =>
  derivePublicComparison({ ...input, officialSuite: SECTION });

/** The single cell of a one-cell input, derived with the section. */
function declaredCell(spec: Omit<CellSpec, "task" | "armId">): PublicComparisonView["cells"][number] {
  return declared(inputFor([FIRST], [{ task: FIRST, armId: "oracle", ...spec }])).cells[0]!;
}

const GENERIC_SUMMARY =
  "This task profile has no plain-language Colophon projector; verified identities and measurements remain available below.";
const NO_OUTPUT = "No solve output is present for this accounted cell.";
const SUITE_SUMMARY = (packageRef: string): string =>
  `Terminal-Bench 2.1 task; dataset terminal-bench/terminal-bench-2-1 at revision ${REVISION_12}; package ${packageRef.slice("sha256:".length, "sha256:".length + 12)}`;

/** The golden facts at one format, with the comparison view swapped for the one under test. */
async function pageInput(format: (typeof SUPPORTED_BUNDLE_FORMATS)[number], comparison: PublicComparisonView): Promise<PublicAssetInput> {
  return { ...(await goldenInput(format)), comparison } as PublicAssetInput;
}

const RENDERED_FORMATS = SUPPORTED_BUNDLE_FORMATS.filter((format) => format !== BUNDLE_V5_FORMAT);

describe("a view derived without the claim section is the view derived before the projector existed", () => {
  test("official-profile Tasks keep the digest label, the generic summary, and no score", () => {
    const input = slateInput();
    const view = derivePublicComparison(input);
    // `toStrictEqual`, so a new key on a task or a cell is a difference and not an ignored extra.
    expect(view).toStrictEqual({
      profile: "colophon-public-comparison/1",
      tasks: [FIRST, SECOND].map((task) => ({
        digest: task.sha256,
        profileUri: ITEM_PROFILE_URI,
        label: `Task ${task.sha256.slice(0, 12)}`,
        summary: GENERIC_SUMMARY,
        evidencePath: `records/${task.sha256}.bin`,
      })),
      arms: ["oracle", "terminus-2"],
      cells: input.assemblyCells.map((cell, index) => ({
        cellKey: cell.cellKey,
        taskDigest: cell.taskDigest,
        armId: cell.armId,
        replicate: 1,
        outcome: index === 3 ? "unjudged" : "judged",
        outputSummary: NO_OUTPUT,
        outputs: [],
        verdicts: cell.verdicts.map((entry) => ({
          evaluator: entry.evaluator,
          verdict: entry.verdict,
          measurements: entry.measurements,
          evidencePath: `records/${entry.sha256}.bin`,
        })),
        evidencePaths: [`records/${cell.taskDigest}.bin`, ...cell.verdicts.map((entry) => `records/${entry.sha256}.bin`)],
      })),
    });
  });

  test("an absent section and an undefined one derive the same view", () => {
    const input = slateInput();
    expect(derivePublicComparison({ ...input, officialSuite: undefined } as DerivePublicComparisonInput))
      .toStrictEqual(derivePublicComparison(input));
  });

  test("every format renders that view with the strings it rendered before", async () => {
    const view = derivePublicComparison(slateInput());
    const first12 = FIRST.sha256.slice(0, 12);
    for (const format of RENDERED_FORMATS) {
      const assets = buildPublicAssets(await pageInput(format, view));
      const html = decode(assets["index.html"]);
      expect(html, format).toContain(
        `<tr><th scope="row"><strong>Task ${first12}</strong><br><span class="source-label">${GENERIC_SUMMARY}</span></th>`,
      );
      expect(html, format).toContain(
        `<td><a href="index.html#cell-${FIRST.sha256}/oracle/1"><strong>${NO_OUTPUT}</strong><br>No primary score<br><span class="source-label">judged · replicate 1</span></a></td>`,
      );
      expect(html, format).toContain(
        `<summary><strong>oracle</strong> · Task ${first12} · replicate 1 · No primary score</summary>`,
      );
      const readme = decode(assets["README.md"]);
      expect(readme, format).toContain(`- **Task ${first12}** — ${GENERIC_SUMMARY}\n`);
      expect(readme, format).toContain(`  - **oracle**, replicate 1: ${NO_OUTPUT}; No primary score; outcome judged.`);
      for (const [name, bytes] of Object.entries(assets)) {
        expect(decode(bytes), `${format} ${name}`).not.toContain(FIRST_NAME);
        expect(decode(bytes), `${format} ${name}`).not.toContain("reward (higher-is-better)");
      }
    }
  });

  test("a stray section beside the view is not a declaration", async () => {
    // Only `derivePublicComparison`'s input turns the projector on. The asset builder reads the
    // view it is handed and nothing else, so a claim that carries the section over an unprojected
    // view renders that view unchanged.
    const view = derivePublicComparison(slateInput());
    const plain = await pageInput(BUNDLE_V10_FORMAT, view);
    const stray = { ...plain, claim: { ...plain.claim, terminalBench21Comparability: SECTION } } as PublicAssetInput;
    const before = decode(buildPublicAssets(plain)["index.html"]);
    const after = decode(buildPublicAssets(stray)["index.html"]);
    const section = (html: string): string => html.slice(html.indexOf('<section id="comparison"'), html.indexOf("</section>", html.indexOf('<section id="comparison"')));
    expect(section(after)).toBe(section(before));
  });
});

describe("with the verified claim section, each task is named", () => {
  test("the label is the official task name, and the summary names dataset, revision and package", () => {
    const view = declared(slateInput());
    expect(view.tasks).toStrictEqual([
      {
        digest: FIRST.sha256,
        profileUri: ITEM_PROFILE_URI,
        label: FIRST_NAME,
        summary: SUITE_SUMMARY(PACKAGE_REFS.first),
        evidencePath: `records/${FIRST.sha256}.bin`,
      },
      {
        digest: SECOND.sha256,
        profileUri: ITEM_PROFILE_URI,
        label: SECOND_NAME,
        summary: SUITE_SUMMARY(PACKAGE_REFS.second),
        evidencePath: `records/${SECOND.sha256}.bin`,
      },
    ]);
    expect(view.tasks[0]!.summary).toBe(
      "Terminal-Bench 2.1 task; dataset terminal-bench/terminal-bench-2-1 at revision 7d7bdc1cbeda; package ab12ab12ab12",
    );
  });

  test("the dataset and revision are the section's, which the checker has verified against its pins", () => {
    const view = derivePublicComparison({
      ...slateInput(),
      officialSuite: { ...SECTION, datasetId: "another/dataset", datasetRevision: `sha256:${digest("5")}` },
    });
    expect(view.tasks[0]!.summary).toBe(
      "Terminal-Bench 2.1 task; dataset another/dataset at revision 555555555555; package ab12ab12ab12",
    );
  });

  test("every cell carries its task's name for the cell heading", () => {
    const view = declared(slateInput());
    expect(view.cells.map((cell) => cell.taskLabel)).toEqual([FIRST_NAME, FIRST_NAME, SECOND_NAME, SECOND_NAME]);
  });

  test("the rest of the view is unchanged: arms, cell identities, outputs, verdicts and evidence paths", () => {
    const input = slateInput();
    const plain = derivePublicComparison(input);
    const view = declared(input);
    expect(view.profile).toBe(plain.profile);
    expect(view.arms).toStrictEqual(plain.arms);
    expect(view.sampleKind).toBeUndefined();
    expect(view.descriptiveComparison).toBeUndefined();
    for (const [index, cell] of view.cells.entries()) {
      const before = plain.cells[index]!;
      expect({
        cellKey: cell.cellKey,
        taskDigest: cell.taskDigest,
        armId: cell.armId,
        replicate: cell.replicate,
        outcome: cell.outcome,
        outputs: cell.outputs,
        verdicts: cell.verdicts,
        evidencePaths: cell.evidencePaths,
      }).toStrictEqual({
        cellKey: before.cellKey,
        taskDigest: before.taskDigest,
        armId: before.armId,
        replicate: before.replicate,
        outcome: before.outcome,
        outputs: before.outputs,
        verdicts: before.verdicts,
        evidencePaths: before.evidencePaths,
      });
    }
  });

  test("a Task with no task name cannot be projected under the section", () => {
    // A verified section means every item is a pinned official Task, and every one of those names
    // its task. A Task that does not is a caller holding a section that is not this bundle's.
    const nameless = sealItem(undefined);
    expect(() => declared(inputFor([nameless], []))).toThrow(TypeError);
    expect(() => declared(inputFor([nameless], []))).toThrow(/names no Terminal-Bench 2\.1 task/u);
    const numbered = sealItem(7);
    expect(() => declared(inputFor([numbered], []))).toThrow(/names no Terminal-Bench 2\.1 task/u);
    const unpackaged = sealItem(FIRST_NAME, 7);
    expect(() => declared(inputFor([unpackaged], []))).toThrow(/names no Terminal-Bench 2\.1 task/u);
  });
});

describe("with the verified claim section, each cell shows its verdict and its reward", () => {
  test("a pass at reward 1", () => {
    const cell = declaredCell({ verdicts: [verdict("pass", { reward: 1 })] });
    expect(cell.outputSummary).toBe("Verdict: pass");
    expect(cell.primaryScore).toStrictEqual({ name: "reward", value: "1", direction: "higher-is-better" });
  });

  test("a fail at reward 0", () => {
    const cell = declaredCell({ verdicts: [verdict("fail", { reward: 0 })] });
    expect(cell.outputSummary).toBe("Verdict: fail");
    expect(cell.primaryScore).toStrictEqual({ name: "reward", value: "0", direction: "higher-is-better" });
  });

  test("a fractional reward is sealed as a decimal string and shown as written", () => {
    const cell = declaredCell({ verdicts: [verdict("inconclusive", { reward: "0.5" })] });
    expect(cell.outputSummary).toBe("Verdict: inconclusive");
    expect(cell.primaryScore).toStrictEqual({ name: "reward", value: "0.5", direction: "higher-is-better" });
    expect(declaredCell({ verdicts: [verdict("inconclusive", { reward: "-0.25" })] }).primaryScore?.value).toBe("-0.25");
    expect(declaredCell({ verdicts: [verdict("inconclusive", { reward: "9007199254740992" })] }).primaryScore?.value)
      .toBe("9007199254740992");
  });

  test("verdicts that agree on the verdict and the reward state both once", () => {
    const cell = declaredCell({ verdicts: [verdict("pass", { reward: 1 }, 1), verdict("pass", { reward: 1 }, 2)] });
    expect(cell.outputSummary).toBe("Verdict: pass");
    expect(cell.primaryScore).toStrictEqual({ name: "reward", value: "1", direction: "higher-is-better" });
  });

  test("verdicts that disagree are listed in sealed order, and no reward is the cell's score", () => {
    const cell = declaredCell({ verdicts: [verdict("pass", { reward: 1 }, 1), verdict("fail", { reward: 0 }, 2)] });
    expect(cell.outputSummary).toBe("Verdicts disagree: pass, fail");
    expect(cell.primaryScore).toBeUndefined();
  });

  test("the same verdict over different rewards states the verdict and no score", () => {
    const cell = declaredCell({ verdicts: [verdict("inconclusive", { reward: "0.5" }, 1), verdict("inconclusive", { reward: "0.25" }, 2)] });
    expect(cell.outputSummary).toBe("Verdict: inconclusive");
    expect(cell.primaryScore).toBeUndefined();
    // The number 1 and the string "1" are two sealed values, not one reward the verdicts agree on.
    expect(declaredCell({ verdicts: [verdict("pass", { reward: 1 }, 1), verdict("pass", { reward: "1" }, 2)] }).primaryScore)
      .toBeUndefined();
  });

  test("a verdict with no reward, or a reward in neither sealed form, states no score", () => {
    // A sealed reward is a safe integer or a plain decimal string. A sealed record cannot carry a
    // fractional number or one past 2^53 - 1, so neither is read as a reward here.
    const notRewards = [
      {}, { score: 1 }, { reward: true }, { reward: "" }, { reward: "banana" }, { reward: "1e3" }, { reward: " 1" },
      { reward: "1." }, { reward: ".5" }, { reward: 0.5 }, { reward: 2 ** 53 },
    ] as Measurements[];
    for (const measurements of notRewards) {
      const cell = declaredCell({ verdicts: [verdict("pass", measurements)] });
      expect(cell.outputSummary, JSON.stringify(measurements)).toBe("Verdict: pass");
      expect(cell.primaryScore, JSON.stringify(measurements)).toBeUndefined();
    }
    // One verdict with a reward and one without is not agreement either.
    expect(declaredCell({ verdicts: [verdict("pass", { reward: 1 }, 1), verdict("pass", {}, 2)] }).primaryScore).toBeUndefined();
  });

  test("a cell with no verdict keeps the generic text and states no score", () => {
    const bare = declaredCell({ verdicts: [] });
    expect(bare.outputSummary).toBe(NO_OUTPUT);
    expect(bare.primaryScore).toBeUndefined();
    const bytes = new TextEncoder().encode('{"status":"finished"}');
    const delivered = declaredCell({ verdicts: [], outputs: [{ name: "trial-result.json", bytes }] });
    expect(delivered.outputSummary).toBe(`trial-result.json — ${bytes.length} authenticated bytes`);
    expect(delivered.primaryScore).toBeUndefined();
  });

  test("a judged cell still lists its outputs, with the verdict as its summary", () => {
    const bytes = new TextEncoder().encode("1\n");
    const cell = declaredCell({ verdicts: [verdict("pass", { reward: 1 })], outputs: [{ name: "reward.txt", bytes }] });
    expect(cell.outputSummary).toBe("Verdict: pass");
    expect(cell.outputs).toStrictEqual([{
      name: "reward.txt",
      sha256: sha256(bytes),
      summary: "reward.txt — 2 authenticated bytes",
      evidencePath: `records/${sha256(bytes)}.bin`,
    }]);
  });
});

describe("the page of a declaring bundle", () => {
  test("index.html names the task, states the verdict and the reward, and heads each cell with the task name", async () => {
    const html = decode(buildPublicAssets(await pageInput(BUNDLE_V10_FORMAT, declared(slateInput())))["index.html"]);
    expect(html).toContain(
      `<tr><th scope="row"><strong>${FIRST_NAME}</strong><br><span class="source-label">${SUITE_SUMMARY(PACKAGE_REFS.first)}</span></th>`,
    );
    expect(html).toContain(
      `<td><a href="index.html#cell-${FIRST.sha256}/oracle/1"><strong>Verdict: pass</strong><br>1 reward (higher-is-better)<br><span class="source-label">judged · replicate 1</span></a></td>`,
    );
    expect(html).toContain(
      `<td><a href="index.html#cell-${FIRST.sha256}/terminus-2/1"><strong>Verdict: fail</strong><br>0 reward (higher-is-better)<br><span class="source-label">judged · replicate 1</span></a></td>`,
    );
    expect(html).toContain(
      `<td><a href="index.html#cell-${SECOND.sha256}/terminus-2/1"><strong>${NO_OUTPUT}</strong><br>No primary score<br><span class="source-label">unjudged · replicate 1</span></a></td>`,
    );
    expect(html).toContain(
      `<summary><strong>oracle</strong> · ${FIRST_NAME} · replicate 1 · 1 reward (higher-is-better)</summary>`,
    );
    expect(html).toContain(
      `<summary><strong>terminus-2</strong> · ${SECOND_NAME} · replicate 1 · No primary score</summary>`,
    );
    // No task on this page is labelled by its digest, in the table or in a cell heading.
    expect(html).not.toContain(`Task ${FIRST.sha256.slice(0, 12)}`);
    expect(html).not.toContain(`Task ${SECOND.sha256.slice(0, 12)}`);
    expect(html).not.toContain(GENERIC_SUMMARY);
  });

  test("README.md carries the same names, verdicts and rewards", async () => {
    const readme = decode(buildPublicAssets(await pageInput(BUNDLE_V10_FORMAT, declared(slateInput())))["README.md"]);
    expect(readme).toContain(`- **${FIRST_NAME}** — ${SUITE_SUMMARY(PACKAGE_REFS.first)}\n`);
    expect(readme).toContain("  - **oracle**, replicate 1: Verdict: pass; 1 reward \\(higher-is-better\\); outcome judged.");
    expect(readme).toContain("  - **terminus-2**, replicate 1: Verdict: fail; 0 reward \\(higher-is-better\\); outcome judged.");
    expect(readme).not.toContain(GENERIC_SUMMARY);
  });

  test("the comparison section is the only part of the page the projector moves", async () => {
    const input = slateInput();
    const plain = buildPublicAssets(await pageInput(BUNDLE_V10_FORMAT, derivePublicComparison(input)));
    const named = buildPublicAssets(await pageInput(BUNDLE_V10_FORMAT, declared(input)));
    const outside = (html: string): string => {
      const start = html.indexOf('<section id="comparison"');
      return html.slice(0, start) + html.slice(html.indexOf("</section>", start));
    };
    expect(outside(decode(named["index.html"]))).toBe(outside(decode(plain["index.html"])));
    expect(decode(named["index.html"])).not.toBe(decode(plain["index.html"]));
    // The badge, the social card and the share text carry no task and no score.
    for (const name of ["badge.svg", "social-card.svg", "share.txt"]) expect(named[name], name).toEqual(plain[name]);
  });

  test("a hostile task name is escaped on the page and in the README, and bounded", async () => {
    // The checker admits a section only over the pinned official Tasks, so this name cannot reach a
    // verified page. The projector still never prints a Task string raw.
    const hostileName = '<img src=x onerror=alert(1)> "q" \'s\' & **b** [l](http://e.example) `c`\u0007';
    const hostile = sealItem(hostileName);
    const view = declared(inputFor([hostile], [{ task: hostile, armId: "oracle", verdicts: [verdict("pass", { reward: 1 })] }]));
    const assets = buildPublicAssets(await pageInput(BUNDLE_V10_FORMAT, view));
    const html = decode(assets["index.html"]);
    const escaped = "&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &#39;s&#39; &amp; **b** [l](http://e.example) `c`";
    expect(html).toContain(`<tr><th scope="row"><strong>${escaped}</strong><br>`);
    expect(html).toContain(`<summary><strong>oracle</strong> · ${escaped} · replicate 1 · 1 reward (higher-is-better)</summary>`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("\u0007");
    const readme = decode(assets["README.md"]);
    expect(readme).toContain("- **&lt;img src=x onerror=alert\\(1\\)&gt; \"q\" 's' & \\*\\*b\\*\\* \\[l\\]\\(http\\://e.example\\) \\`c\\`** — ");
    expect(readme).not.toContain("<img");
    expect(readme).not.toContain("**b**");
    expect(readme).not.toContain("[l](http://e.example)");

    const long = sealItem("n".repeat(400));
    const bounded = declared(inputFor([long], [{ task: long, armId: "oracle", verdicts: [] }]));
    expect(Array.from(bounded.tasks[0]!.label)).toHaveLength(180);
    expect(bounded.tasks[0]!.label.endsWith("…")).toBe(true);
    expect(bounded.cells[0]!.taskLabel).toBe(bounded.tasks[0]!.label);
  });

  test("a hostile reward is never the score", async () => {
    const view = declared(inputFor([FIRST], [{ task: FIRST, armId: "oracle", verdicts: [verdict("pass", { reward: "<script>x</script>" })] }]));
    expect(view.cells[0]!.primaryScore).toBeUndefined();
    const html = decode(buildPublicAssets(await pageInput(BUNDLE_V10_FORMAT, view))["index.html"]);
    expect(html).not.toContain("<script>x</script>");
  });
});
