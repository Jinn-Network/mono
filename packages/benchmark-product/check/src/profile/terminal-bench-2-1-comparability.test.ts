// SPDX-License-Identifier: Apache-2.0

/**
 * The `/10` capability `terminal-bench-2-1-comparability` (operator rulings of 2026-10-06 on the
 * Terminal-Bench 2.1 bring-your-run path, decisions 2 and 7).
 *
 * A run brought from a Harbor jobs directory onto the official Terminal-Bench 2.1 slate cannot show
 * that it met the leaderboard's protocol, so its bundle says so in one sealed sentence. The
 * capability binds four things together and refuses each one without the others: the token in the
 * vector, the Benchmark's official-slate extension checked against the pinned slate, the sentence
 * in the signed Report limitations, and the claim section projected from the verified extension.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  type BenchmarkRecord,
  type MatrixRecord,
  type ReportRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { sealEvaluationSpec, type EvaluationSpec } from "@jinn-network/task-execution-profiles";
import { TASK_EXECUTION_PROTOCOL_URI, sealTask } from "@jinn-network/task-execution-protocol";
import {
  CAPABILITY_REGISTRY,
  EXTERNAL_IMPORT_CAPABILITY,
  TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY,
  activeCapabilityVector,
  composeClosure,
  expectedChecks,
} from "../capabilities.js";
import { assertClaimConsistency, type ClaimRecordIdentities } from "./claim-consistency.js";
import { buildClaimPackage, ClaimPackageSchema, type ClaimPackage } from "./claim.js";
import { BenchmarkProductError } from "./errors.js";
import type { ClaimExternalImportSection } from "./external-import.js";
import { buildLocalVenueHonesty, localVenueLimitsForRun } from "./run-results.js";
import { coverageFromSelectedNames } from "./suite-coverage.js";
import {
  ClaimTerminalBench21ComparabilitySectionSchema,
  OFFICIAL_SUITE_SLATE_EXTENSION,
  TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
  assertTerminalBench21ComparabilityDeclaration,
  assertTerminalBench21ComparabilityLimitations,
  carriesOfficialTerminalBench21Slate,
  deriveClaimTerminalBench21Comparability,
  projectClaimTerminalBench21Comparability,
  type ClaimTerminalBench21ComparabilitySection,
} from "./terminal-bench-2-1-comparability.js";
import { TERMINAL_BENCH_21_PINS } from "./terminal-bench-2-1-pins.js";

const TOKEN = TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY;
const VECTOR = [EXTERNAL_IMPORT_CAPABILITY, TOKEN] as const;
const PINS = TERMINAL_BENCH_21_PINS;
const PINNED_NAMES = PINS.tasks.map((task) => task.name);
const pinOf = (name: string): string => PINS.tasks.find((task) => task.name === name)!.taskSha256;
const digest = (fill: string) => fill.repeat(64);
const DRAFT_ID = "draft-1";
const ASSURANCE_PRESET = "direct-check";
const RESOLVED_ASSURANCE = {
  independence: "disclosed",
  minVerdicts: 1,
  distinctEvaluator: false,
  verdictRule: "sole",
} as const;

type Slate = Record<string, unknown>;

/** A Benchmark shaped as the product core's official-slate builder seals it, over pinned Tasks. */
function slateBenchmark(
  selected: readonly string[],
  edit: { readonly slate?: (slate: Slate) => Slate; readonly items?: (digests: string[]) => string[] } = {},
): BenchmarkRecord {
  const slate: Slate = {
    protocol: "terminal-bench-2.1",
    datasetId: PINS.datasetId,
    datasetRevision: PINS.datasetRevision,
    upstreamRepository: PINS.upstreamRepository,
    upstreamCommit: PINS.upstreamCommit,
    slateDigest: PINS.slateDigest,
    coverage: coverageFromSelectedNames(PINNED_NAMES, selected),
    selectedTaskNames: [...selected],
    datasetTaskCount: PINS.datasetTaskCount,
  };
  const digests = selected.map((name) => PINS.tasks.find((task) => task.name === name)?.taskSha256 ?? digest("0"));
  return {
    protocol: BENCHMARKING_PROTOCOL,
    name: "terminal-bench-2.1",
    description: "Official Terminal-Bench 2.1 slice.",
    version: "2.1.0",
    items: (edit.items?.(digests) ?? digests).map((sha256) => ({ task: { digest: { sha256 } } })),
    reveal: { policy: "immediate" },
    [OFFICIAL_SUITE_SLATE_EXTENSION]: edit.slate?.(slate) ?? slate,
  } as unknown as BenchmarkRecord;
}

const ONE = [PINNED_NAMES[0]!];
const TEN = PINNED_NAMES.slice(0, 10);
const CUSTOM = [PINNED_NAMES[40]!, PINNED_NAMES[7]!];
const plainBenchmark = {
  protocol: BENCHMARKING_PROTOCOL,
  name: "another benchmark",
  description: "No official-slate extension.",
  version: "1.0.0",
  items: [{ task: { digest: { sha256: digest("1") } } }],
  reveal: { policy: "immediate" },
} as unknown as BenchmarkRecord;

const runRecord = {
  arms: [{ armId: "armA", pinning: {} }],
  replicates: 1,
  policy: {
    independence: RESOLVED_ASSURANCE.independence,
    evaluation: { minVerdicts: RESOLVED_ASSURANCE.minVerdicts, distinctEvaluator: RESOLVED_ASSURANCE.distinctEvaluator },
    submissionBaseline: {},
  },
  analysisPlan: [{
    method: BENCHMARKING_METHOD_IDS.wilson,
    version: BENCHMARKING_METHOD_VERSION,
    parameters: { verdictRule: RESOLVED_ASSURANCE.verdictRule },
  }],
} as unknown as RunRecord;

const CELL_KEY = `${pinOf(ONE[0]!)}/armA/1`;
const matrixRecord = {
  cells: [{
    cellKey: CELL_KEY,
    taskDigest: pinOf(ONE[0]!),
    armId: "armA",
    replicate: 1,
    outcome: "judged",
    verification: { harness: "match", model: "match", loadout: "match", isolation: "match", checksFailed: [] },
    integrityTier: "re-derivable",
  }],
  completeness: { expected: 1, judged: 1, floor: "1", runOutcome: "complete" },
  attrition: {
    perArm: {
      armA: { expected: 1, judged: 1, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0 },
    },
    asymmetryFlags: [],
  },
} as unknown as MatrixRecord;

function reportWith(limitations: readonly string[]): ReportRecord {
  return {
    method: { id: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: {} },
    preregistered: false,
    results: {
      perSubject: [{
        results: {
          arms: { armA: { n: 1, passRate: "1", wilsonInterval: { low: "0.207", high: "1" } } },
          conflicted: { count: 0, cellKeys: [] },
        },
      }],
    },
    disclosures: { perSubject: [] },
    limitations: [...limitations],
  } as unknown as ReportRecord;
}

const identities: ClaimRecordIdentities = {
  benchmarkSha256: digest("b"),
  runSha256: digest("c"),
  matrixSha256: digest("d"),
  reportSha256: digest("e"),
  reportEnvelopeSha256: digest("f"),
};

function importedFrom(harness: string): ClaimExternalImportSection {
  return {
    dumpSha256: digest("a"),
    dumpByteLength: 10,
    declarationSha256: digest("9"),
    source: { harness, version: "0.21.0" },
    rows: [{ cellKey: CELL_KEY, outcome: "graded" }],
  };
}
const HARBOR_IMPORT = importedFrom("harbor");

/** The venue sentences of an imported run: what precedes the sentence on a wilson Report. */
const VENUE = [...localVenueLimitsForRun(runRecord, true, false)];
const SEALED = [...VENUE, TERMINAL_BENCH_21_COMPARABILITY_LIMIT];

/** A claim built the way a producer builds it for an imported run. */
function claimFor(input: {
  readonly composedCapabilities?: readonly string[];
  readonly section?: ClaimTerminalBench21ComparabilitySection;
  readonly report: ReportRecord;
}): ClaimPackage {
  const imported = input.composedCapabilities?.includes(EXTERNAL_IMPORT_CAPABILITY) === true;
  return buildClaimPackage({
    draftId: DRAFT_ID,
    benchmarkSha256: identities.benchmarkSha256,
    runRecord,
    runSha256: identities.runSha256,
    matrixRecord,
    matrixSha256: identities.matrixSha256,
    reportRecord: input.report,
    reportSha256: identities.reportSha256!,
    reportEnvelopeSha256: identities.reportEnvelopeSha256,
    venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord, [], undefined, imported, false),
    verificationCommandVerb: "bundle verify",
    assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
    ...(input.composedCapabilities === undefined ? {} : { composedCapabilities: input.composedCapabilities }),
    ...(imported ? { externalImport: HARBOR_IMPORT } : {}),
    ...(input.section === undefined ? {} : { terminalBench21Comparability: input.section }),
  });
}

/** The verifier's side: the vector, the Benchmark, and the import marker are the bundle's. */
function verify(claim: ClaimPackage, bundle: {
  readonly composedCapabilities?: readonly string[];
  readonly benchmark: BenchmarkRecord;
  readonly report: ReportRecord;
  readonly externalImport?: ClaimExternalImportSection;
}): void {
  const imported = bundle.composedCapabilities?.includes(EXTERNAL_IMPORT_CAPABILITY) === true;
  assertClaimConsistency({
    claim,
    identities,
    benchmarkRecord: bundle.benchmark,
    runRecord,
    matrixRecord,
    reportRecord: bundle.report,
    draftId: DRAFT_ID,
    assurancePreset: ASSURANCE_PRESET,
    ...(bundle.composedCapabilities === undefined ? {} : { composedCapabilities: bundle.composedCapabilities }),
    ...(imported ? { externalImport: bundle.externalImport ?? HARBOR_IMPORT } : {}),
  });
}

function refusalOf(run: () => void): BenchmarkProductError {
  try {
    run();
  } catch (cause) {
    if (cause instanceof BenchmarkProductError) return cause;
    throw cause;
  }
  throw new Error("expected a typed refusal");
}

const sectionOf = (benchmark: BenchmarkRecord) =>
  deriveClaimTerminalBench21Comparability({ benchmarkRecord: benchmark, importSourceHarness: "harbor" });

describe("the sentence", () => {
  test("is the text that freezes at the first checker publish, byte for byte", () => {
    expect(TERMINAL_BENCH_21_COMPARABILITY_LIMIT).toBe(
      "This run is not a Terminal-Bench 2.1 leaderboard submission: it was run outside Colophon and imported from a Harbor jobs directory, and nothing in this bundle shows that it met the leaderboard's protocol. The pass rate is taken over the cells that reached a pass or fail verdict. A trial with no reward is left out of that rate and counted in the accounting, so the rate can be higher than Harbor's mean for the same job, which counts such a trial as 0.",
    );
    // Straight apostrophes and nothing outside ASCII: a typographic quote would be another sentence.
    expect([...TERMINAL_BENCH_21_COMPARABILITY_LIMIT].every((character) => character.charCodeAt(0) < 0x80)).toBe(true);
    expect(TERMINAL_BENCH_21_COMPARABILITY_LIMIT).toContain("leaderboard's");
    expect(TERMINAL_BENCH_21_COMPARABILITY_LIMIT).toContain("Harbor's");
  });

  test("is not one of the venue sentences of an imported run", () => {
    expect(VENUE).not.toContain(TERMINAL_BENCH_21_COMPARABILITY_LIMIT);
    expect(localVenueLimitsForRun(runRecord, true, true)).not.toContain(TERMINAL_BENCH_21_COMPARABILITY_LIMIT);
  });
});

describe("the registry entry", () => {
  const entry = CAPABILITY_REGISTRY.find((capability) => capability.token === TOKEN)!;

  test("order 7, requires external-import, one claim section, and nothing else", () => {
    expect(TOKEN).toBe("terminal-bench-2-1-comparability");
    expect(entry.order).toBe(7);
    expect(entry.requires).toEqual(["external-import"]);
    expect(entry.conflicts).toEqual([]);
    expect(entry.mandatoryFiles).toEqual([]);
    expect(entry.memberPatterns).toEqual([]);
    expect(entry.refines).toEqual([]);
    expect(entry.roleDerivations).toEqual([]);
    expect(entry.checks).toEqual([]);
    expect(entry.claimSection).toBe("terminalBench21Comparability");
    expect(entry.minimumReaderRelease).toBe("check@0.2.1");
    expect(expectedChecks([...VECTOR])).toEqual(expectedChecks([EXTERNAL_IMPORT_CAPABILITY]));
  });

  test("a vector that declares it without external-import does not resolve", () => {
    expect(() => composeClosure([TOKEN])).toThrow(/requires "external-import"/u);
    expect(composeClosure([...VECTOR]).claimSections).toEqual(["externalImport", "terminalBench21Comparability"]);
  });

  test("it turns on for an imported run on the official slate, and for neither fact alone", () => {
    const none = {
      anchoredClosure: false,
      projectsBinaryQualification: false,
      declaresDisclosure: false,
      importedRun: false,
      declaresTaskSelection: false,
      officialTerminalBench21Slate: false,
    };
    expect(activeCapabilityVector({ ...none, importedRun: true, officialTerminalBench21Slate: true })).toContain(TOKEN);
    expect(activeCapabilityVector({ ...none, importedRun: true })).not.toContain(TOKEN);
    // A slate run this product drove itself is not a brought run.
    expect(activeCapabilityVector({ ...none, officialTerminalBench21Slate: true })).not.toContain(TOKEN);
    expect(activeCapabilityVector(none)).not.toContain(TOKEN);
  });
});

describe("the activation fact", () => {
  test("is the official-slate extension naming Terminal-Bench 2.1", () => {
    expect(carriesOfficialTerminalBench21Slate(slateBenchmark(ONE))).toBe(true);
    expect(carriesOfficialTerminalBench21Slate(plainBenchmark)).toBe(false);
    // Another suite under the same extension is not this capability's fact: it gets its own token.
    expect(carriesOfficialTerminalBench21Slate(
      slateBenchmark(ONE, { slate: (slate) => ({ ...slate, protocol: "terminal-bench-3.0" }) }),
    )).toBe(false);
    expect(carriesOfficialTerminalBench21Slate(
      { ...plainBenchmark, [OFFICIAL_SUITE_SLATE_EXTENSION]: "terminal-bench-2.1" } as unknown as BenchmarkRecord,
    )).toBe(false);
  });
});

describe("the pinned slate", () => {
  test("holds every official task once, each with a Task digest", () => {
    expect(PINS.tasks).toHaveLength(PINS.datasetTaskCount);
    expect(new Set(PINNED_NAMES).size).toBe(PINS.datasetTaskCount);
    expect(new Set(PINS.tasks.map((task) => task.taskSha256)).size).toBe(PINS.datasetTaskCount);
    for (const task of PINS.tasks) expect(task.taskSha256, task.name).toMatch(/^[a-f0-9]{64}$/u);
    expect(PINS.slateDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(PINS.datasetRevision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(PINS.upstreamCommit).toMatch(/^[a-f0-9]{40}$/u);
  });

  test("a slice, the ten-task slice, the full slate, and a custom selection all project", () => {
    for (const [selected, coverage] of [[ONE, "one_task"], [TEN, "ten_task"], [PINNED_NAMES, "full"], [CUSTOM, "custom"]] as const) {
      expect(sectionOf(slateBenchmark(selected))).toEqual({
        datasetId: PINS.datasetId,
        datasetRevision: PINS.datasetRevision,
        upstreamCommit: PINS.upstreamCommit,
        slateDigest: PINS.slateDigest,
        coverage,
        selectedTaskCount: selected.length,
        datasetTaskCount: PINS.datasetTaskCount,
        limit: TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
      });
    }
  });

  /** The first contradiction, for a marker naming Harbor unless the caller states another source. */
  const contradictionOf = (benchmark: BenchmarkRecord, ...source: [importSourceHarness: string | undefined] | []) =>
    projectClaimTerminalBench21Comparability({
      benchmarkRecord: benchmark,
      importSourceHarness: source.length === 0 ? "harbor" : source[0],
    }).contradiction;

  test("a Benchmark without the extension has nothing to project", () => {
    expect(contradictionOf(plainBenchmark)).toMatch(/carries no official-suite-slate\/v1 extension naming Terminal-Bench 2\.1/u);
  });

  test("every pinned constant of the extension is compared", () => {
    for (const field of ["datasetId", "datasetRevision", "upstreamRepository", "upstreamCommit", "slateDigest"]) {
      expect(
        contradictionOf(slateBenchmark(ONE, { slate: (slate) => ({ ...slate, [field]: `${String(slate[field])}0` }) })),
        field,
      ).toContain(`"${field}"`);
    }
    expect(contradictionOf(slateBenchmark(ONE, { slate: (slate) => ({ ...slate, datasetTaskCount: 90 }) })))
      .toContain('"datasetTaskCount"');
  });

  test("the extension is closed: a missing or an extra member is refused", () => {
    expect(contradictionOf(slateBenchmark(ONE, { slate: ({ slateDigest: _dropped, ...rest }) => rest })))
      .toMatch(/is not the official-slate shape/u);
    expect(contradictionOf(slateBenchmark(ONE, { slate: (slate) => ({ ...slate, leaderboardReady: true }) })))
      .toMatch(/is not the official-slate shape/u);
  });

  test("a selected name outside the pinned slate, or listed twice, is refused", () => {
    expect(contradictionOf(slateBenchmark(["not-a-terminal-bench-task"]))).toContain('"not-a-terminal-bench-task"');
    expect(contradictionOf(slateBenchmark([ONE[0]!, ONE[0]!]))).toMatch(/more than once/u);
    expect(contradictionOf(slateBenchmark([]))).toMatch(/is not the official-slate shape/u);
  });

  test("a forged coverage word is refused against the recomputed one", () => {
    expect(contradictionOf(slateBenchmark(ONE, { slate: (slate) => ({ ...slate, coverage: "full" }) })))
      .toMatch(/states coverage "full", but its selected tasks are the "one_task" selection/u);
    expect(contradictionOf(slateBenchmark(CUSTOM, { slate: (slate) => ({ ...slate, coverage: "ten_task" }) })))
      .toMatch(/states coverage "ten_task", but its selected tasks are the "custom" selection/u);
  });

  test("a Task digest off the pin is refused, naming the task", () => {
    const offPin = slateBenchmark(TEN, { items: (digests) => digests.map((sha256, index) => index === 3 ? digest("5") : sha256) });
    expect(contradictionOf(offPin)).toContain(`"${TEN[3]}"`);
    expect(contradictionOf(offPin)).toMatch(/not the pinned official Task/u);
  });

  /**
   * What the pinned Task digest holds still, beyond the Task's own words: the EvaluationSpec it
   * binds. The reader parses a carried spec and does not compare its content with anything, so a
   * spec that judges differently would pass that step. It does not pass this one: the spec's
   * digest is inside the Task, the Task's digest is pinned, and one comparison per item settles
   * both.
   *
   * The official Task of the first slate task is spelled out here, with the spec the operator
   * ruled (2026-10-06, decision 1) and the block's own semantics version. The control shows that
   * these literals seal to the pinned Task. Each tamper then changes one thing in the spec, stays
   * a valid specification, and is refused as a Task off the pin.
   */
  describe("the pinned Task digest holds the EvaluationSpec it binds", () => {
    const FIRST = PINNED_NAMES[0]!;
    const PACKAGE_REF = "bcaa2399985cd57666018025846289ab25e193ae0dd8fb7f0ffab2410c24d4de";
    const rewardIs = (value: number) => ({ threshold: { measurement: "reward", op: "eq" as const, value } });
    const RULED_SPEC = {
      protocol: "https://spec.jinn.network/profiles/evaluation-spec/v1",
      semanticsVersion: "4",
      family: "external-verifier",
      grader: { name: `terminal-bench/${FIRST}`, digest: { sha256: PACKAGE_REF }, accessClass: "public" },
      familyBlock: {
        harness: "harbor",
        verifierSemanticsVersion: "1",
        testMaterial: [
          { name: "tests/test.sh", digest: { sha256: "38b43560d173cc2b952c3a3e17b8a480216d84e33450515e047bcb0d806b1e0a" }, accessClass: "public" },
          { name: "tests/test_outputs.py", digest: { sha256: "547dc6e107f034f41703722aeceb6d0236e3fb69116fc3f2fbaba11884de352f" }, accessClass: "public" },
        ],
        declaredImage: "alexgshaw/adaptive-rejection-sampler:20251031",
        timeout: 900,
      },
      measurements: [{ name: "reward", type: "number", required: true }],
      verdictRule: {
        all: [
          { inconclusiveWhen: { not: { any: [rewardIs(0), rewardIs(1)] } }, class: "non-binary-reward" },
          rewardIs(1),
        ],
      },
      unscorable: [{ name: "non-binary-reward", disposition: "recorded-inconclusive" }],
      evidenceConventions: { requiredRefs: ["trial-result.json"] },
    } as const;

    /** The digest of the official Task of the first slate task, binding `spec`. Sealing the spec
     * first proves each tampered spec is still a valid specification. */
    function officialTaskBinding(spec: unknown): string {
      const evaluationSpecSha256 = sealEvaluationSpec(spec as EvaluationSpec).digest.slice("sha256:".length);
      return createHash("sha256").update(sealTask({
        protocol: TASK_EXECUTION_PROTOCOL_URI,
        profile: {
          uri: "https://product.jinn.network/profiles/terminal-bench-2-1-item/1",
          digest: { sha256: "be35444162406ef9b2720be2e49c30570a2b1bd49af2bd88855c867a14e2574b" },
        },
        instructions: `Terminal-Bench 2.1 task ${FIRST} at dataset ${PINS.datasetId}@${PINS.datasetRevision}.`,
        payload: {
          datasetId: PINS.datasetId,
          datasetRevision: PINS.datasetRevision,
          upstreamCommit: PINS.upstreamCommit,
          taskName: FIRST,
          packageRef: `sha256:${PACKAGE_REF}`,
        },
        outputs: [{ name: "result", mediaType: "application/json", required: false }],
        evaluation: { digest: { sha256: evaluationSpecSha256 } },
        author: "urn:jinn:benchmark-product:terminal-bench-2.1-official-slate",
      })).digest("hex");
    }

    const offPin = (spec: unknown) =>
      contradictionOf(slateBenchmark(ONE, { items: () => [officialTaskBinding(spec)] }));

    test("control: the ruled spec seals into the pinned Task, and that Benchmark projects", () => {
      expect(officialTaskBinding(RULED_SPEC)).toBe(pinOf(FIRST));
      expect(offPin(RULED_SPEC)).toBeUndefined();
    });

    test("a rule that passes at a reward of 0 is a Task off the pin", () => {
      const passAtZero = {
        ...RULED_SPEC,
        verdictRule: { all: [RULED_SPEC.verdictRule.all[0], rewardIs(0)] },
      };
      expect(offPin(passAtZero)).toContain(`"${FIRST}"`);
      expect(offPin(passAtZero)).toMatch(/not the pinned official Task/u);
    });

    test("a grader digest that is not the slate's package ref is a Task off the pin", () => {
      const otherPackage = { ...RULED_SPEC, grader: { ...RULED_SPEC.grader, digest: { sha256: digest("5") } } };
      expect(offPin(otherPackage)).toContain(`"${FIRST}"`);
      expect(offPin(otherPackage)).toMatch(/not the pinned official Task/u);
    });

    test("a deterministic-process spec for the same task is a Task off the pin", () => {
      // The family the first design considered for these tasks. It seals, and it states an image,
      // a platform and a parser that no task package states.
      const deterministicProcess = {
        protocol: RULED_SPEC.protocol,
        semanticsVersion: RULED_SPEC.semanticsVersion,
        family: "deterministic-process",
        grader: RULED_SPEC.grader,
        familyBlock: {
          image: { uri: "docker://alexgshaw/adaptive-rejection-sampler:20251031" },
          platform: "linux/amd64",
          workspace: { root: "/app" },
          testMaterial: RULED_SPEC.familyBlock.testMaterial,
          parser: { id: "harbor-reward-file", version: "0.21.0", digest: `sha256:${digest("1")}` },
          transitions: { failToPass: [], passToPass: [] },
          timeout: 900,
        },
        measurements: RULED_SPEC.measurements,
        verdictRule: rewardIs(1),
        unscorable: [],
        evidenceConventions: RULED_SPEC.evidenceConventions,
      };
      expect(offPin(deterministicProcess)).toContain(`"${FIRST}"`);
      expect(offPin(deterministicProcess)).toMatch(/not the pinned official Task/u);
    });
  });

  test("names that do not match the items are refused", () => {
    // The right Tasks in another order than the names state.
    expect(contradictionOf(slateBenchmark(CUSTOM, { items: (digests) => [...digests].reverse() })))
      .toMatch(/not the pinned official Task/u);
    // One item more, and one fewer, than the names.
    expect(contradictionOf(slateBenchmark(ONE, { items: (digests) => [...digests, pinOf(PINNED_NAMES[1]!)] })))
      .toMatch(/2 items for 1 selected task name/u);
    expect(contradictionOf(slateBenchmark(TEN, { items: (digests) => digests.slice(1) })))
      .toMatch(/9 items for 10 selected task names/u);
  });

  test("the import marker must name Harbor", () => {
    expect(contradictionOf(slateBenchmark(ONE), "tb21-slate-check")).toMatch(/imported from "tb21-slate-check", not from a Harbor jobs directory/u);
    expect(contradictionOf(slateBenchmark(ONE), undefined)).toMatch(/carries no import marker/u);
    expect(contradictionOf(slateBenchmark(ONE), "harbor")).toBeUndefined();
  });

  test("the throwing form refuses under claim-consistency with the same words", () => {
    const refusal = refusalOf(() => sectionOf(slateBenchmark(ONE, { slate: (slate) => ({ ...slate, coverage: "full" }) })));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.issues[0]!.path).toBe("claim-consistency");
    expect(refusal.message).toMatch(/states coverage "full"/u);
  });
});

describe("the vector is bound to the Benchmark and the import", () => {
  const bind = (declared: boolean, imported: boolean, benchmark: BenchmarkRecord) => () =>
    assertTerminalBench21ComparabilityDeclaration({ declared, imported, benchmarkRecord: benchmark });

  test("extension and import with the token, and neither with none, pass", () => {
    expect(bind(true, true, slateBenchmark(ONE))).not.toThrow();
    expect(bind(false, false, plainBenchmark)).not.toThrow();
    // A slate run that was not imported, and an imported run on another benchmark, declare nothing.
    expect(bind(false, false, slateBenchmark(ONE))).not.toThrow();
    expect(bind(false, true, plainBenchmark)).not.toThrow();
  });

  test("extension and import without the token is refused on the vector", () => {
    const refusal = refusalOf(bind(false, true, slateBenchmark(ONE)));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.issues[0]!.path).toBe("bundle.manifest.capabilities");
    expect(refusal.message).toContain(`does not declare the "${TOKEN}" capability`);
  });

  test("the token without the extension, or without the import, is refused on the vector", () => {
    const noExtension = refusalOf(bind(true, true, plainBenchmark));
    expect(noExtension.issues[0]!.path).toBe("bundle.manifest.capabilities");
    expect(noExtension.message).toMatch(/carries no official-suite-slate\/v1 extension naming Terminal-Bench 2\.1/u);
    const noImport = refusalOf(bind(true, false, slateBenchmark(ONE)));
    expect(noImport.issues[0]!.path).toBe("bundle.manifest.capabilities");
    expect(noImport.message).toMatch(/does not declare "external-import"/u);
  });
});

describe("the sentence's slot in the Report limitations", () => {
  const BINARY = ["A binary-instrument line.", "Another binary-instrument line."];
  const PAIRED = "This method estimates an effect; it does not gate one.";
  const slot = (reportLimitations: readonly string[], declared: boolean, precedingLimitations: readonly string[] = VENUE) => () =>
    assertTerminalBench21ComparabilityLimitations({ reportLimitations, precedingLimitations, declared });

  test("declared: once, right after the lines that precede it, and before anything else", () => {
    expect(slot(SEALED, true)).not.toThrow();
    expect(slot([...VENUE, ...BINARY, TERMINAL_BENCH_21_COMPARABILITY_LIMIT, PAIRED, "A rehearsal line."], true, [...VENUE, ...BINARY]))
      .not.toThrow();
  });

  test("declared without the sentence is refused", () => {
    const refusal = refusalOf(slot(VENUE, true));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.issues[0]!.path).toBe("claim-consistency");
    expect(refusal.message).toContain(`a bundle declaring ${TOKEN} must seal the comparability sentence once in its Report limitations`);
  });

  test("declared with the sentence out of its slot, or twice, is refused", () => {
    // After the paired-estimate line instead of before it.
    expect(slot([...VENUE, PAIRED, TERMINAL_BENCH_21_COMPARABILITY_LIMIT], true)).toThrow(/must seal the comparability sentence once/u);
    // Before the binary-instrument lines instead of after them.
    expect(slot([...VENUE, TERMINAL_BENCH_21_COMPARABILITY_LIMIT, ...BINARY], true, [...VENUE, ...BINARY]))
      .toThrow(/must seal the comparability sentence once/u);
    // Ahead of the venue sentences.
    expect(slot([TERMINAL_BENCH_21_COMPARABILITY_LIMIT, ...VENUE], true)).toThrow(/must seal the comparability sentence once/u);
    expect(slot([...SEALED, TERMINAL_BENCH_21_COMPARABILITY_LIMIT], true)).toThrow(/must seal the comparability sentence once/u);
  });

  test("declared with one character of the sentence edited is refused", () => {
    const edited = TERMINAL_BENCH_21_COMPARABILITY_LIMIT.replace("is not a", "is a");
    expect(edited).not.toBe(TERMINAL_BENCH_21_COMPARABILITY_LIMIT);
    expect(slot([...VENUE, edited], true)).toThrow(/must seal the comparability sentence once/u);
    expect(slot([...VENUE, TERMINAL_BENCH_21_COMPARABILITY_LIMIT.replace("'", "’")], true))
      .toThrow(/must seal the comparability sentence once/u);
  });

  test("not declared: the sentence anywhere is refused, and its absence passes", () => {
    expect(slot(VENUE, false)).not.toThrow();
    const refusal = refusalOf(slot(SEALED, false));
    expect(refusal.issues[0]!.path).toBe("claim-consistency");
    expect(refusal.message).toContain(`does not declare ${TOKEN}`);
    expect(slot([TERMINAL_BENCH_21_COMPARABILITY_LIMIT], false)).toThrow(/does not declare/u);
  });
});

describe("claim-consistency on a composed bundle", () => {
  const benchmark = slateBenchmark(ONE);
  const section = sectionOf(benchmark);

  test("declared, with the sentence in its slot and the projected section: consistent", () => {
    const report = reportWith(SEALED);
    const claim = claimFor({ composedCapabilities: VECTOR, section, report });
    expect(claim.terminalBench21Comparability).toEqual(section);
    expect(claim.limitations).toEqual(SEALED);
    expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);
    expect(() => verify(claim, { composedCapabilities: VECTOR, benchmark, report })).not.toThrow();
  });

  test("an imported run on another benchmark declares nothing and carries neither", () => {
    const report = reportWith(VENUE);
    const claim = claimFor({ composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], report });
    expect(claim.terminalBench21Comparability).toBeUndefined();
    expect(() => verify(claim, { composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], benchmark: plainBenchmark, report })).not.toThrow();
  });

  test("the sentence removed from the Report while declared is refused", () => {
    const report = reportWith(VENUE);
    const claim = claimFor({ composedCapabilities: VECTOR, section, report });
    const refusal = refusalOf(() => verify(claim, { composedCapabilities: VECTOR, benchmark, report }));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.message).toMatch(/must seal the comparability sentence once in its Report limitations/u);
  });

  test("the sentence in the Report while undeclared is refused", () => {
    const report = reportWith(SEALED);
    const claim = claimFor({ composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], report });
    const refusal = refusalOf(() => verify(claim, { composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], benchmark, report }));
    expect(refusal.code).toBe("record-integrity");
    expect(refusal.message).toContain(`does not declare ${TOKEN}`);
  });

  test("one character of the sentence edited and resealed is refused, in the Report and in the section", () => {
    const edited = TERMINAL_BENCH_21_COMPARABILITY_LIMIT.replace("higher", "lower");
    const report = reportWith([...VENUE, edited]);
    const claim = claimFor({ composedCapabilities: VECTOR, section, report });
    expect(refusalOf(() => verify(claim, { composedCapabilities: VECTOR, benchmark, report })).message)
      .toMatch(/must seal the comparability sentence once/u);
    // The section's `limit` is a literal: the edited text does not parse, and a resealed claim that
    // carries it is not the projection.
    const resealed = { ...claimFor({ composedCapabilities: VECTOR, section, report: reportWith(SEALED) }), terminalBench21Comparability: { ...section, limit: edited } };
    expect(ClaimPackageSchema.safeParse(resealed).success).toBe(false);
    expect(refusalOf(() => verify(resealed as unknown as ClaimPackage, { composedCapabilities: VECTOR, benchmark, report: reportWith(SEALED) })).message)
      .toMatch(/claim package terminalBench21Comparability\.limit is not the exact projection/u);
  });

  test("an edited section is refused on the field that was edited", () => {
    const report = reportWith(SEALED);
    const claim = claimFor({ composedCapabilities: VECTOR, section, report });
    for (const [field, value] of [
      ["coverage", "full"],
      ["selectedTaskCount", 89],
      ["datasetTaskCount", 1],
      ["datasetRevision", `sha256:${digest("0")}`],
      ["upstreamCommit", "0".repeat(40)],
      ["slateDigest", `sha256:${digest("0")}`],
    ] as const) {
      const edited = { ...claim, terminalBench21Comparability: { ...section, [field]: value } } as ClaimPackage;
      expect(ClaimPackageSchema.safeParse(edited).success, field).toBe(true);
      expect(refusalOf(() => verify(edited, { composedCapabilities: VECTOR, benchmark, report })).message, field)
        .toContain(`claim package terminalBench21Comparability.${field} is not the exact projection`);
    }
  });

  test("the section is closed: an extra member does not parse", () => {
    expect(ClaimTerminalBench21ComparabilitySectionSchema.safeParse(section).success).toBe(true);
    expect(ClaimTerminalBench21ComparabilitySectionSchema.safeParse({ ...section, leaderboardSubmitReady: true }).success).toBe(false);
    const { limit: _limit, ...withoutLimit } = section;
    expect(ClaimTerminalBench21ComparabilitySectionSchema.safeParse(withoutLimit).success).toBe(false);
  });

  test("the declaration without the section, and the section without the declaration, are refused", () => {
    const report = reportWith(SEALED);
    const withSection = claimFor({ composedCapabilities: VECTOR, section, report });
    expect(refusalOf(() => verify(withSection, { composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], benchmark, report })).message)
      .toMatch(/claim package terminalBench21Comparability is not the exact projection|does not declare/u);
    const withoutSection = claimFor({ composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], report });
    expect(refusalOf(() => verify(withoutSection, { composedCapabilities: VECTOR, benchmark, report })).message)
      .toMatch(/claim package (claimSchema|terminalBench21Comparability) is not the exact projection/u);
  });

  test("a Task digest off the pin is refused while everything the claim says is right", () => {
    const report = reportWith(SEALED);
    const claim = claimFor({ composedCapabilities: VECTOR, section, report });
    const offPin = slateBenchmark(ONE, { items: () => [digest("5")] });
    const refusal = refusalOf(() => verify(claim, { composedCapabilities: VECTOR, benchmark: offPin, report }));
    expect(refusal.issues[0]!.path).toBe("claim-consistency");
    expect(refusal.message).toMatch(/not the pinned official Task/u);
  });

  test("a forged coverage word in the Benchmark is refused even when the claim copies it", () => {
    const report = reportWith(SEALED);
    const forged = slateBenchmark(ONE, { slate: (slate) => ({ ...slate, coverage: "full" }) });
    const claim = claimFor({ composedCapabilities: VECTOR, section: { ...section, coverage: "full" }, report });
    expect(refusalOf(() => verify(claim, { composedCapabilities: VECTOR, benchmark: forged, report })).message)
      .toMatch(/states coverage "full"/u);
  });

  test("an import marker that does not name Harbor is refused", () => {
    const report = reportWith(SEALED);
    const claim = claimFor({ composedCapabilities: VECTOR, section, report });
    expect(refusalOf(() => verify(claim, { composedCapabilities: VECTOR, benchmark, report, externalImport: importedFrom("my-own-runner") })).message)
      .toMatch(/imported from "my-own-runner", not from a Harbor jobs directory/u);
  });

  test("the builder refuses a declaration and a section that do not arrive together", () => {
    const report = reportWith(SEALED);
    expect(() => claimFor({ composedCapabilities: VECTOR, report }))
      .toThrow(/"terminal-bench-2-1-comparability" and its "terminalBench21Comparability" section/u);
    expect(() => claimFor({ composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], section, report }))
      .toThrow(/"terminal-bench-2-1-comparability" and its "terminalBench21Comparability" section/u);
  });
});

describe("earlier claim allocations", () => {
  test("an earlier format carries no sentence and verifies as before", () => {
    const venue = [...localVenueLimitsForRun(runRecord)];
    const report = reportWith(venue);
    const claim = claimFor({ report });
    expect(claim.terminalBench21Comparability).toBeUndefined();
    // The slate extension alone changes nothing for a bundle with no vector.
    expect(() => verify(claim, { benchmark: slateBenchmark(ONE), report })).not.toThrow();
  });

  test("an earlier format cannot declare the capability, so the sentence in its Report is refused", () => {
    const report = reportWith([...localVenueLimitsForRun(runRecord), TERMINAL_BENCH_21_COMPARABILITY_LIMIT]);
    expect(refusalOf(() => verify(claimFor({ report }), { benchmark: slateBenchmark(ONE), report })).message)
      .toContain(`does not declare ${TOKEN}`);
  });

  test("the section on an earlier claim id does not parse", () => {
    const legacy = claimFor({ report: reportWith([...localVenueLimitsForRun(runRecord)]) });
    const parsed = ClaimPackageSchema.safeParse({ ...legacy, terminalBench21Comparability: sectionOf(slateBenchmark(ONE)) });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message))
      .toEqual([expect.stringContaining("only the composed claim-package/7 allocation carries a terminalBench21Comparability section")]);
  });
});
