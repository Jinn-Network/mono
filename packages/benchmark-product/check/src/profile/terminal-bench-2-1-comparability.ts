// SPDX-License-Identifier: Apache-2.0

/**
 * The `/10` capability `terminal-bench-2-1-comparability`: the sealed sentence a run brought onto
 * the official Terminal-Bench 2.1 slate carries, its claim section, and the checks that hold both
 * to the bundle's own records (operator rulings of 2026-10-06, decisions 2 and 7).
 *
 * A run made outside this product and imported from a Harbor jobs directory cannot show that it
 * met the leaderboard's protocol: this product did not run it, and no record in the bundle
 * establishes the conditions it ran under. So every such run says so, in one sealed text, in its
 * signed Report limitations. The same text states how the rate is taken, because a trial with no
 * reward is left out of the rate here and counted as 0 by Harbor's own mean.
 *
 * What makes a bundle "on the official slate" is not its say-so. The Benchmark carries an
 * `official-suite-slate/v1` extension, and this module checks that extension against the slate the
 * checker pins (`terminal-bench-2-1-pins.ts`): the dataset constants, the selected names, the
 * recomputed coverage word, and, item by item, the pinned Task digest of the task each item names.
 * A Task digest covers the Task's profile, payload, instructions, author, and outputs, so a bundle
 * cannot wear the suite's name over Tasks that are not the official ones.
 *
 * The capability is bound both ways, like `task-selection` and `owner-controlled-publication`:
 *
 * - extension and import without the token is refused, so no bundle passes while leaving the
 *   sentence out;
 * - the token without the extension, the sentence without the token, and the token without the
 *   sentence in its slot are each refused.
 *
 * The wording is spelled once, here, and the product core imports it: the producer's sealed copy
 * and the verifier's rebuild have to be the same bytes. The token is named for this suite because
 * a token carries one minimum reader release. Another suite gets its own token.
 */

import { z } from "zod";
import { itemTaskDigest, type BenchmarkRecord } from "@jinn-network/benchmarking-records";
import { EXTERNAL_IMPORT_CAPABILITY, TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY } from "../capabilities.js";
import { refuse } from "./errors.js";
import { SUITE_COVERAGE, coverageFromSelectedNames } from "./suite-coverage.js";
import { TERMINAL_BENCH_21_PINS } from "./terminal-bench-2-1-pins.js";

/** The Benchmark extension an official-slate bind seals. The product core spells the same URI where
 * it builds the Benchmark; `core/src/intake/terminal-bench-2-1.test.ts` holds the two equal. */
export const OFFICIAL_SUITE_SLATE_EXTENSION =
  "https://product.jinn.network/extensions/official-suite-slate/v1" as const;

/** The harness an import marker must name. The sentence says the run came from a Harbor jobs
 * directory, so a bundle whose marker names another source cannot seal it. */
export const TERMINAL_BENCH_21_IMPORT_HARNESS = "harbor" as const;

/**
 * The sentence. It is true of every brought run, whatever its coverage or replicate count, and it
 * freezes at the first checker publish: a published reader byte-compares it forever.
 */
export const TERMINAL_BENCH_21_COMPARABILITY_LIMIT =
  "This run is not a Terminal-Bench 2.1 leaderboard submission: it was run outside Colophon and imported from a Harbor jobs directory, and nothing in this bundle shows that it met the leaderboard's protocol. The pass rate is taken over the cells that reached a pass or fail verdict. A trial with no reward is left out of that rate and counted in the accounting, so the rate can be higher than Harbor's mean for the same job, which counts such a trial as 0.";

const Sha256Reference = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

/**
 * The claim section: the verified extension's own facts and the sentence. Strict, for the reason
 * every capability section is: a second key here would ride in the claim while every reader
 * ignored it. `limit` is the sentence itself and never any other text.
 */
export const ClaimTerminalBench21ComparabilitySectionSchema = z.strictObject({
  datasetId: z.string().min(1),
  datasetRevision: Sha256Reference,
  upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  slateDigest: Sha256Reference,
  coverage: z.enum(SUITE_COVERAGE),
  selectedTaskCount: z.number().int().positive(),
  datasetTaskCount: z.number().int().positive(),
  limit: z.literal(TERMINAL_BENCH_21_COMPARABILITY_LIMIT),
});

export type ClaimTerminalBench21ComparabilitySection = z.infer<typeof ClaimTerminalBench21ComparabilitySectionSchema>;

/** The extension's grammar. Closed: the builder seals exactly these members. The pinned constants
 * are compared by value below, so their shapes are not restated here. */
const OfficialSlateExtensionSchema = z.strictObject({
  protocol: z.literal(TERMINAL_BENCH_21_PINS.protocol),
  datasetId: z.string(),
  datasetRevision: z.string(),
  upstreamRepository: z.string(),
  upstreamCommit: z.string(),
  slateDigest: z.string(),
  coverage: z.enum(SUITE_COVERAGE),
  selectedTaskNames: z.array(z.string()).min(1),
  datasetTaskCount: z.number(),
});

const PINNED_CONSTANTS = [
  "datasetId",
  "datasetRevision",
  "upstreamRepository",
  "upstreamCommit",
  "slateDigest",
  "datasetTaskCount",
] as const;

const PINNED_TASK_NAMES: readonly string[] = TERMINAL_BENCH_21_PINS.tasks.map((task) => task.name);
const PINNED_TASK_SHA256 = new Map<string, string>(TERMINAL_BENCH_21_PINS.tasks.map((task) => [task.name, task.taskSha256]));

function slateExtension(benchmarkRecord: BenchmarkRecord): unknown {
  return (benchmarkRecord as unknown as Readonly<Record<string, unknown>>)[OFFICIAL_SUITE_SLATE_EXTENSION];
}

/**
 * Whether the Benchmark carries the official-slate extension naming Terminal-Bench 2.1. This is
 * the producer's activation fact and one half of the reader's binding. It says nothing about
 * whether the extension is TRUE of the Benchmark: that is the projection below.
 */
export function carriesOfficialTerminalBench21Slate(benchmarkRecord: BenchmarkRecord): boolean {
  const slate = slateExtension(benchmarkRecord);
  return typeof slate === "object"
    && slate !== null
    && (slate as Readonly<Record<string, unknown>>).protocol === TERMINAL_BENCH_21_PINS.protocol;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

export interface TerminalBench21ComparabilityInput {
  readonly benchmarkRecord: BenchmarkRecord;
  /** `source.harness` of the bundle's authenticated import marker, or `undefined` when the caller
   * holds no marker. */
  readonly importSourceHarness: string | undefined;
}

export type TerminalBench21ComparabilityProjection =
  | { readonly section: ClaimTerminalBench21ComparabilitySection; readonly contradiction?: undefined }
  | { readonly section?: undefined; readonly contradiction: string };

/**
 * The claim section a declaring bundle carries, or the first way its records contradict the
 * declaration. Pure, and shared deliberately: the producer calls it before `report` seals anything,
 * so a contradiction is a refusal the operator can still read, and both claim-consistency copies
 * call it through {@link deriveClaimTerminalBench21Comparability}. One rule, two postures.
 *
 * The section is the projection of the VERIFIED extension, never a second opinion: every value in
 * it is one this function has just compared against the pin or recomputed.
 */
export function projectClaimTerminalBench21Comparability(
  input: TerminalBench21ComparabilityInput,
): TerminalBench21ComparabilityProjection {
  const { benchmarkRecord } = input;
  if (!carriesOfficialTerminalBench21Slate(benchmarkRecord)) {
    return { contradiction: "the Benchmark carries no official-suite-slate/v1 extension naming Terminal-Bench 2.1" };
  }
  const parsed = OfficialSlateExtensionSchema.safeParse(slateExtension(benchmarkRecord));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : ` at "${issue.path.join(".")}"`;
    return { contradiction: `the Benchmark's official-suite-slate/v1 extension is not the official-slate shape${where}` };
  }
  const slate = parsed.data;
  for (const field of PINNED_CONSTANTS) {
    if (slate[field] !== TERMINAL_BENCH_21_PINS[field]) {
      return {
        contradiction: `the Benchmark's official-slate extension "${field}" is ${JSON.stringify(slate[field])},`
          + ` not the pinned ${JSON.stringify(TERMINAL_BENCH_21_PINS[field])}`,
      };
    }
  }
  const seen = new Set<string>();
  for (const name of slate.selectedTaskNames) {
    if (seen.has(name)) {
      return { contradiction: `the Benchmark's official-slate extension lists task ${JSON.stringify(name)} more than once` };
    }
    seen.add(name);
    if (!PINNED_TASK_SHA256.has(name)) {
      return {
        contradiction: `the Benchmark's official-slate extension names task ${JSON.stringify(name)},`
          + " which is not in the pinned official Terminal-Bench 2.1 slate",
      };
    }
  }
  const coverage = coverageFromSelectedNames(PINNED_TASK_NAMES, slate.selectedTaskNames);
  if (slate.coverage !== coverage) {
    return {
      contradiction: `the Benchmark's official-slate extension states coverage "${slate.coverage}",`
        + ` but its selected tasks are the "${coverage}" selection`,
    };
  }
  if (benchmarkRecord.items.length !== slate.selectedTaskNames.length) {
    return {
      contradiction: `the Benchmark has ${plural(benchmarkRecord.items.length, "item")} for`
        + ` ${plural(slate.selectedTaskNames.length, "selected task name")}`,
    };
  }
  for (const [index, name] of slate.selectedTaskNames.entries()) {
    const actual = itemTaskDigest(benchmarkRecord.items[index]!);
    const pinned = PINNED_TASK_SHA256.get(name)!;
    if (actual !== pinned) {
      return {
        contradiction: `Benchmark item ${index + 1}, task ${JSON.stringify(name)}, is Task ${actual},`
          + ` not the pinned official Task ${pinned}`,
      };
    }
  }
  if (input.importSourceHarness === undefined) {
    return { contradiction: "the bundle carries no import marker, and the sentence states a run imported from a Harbor jobs directory" };
  }
  if (input.importSourceHarness !== TERMINAL_BENCH_21_IMPORT_HARNESS) {
    return {
      contradiction: `the run's results were imported from ${JSON.stringify(input.importSourceHarness)},`
        + " not from a Harbor jobs directory",
    };
  }
  return {
    section: {
      datasetId: slate.datasetId,
      datasetRevision: slate.datasetRevision,
      upstreamCommit: slate.upstreamCommit,
      slateDigest: slate.slateDigest,
      coverage: slate.coverage,
      selectedTaskCount: slate.selectedTaskNames.length,
      datasetTaskCount: slate.datasetTaskCount,
      limit: TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
    },
  };
}

/** The cold verifier's posture over {@link projectClaimTerminalBench21Comparability}: the section,
 * or a typed record refusal. Reported under `claim-consistency`, the check whose rebuild reads it;
 * the capability appends no check of its own. */
export function deriveClaimTerminalBench21Comparability(
  input: TerminalBench21ComparabilityInput,
): ClaimTerminalBench21ComparabilitySection {
  const projection = projectClaimTerminalBench21Comparability(input);
  if (projection.section === undefined) {
    refuse(
      "record-integrity",
      "claim-consistency",
      `this bundle declares ${TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY}, but ${projection.contradiction}`,
    );
  }
  return projection.section;
}

/**
 * The composed generation's binding between a bundle's declared vector and its Benchmark. The
 * capability has no member, so the member closure cannot see either direction; both refuse here,
 * on the vector:
 *
 * - **The Benchmark is the official slate and the bundle is an import, but the vector does not
 *   declare.** The sentence is sealed only when the capability is declared, so an undeclared one
 *   would be a quieter page over the same records.
 * - **The vector declares, and the Benchmark carries no extension, or the bundle is not an
 *   import.** There is nothing for the section to project, and the sentence would be false.
 *
 * Only a `/10` bundle reaches this. A slate run this product drove itself is not imported, declares
 * nothing, and is unchanged.
 */
export function assertTerminalBench21ComparabilityDeclaration(input: {
  readonly declared: boolean;
  /** Whether the bundle's vector declares `external-import`. */
  readonly imported: boolean;
  readonly benchmarkRecord: BenchmarkRecord;
}): void {
  const onSlate = carriesOfficialTerminalBench21Slate(input.benchmarkRecord);
  if (!input.declared) {
    if (onSlate && input.imported) {
      refuse(
        "record-integrity",
        "bundle.manifest.capabilities",
        `the Benchmark carries the official Terminal-Bench 2.1 slate and this bundle declares "${EXTERNAL_IMPORT_CAPABILITY}",`
        + ` but it does not declare the "${TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY}" capability that seals the`
        + " comparability sentence; a brought run on the official slate cannot pass without it",
      );
    }
    return;
  }
  if (!input.imported) {
    refuse(
      "record-integrity",
      "bundle.manifest.capabilities",
      `this bundle declares the "${TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY}" capability, but it does not declare`
      + ` "${EXTERNAL_IMPORT_CAPABILITY}": the capability states a fact about an imported run`,
    );
  }
  if (!onSlate) {
    refuse(
      "record-integrity",
      "bundle.manifest.capabilities",
      `this bundle declares the "${TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY}" capability, but its Benchmark`
      + " carries no official-suite-slate/v1 extension naming Terminal-Bench 2.1",
    );
  }
}

/**
 * The sealed Report's half of the declaration.
 *
 * `claim-consistency` byte-compares the whole Report limitations list only when an earlier gate
 * applies, so this settles the one fact the capability adds to them, on every bundle:
 *
 * - declared: the Report limitations open with exactly the lines the rebuild derives ahead of the
 *   sentence (the venue sentences, any caller-supplied lines, and the binary-instrument lines),
 *   then the sentence, and carry it nowhere else. The paired-estimate line and the rehearsal line
 *   follow it;
 * - not declared: the sentence appears nowhere in them.
 */
export function assertTerminalBench21ComparabilityLimitations(input: {
  readonly reportLimitations: readonly string[];
  readonly precedingLimitations: readonly string[];
  readonly declared: boolean;
}): void {
  const occurrences = input.reportLimitations.filter((line) => line === TERMINAL_BENCH_21_COMPARABILITY_LIMIT).length;
  if (input.declared) {
    const slot = input.precedingLimitations.length;
    if (
      occurrences !== 1
      || input.reportLimitations[slot] !== TERMINAL_BENCH_21_COMPARABILITY_LIMIT
      || input.precedingLimitations.some((line, index) => line !== input.reportLimitations[index])
    ) {
      refuse(
        "record-integrity",
        "claim-consistency",
        `a bundle declaring ${TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY} must seal the comparability sentence once in its`
        + " Report limitations, right after the venue and binary-instrument lines",
      );
    }
    return;
  }
  if (occurrences > 0) {
    refuse(
      "record-integrity",
      "claim-consistency",
      "Report limitations carry the Terminal-Bench 2.1 comparability sentence, but the bundle does not declare"
      + ` ${TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY}`,
    );
  }
}
