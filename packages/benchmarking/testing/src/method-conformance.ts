import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  checkComparability,
  parseMatrix,
  sealMatrix,
  sealRun,
  type MatrixRecord,
} from "@jinn-network/benchmarking-records";
import {
  buildVerdictEnvelope,
  buildRepositoryWorkProfile,
  canonicalJsonBytes,
  recordDigest,
  sealTaskProfile,
  type ResultEvaluationStatement,
  type VerdictOutcome,
} from "@jinn-network/task-execution-profiles";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import type {
  MethodComputeInput,
  MethodResults,
  MethodRegistry,
  MethodSubject,
  VerdictRuleName,
} from "./method-types.js";

interface MethodFixture {
  readonly methodId: string;
  readonly methodVersion: string;
  readonly parameters: Record<string, unknown>;
  readonly verdictRule: VerdictRuleName;
  readonly matrices: readonly unknown[];
  readonly verdictOutcomes: Record<string, VerdictOutcome>;
  readonly taskTimestamps?: Record<string, string>;
  readonly clusterKeys?: Record<string, string>;
  readonly taskProvenance?: Record<string, { readonly source?: string; readonly sourceCommitment?: string }>;
  readonly runReplicates?: number;
  readonly expectedResults: unknown;
}

interface ClusterBcaOracleFixture {
  readonly methodId: string;
  readonly methodVersion: string;
  readonly parameters: Record<string, unknown>;
  readonly verdictRule: VerdictRuleName;
  readonly oracle: {
    readonly alpha: number;
    readonly minN: number;
    readonly deltaAbs: number;
    readonly relativeCap: number;
  };
  readonly tasks: readonly {
    readonly taskDigest: string;
    readonly pA: readonly [number, number];
    readonly pB: readonly [number, number];
    readonly provenance: { readonly source?: string; readonly sourceCommitment?: string };
  }[];
  readonly expectedPrimitive: unknown;
  readonly expectedPublic: unknown;
  readonly regroup: {
    readonly taskDigest: string;
    readonly provenance: { readonly source: string };
    readonly expectedPrimitive: unknown;
    readonly expectedPublic: unknown;
  };
}

interface MethodSpecFixture {
  readonly id: string;
  readonly version: string;
  readonly requiredInputs: readonly string[];
  readonly parameterSchema: { readonly type: "object" };
  readonly outputShape: string;
  readonly exclusionRule: string;
  readonly clusteringRule: string;
  readonly referenceSet: "v1-reference" | "registered-non-reference";
  readonly deterministic: true;
  readonly resamplingProcedure?: string;
  readonly computeAvailability: "available" | "unavailable";
}

async function fixtureNames(): Promise<string[]> {
  const directory = fileURLToPath(new URL("../fixtures/methods/", import.meta.url));
  const entries = await readdir(directory);
  return entries.filter((name) => name.endsWith(".json")).sort();
}

async function loadFixture(name: string): Promise<MethodFixture> {
  const url = new URL(`../fixtures/methods/${name}`, import.meta.url);
  const raw = await readFile(fileURLToPath(url), "utf8");
  return JSON.parse(raw) as MethodFixture;
}

async function loadJson<T>(name: string): Promise<T> {
  const url = new URL(`../fixtures/methods/${name}`, import.meta.url);
  const raw = await readFile(fileURLToPath(url), "utf8");
  return JSON.parse(raw) as T;
}

async function computeFixtureNames(): Promise<string[]> {
  const names = await fixtureNames();
  const manifest = await loadBenchmarkingManifest();
  const superseded = new Set((manifest.errata ?? []).map((erratum) => erratum.id));
  const fixtures = await Promise.all(names.map(async (name) => [name, await loadJson<Record<string, unknown>>(name)] as const));
  return fixtures
    .filter(([name, fixture]) => !superseded.has(`methods/${name}`)
      && Array.isArray(fixture["matrices"])
      && Object.hasOwn(fixture, "expectedResults"))
    .map(([name]) => name);
}

async function loadBenchmarkingManifest(): Promise<{
  readonly errata?: readonly { readonly id: string; readonly supersededBy: string }[];
}> {
  const url = new URL("../fixtures/manifest.sha256.json", import.meta.url);
  return JSON.parse(await readFile(fileURLToPath(url), "utf8"));
}

/** Validates + parses each fixture's raw matrix documents through the real records schema, so a
 * method fixture can never smuggle a structurally invalid Matrix in as "input". */
function parseMatrices(raw: readonly unknown[]): MatrixRecord[] {
  return raw.map((document) => parseMatrix(sealMatrix(document).bytes));
}

function mapStringsDeep(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    // Provenance source-family claims are opaque values, not record references. In particular,
    // the deterministic `fixture-source/<symbolic-task>` token must remain byte-for-byte the
    // declared cluster key while task descriptor/cell references are rewritten below.
    if (value.startsWith("fixture-source/")) return value;
    let mapped = value;
    for (const [before, after] of replacements) mapped = mapped.replaceAll(before, after);
    return mapped;
  }
  if (Array.isArray(value)) return value.map((entry) => mapStringsDeep(entry, replacements));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      mapStringsDeep(key, replacements) as string,
      mapStringsDeep(nested, replacements),
    ]));
  }
  return value;
}

function sortIdentifierArraysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    const nested = value.map(sortIdentifierArraysDeep);
    return nested.every((entry) => typeof entry === "string")
      && nested.every((entry) => /^[a-f0-9]{64}(?:\/[A-Za-z0-9_-]+\/[1-9][0-9]*)?$/.test(entry as string))
      ? [...nested].sort()
      : nested;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      sortIdentifierArraysDeep(nested),
    ]));
  }
  return value;
}

function verdictEnvelopeBytes(labelDigest: string, outcome: VerdictOutcome): Uint8Array {
  const statement: ResultEvaluationStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `fixture/${labelDigest}`, digest: { sha256: labelDigest.slice("sha256:".length) } }],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluatedAt: "2026-07-29T00:00:00Z",
      evaluator: { id: "urn:uuid:77777777-7777-5777-8777-777777777777" },
      taskSubject: "execution/task/task.json",
      resultSubjects: ["execution/result/result.json"],
      verdict: outcome.verdict,
      ...(outcome.inconclusiveClass === undefined
        ? {}
        : { limitations: [`inconclusiveClass:${outcome.inconclusiveClass}`] }),
    },
  };
  return buildVerdictEnvelope(statement, [{ keyid: "did:key:zFixture", sig: "AA==" }]);
}

interface MutableFixtureCell {
  cellKey: string;
  taskDigest: string;
  armId: string;
  replicate: number;
  dispatches: number;
  accounted?: number;
  submission?: string;
  delivery?: string;
  verdicts: string[];
  validVerdicts: string[];
  outcome: "judged" | "unjudged" | "unscorable" | "expired" | "invalidated" | "excluded";
  integrityTier?: "re-derivable" | "attested-only";
  cost?: { value: string; unit: string; source: "reported" | "settled" };
  verification: {
    harness: "match" | "mismatch" | "unverifiable";
    model: "match" | "mismatch" | "unverifiable";
    loadout: "match" | "mismatch" | "unverifiable";
    isolation: "match" | "mismatch" | "unverifiable";
    checksFailed: string[];
  };
}

interface MutableFixtureMatrix {
  run: { digest: { sha256: string } };
  cells: MutableFixtureCell[];
  exclusions: Array<{ cellKey: string; reason: string }>;
  attrition: {
    perArm: Record<string, {
      expected: number;
      judged: number;
      unjudged: number;
      unscorable: number;
      expired: number;
      invalidated: number;
      excluded: number;
      replacements: number;
    }>;
    asymmetryFlags: string[];
  };
  completeness: {
    expected: number;
    judged: number;
    floor: string;
    runOutcome: "complete" | "partial" | "cancelled";
  };
}

function fixtureDigest(label: string): string {
  return documentDigest(new TextEncoder().encode(label));
}

/** Materialize the readable method fixtures as internally valid Matrix records before sealing. */
function normalizeFixtureMatrix(matrix: MutableFixtureMatrix, matrixIndex: number): void {
  for (const [cellIndex, cell] of matrix.cells.entries()) {
    if (cell.dispatches > 0) {
      cell.accounted ??= cell.dispatches;
      cell.submission ??= fixtureDigest(`fixture-submission/${matrixIndex}/${cellIndex}/${cell.cellKey}`);
    }
    if (
      ["judged", "unjudged", "unscorable", "invalidated"].includes(cell.outcome)
      && cell.delivery === undefined
    ) {
      cell.delivery = fixtureDigest(`fixture-delivery/${matrixIndex}/${cellIndex}/${cell.cellKey}`);
    }
    cell.verdicts.sort();
    cell.validVerdicts.sort();
    cell.verification.checksFailed.sort();
  }
  matrix.cells.sort((left, right) => left.cellKey < right.cellKey ? -1 : left.cellKey > right.cellKey ? 1 : 0);

  const reasonByCell = new Map(matrix.exclusions.map((entry) => [entry.cellKey, entry.reason]));
  matrix.exclusions = matrix.cells
    .filter((cell) => cell.outcome === "excluded")
    .map((cell) => ({
      cellKey: cell.cellKey,
      reason: reasonByCell.get(cell.cellKey) ?? "fixture-participant-exclusion",
    }));

  const perArm: MutableFixtureMatrix["attrition"]["perArm"] = {};
  for (const cell of matrix.cells) {
    const counts = perArm[cell.armId] ?? {
      expected: 0,
      judged: 0,
      unjudged: 0,
      unscorable: 0,
      expired: 0,
      invalidated: 0,
      excluded: 0,
      replacements: 0,
    };
    counts.expected += 1;
    counts[cell.outcome] += 1;
    counts.replacements += Math.max(0, cell.dispatches - 1);
    perArm[cell.armId] = counts;
  }
  matrix.attrition.perArm = perArm;
  const vectors = Object.values(perArm).map((counts) =>
    [
      counts.unjudged,
      counts.unscorable,
      counts.expired,
      counts.invalidated,
      counts.excluded,
      counts.replacements,
    ].join("/")
  );
  if (Object.keys(perArm).length < 2 || new Set(vectors).size <= 1) {
    matrix.attrition.asymmetryFlags = [];
  } else {
    matrix.attrition.asymmetryFlags.sort();
  }

  matrix.completeness.expected = matrix.cells.length;
  matrix.completeness.judged = matrix.cells.filter((cell) => cell.outcome === "judged").length;
  if (matrix.completeness.runOutcome !== "cancelled") {
    const denominator = matrix.cells.filter((cell) => cell.outcome !== "excluded").length;
    const ratio = denominator === 0 ? 0 : matrix.completeness.judged / denominator;
    matrix.completeness.runOutcome = ratio >= Number(matrix.completeness.floor) ? "complete" : "partial";
  }
}

interface PreparedMethodFixture {
  readonly matrices: MatrixRecord[];
  readonly subjects: MethodSubject[];
  readonly expectedResults: unknown;
  readonly ports: Pick<
    MethodComputeInput,
    | "resolveVerdictBytes"
    | "resolveRunBytes"
    | "resolveTaskBytes"
    | "resolveAnchoredBenchmarkAnnouncement"
    | "verifyAnchoredBenchmarkAnnouncement"
  >;
  readonly verdictBytes: Map<string, Uint8Array>;
  readonly runBytes: Map<string, Uint8Array>;
  readonly taskBytes: Map<string, Uint8Array>;
}

function subjectEntries(matrices: readonly MatrixRecord[]): MethodSubject[] {
  return matrices.map((matrix) => ({
    subjectSha256: sealMatrix(matrix).digest.slice("sha256:".length),
    matrix,
  }));
}

function onlySubjectResults(results: MethodResults): unknown {
  expect(results.perSubject).toHaveLength(1);
  return results.perSubject[0]!.results;
}

function clusterBcaMethodFixture(
  fixture: ClusterBcaOracleFixture,
  regroup = false,
): MethodFixture {
  const verdictOutcomes: Record<string, VerdictOutcome> = {};
  let verdictIndex = 1;
  const cells: MutableFixtureCell[] = [];
  for (const task of fixture.tasks) {
    for (const [armId, rate] of [["armA", task.pA], ["armB", task.pB]] as const) {
      const [numerator, denominator] = rate;
      const replicates = 20;
      const passes = numerator * (replicates / denominator);
      for (let replicate = 1; replicate <= replicates; replicate += 1) {
        const verdictDigest = `sha256:${(verdictIndex++).toString(16).padStart(64, "0")}`;
        verdictOutcomes[verdictDigest] = { verdict: replicate <= passes ? "pass" : "fail" };
        cells.push({
          cellKey: `${task.taskDigest}/${armId}/${replicate}`,
          taskDigest: task.taskDigest,
          armId,
          replicate,
          dispatches: 1,
          verdicts: [verdictDigest],
          validVerdicts: [verdictDigest],
          outcome: "judged",
          integrityTier: "re-derivable",
          verification: {
            harness: "match",
            model: "match",
            loadout: "match",
            isolation: "match",
            checksFailed: [],
          },
        });
      }
    }
  }
  const taskProvenance = Object.fromEntries(fixture.tasks.map((task) => [
    task.taskDigest,
    regroup && task.taskDigest === fixture.regroup.taskDigest
      ? fixture.regroup.provenance
      : task.provenance,
  ]));
  return {
    methodId: fixture.methodId,
    methodVersion: fixture.methodVersion,
    parameters: fixture.parameters,
    verdictRule: fixture.verdictRule,
    matrices: [{
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      run: { digest: { sha256: "0".repeat(64) } },
      closeBoundary: { at: "2026-08-04T00:00:00Z" },
      cells,
      exclusions: [],
      attrition: { perArm: {}, asymmetryFlags: [] },
      completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "complete" },
      assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
    }],
    verdictOutcomes,
    taskProvenance,
    runReplicates: 20,
    expectedResults: {},
  };
}

function exactTaskDigestsByFixtureLabel(
  prepared: PreparedMethodFixture,
): ReadonlyMap<string, string> {
  const byLabel = new Map<string, string>();
  for (const [digest, bytes] of prepared.taskBytes) {
    const task = JSON.parse(new TextDecoder().decode(bytes)) as { instructions: string };
    byLabel.set(task.instructions.slice("Fixture task ".length), digest.slice("sha256:".length));
  }
  return byLabel;
}

function expectedPublicForPrepared(
  expected: unknown,
  prepared: PreparedMethodFixture,
): unknown {
  return sortIdentifierArraysDeep(mapStringsDeep(expected, exactTaskDigestsByFixtureLabel(prepared)));
}


/**
 * Turns the readable semantic fixture labels into exact canonical record bytes before invoking a
 * subject. The transformation is part of the kit oracle, not the implementation under test:
 * every old task/verdict/run reference is replaced with the digest of independently sealed bytes,
 * and expected task/cell keys are transformed by the same explicit map.
 */
function prepareFixture(fixture: MethodFixture): PreparedMethodFixture {
  const taskBytes = new Map<string, Uint8Array>();
  const verdictBytes = new Map<string, Uint8Array>();
  const runBytes = new Map<string, Uint8Array>();
  const announcements = new Map<string, {
    envelopeBytes: Uint8Array;
    entryBytes: Uint8Array;
    entryDigest: string;
    source: { agent: string; name: string };
  }>();
  const replacements = new Map<string, string>();

  const rawMatrices = structuredClone(fixture.matrices) as MutableFixtureMatrix[];
  const repositoryWorkProfile = buildRepositoryWorkProfile();
  const repositoryWorkProfileDigest = sealTaskProfile(repositoryWorkProfile).digest.slice("sha256:".length);

  const oldTaskDigests = [...new Set(rawMatrices.flatMap((matrix) => matrix.cells.map((cell) => cell.taskDigest)))];
  for (const oldTaskDigest of oldTaskDigests) {
    const task = sealTask({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: { digest: { sha256: repositoryWorkProfileDigest } },
      instructions: `Fixture task ${oldTaskDigest}`,
      payload: {
        language: "TypeScript",
        provenance: {
          ...(fixture.taskProvenance?.[oldTaskDigest]
            ?? { source: fixture.clusterKeys?.[oldTaskDigest] ?? `fixture-source/${oldTaskDigest}` }),
          timestamp: fixture.taskTimestamps?.[oldTaskDigest] ?? "2026-07-29T00:00:00Z",
        },
      },
      outputs: [{ name: "result", mediaType: "application/json", required: true }],
      evaluation: { digest: { sha256: "e".repeat(64) } },
    });
    const exactDigest = documentDigest(task);
    taskBytes.set(exactDigest, task);
    replacements.set(oldTaskDigest, exactDigest.slice("sha256:".length));
  }

  const verdictReplacements = new Map<string, string>();
  for (const [oldVerdictDigest, outcome] of Object.entries(fixture.verdictOutcomes)) {
    const bytes = verdictEnvelopeBytes(oldVerdictDigest, outcome);
    const exactDigest = recordDigest(bytes);
    verdictBytes.set(exactDigest, bytes);
    verdictReplacements.set(oldVerdictDigest, exactDigest);
  }

  rawMatrices.forEach((matrix, matrixIndex) => {
    for (const cell of matrix.cells) {
      const oldTaskDigest = cell.taskDigest;
      const exactTaskDigest = replacements.get(oldTaskDigest)!;
      cell.taskDigest = exactTaskDigest;
      cell.cellKey = `${exactTaskDigest}/${cell.armId}/${cell.replicate}`;
      cell.verdicts = cell.verdicts.map((digest) => verdictReplacements.get(digest) ?? digest).sort();
      cell.validVerdicts = cell.validVerdicts.map((digest) => verdictReplacements.get(digest) ?? digest).sort();
    }
    normalizeFixtureMatrix(matrix, matrixIndex);

    const armIds = [...new Set(matrix.cells.map((cell) => cell.armId))].sort();
    const benchmarkDigest = `sha256:${String(matrixIndex + 1).padStart(64, "b")}`;
    const methodParameters = { ...fixture.parameters, verdictRule: fixture.verdictRule };
    const sealedRun = sealRun({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      benchmark: { digest: { sha256: benchmarkDigest.slice("sha256:".length) } },
      owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
      arms: armIds.map((armId) => ({ armId, pinning: { "fixture/arm": armId } })),
      replicates: fixture.runReplicates
        ?? Math.max(...matrix.cells.map((cell) => cell.replicate)),
      policy: {
        completenessFloor: "1",
        cellWindow: 60_000,
        replacement: { allowed: false },
        independence: "disclosed",
        evaluation: {},
        submissionBaseline: {},
      },
      analysisPlan: [{
        method: fixture.methodId,
        version: fixture.methodVersion,
        parameters: methodParameters,
      }],
      closeAt: "2026-08-04T00:00:00Z",
    });
    runBytes.set(sealedRun.digest, sealedRun.bytes);
    matrix.run.digest.sha256 = sealedRun.digest.slice("sha256:".length);

    const entryBytes = canonicalJsonBytes({
      protocol: "https://spec.jinn.network/record-discovery/v1",
      source: { agent: "urn:uuid:88888888-8888-5888-8888-888888888888", name: "fixture" },
      sequence: "0000000000000001",
      previous: null,
      timestamp: "2026-07-29T00:00:00Z",
      announcements: [{
        announcementId: `benchmark-${matrixIndex}`,
        action: "available",
        record: {
          kind: "https://spec.jinn.network/records/benchmark/v1",
          digest: benchmarkDigest,
        },
      }],
    });
    const envelopeBytes = canonicalJsonBytes({
      payloadType: "application/vnd.jinn.discovery.entry.v1+json",
      payload: Buffer.from(entryBytes).toString("base64"),
      signatures: [{ keyid: "did:key:zFixture", sig: "AA==" }],
    });
    announcements.set(benchmarkDigest, {
      envelopeBytes,
      entryBytes,
      entryDigest: recordDigest(entryBytes),
      source: {
        agent: "urn:uuid:88888888-8888-5888-8888-888888888888",
        name: "fixture",
      },
    });
  });

  for (const [before, after] of verdictReplacements) replacements.set(before, after);
  const matrices = parseMatrices(rawMatrices);
  const subjects = subjectEntries(matrices);
  subjects.forEach((subject, index) => replacements.set(`$subject:${index}`, subject.subjectSha256));
  const mappedExpected = sortIdentifierArraysDeep(mapStringsDeep(fixture.expectedResults, replacements));
  const expectedResults = (
    typeof mappedExpected === "object"
    && mappedExpected !== null
    && Object.hasOwn(mappedExpected, "perSubject")
  )
    ? mappedExpected
    : {
        perSubject: [{
          subjectSha256: subjects[0]!.subjectSha256,
          results: mappedExpected,
        }],
      };
  return {
    matrices,
    subjects,
    expectedResults,
    ports: {
      resolveVerdictBytes: (digest) => verdictBytes.get(digest),
      resolveRunBytes: (digest) => runBytes.get(digest),
      resolveTaskBytes: (digest) => taskBytes.get(digest),
      resolveAnchoredBenchmarkAnnouncement: (digest) => announcements.get(digest)?.envelopeBytes,
      verifyAnchoredBenchmarkAnnouncement: (request) => {
        const expected = announcements.get(request.benchmarkDigest);
        if (
          expected === undefined
          || request.entryDigest !== expected.entryDigest
          || request.source.agent !== expected.source.agent
          || request.source.name !== expected.source.name
          || recordDigest(request.envelopeBytes) !== recordDigest(expected.envelopeBytes)
          || recordDigest(request.entryBytes) !== recordDigest(expected.entryBytes)
        ) {
          return { ok: false, reason: "fixture Discovery proof mismatch" };
        }
        return {
          ok: true,
          source: expected.source,
          verifiedEntryDigests: [expected.entryDigest],
          headDigest: expected.entryDigest,
          anchor: {
            digest: expected.entryDigest,
            anchorTime: "2026-07-29T00:00:00Z",
          },
        };
      },
    },
    verdictBytes,
    runBytes,
    taskBytes,
  };
}

/**
 * §16 method-registry conformance (design §9.2, §14.7): for each fixture, `registry.get(id,
 * version)!.compute(...)` MUST reproduce `expectedResults` exactly — the `report-recompute`
 * contract at the method-registry granularity. RED until an implementer (aggregate, M3) exists;
 * `aggregate`'s own `method-conformance.test.ts` is the first green run of this driver.
 */
export function describeMethodRegistryConformance(registry: MethodRegistry): void {
  describe("benchmarking method-registry conformance (design §9.2/§16)", () => {
    test("fixture set is non-empty", async () => {
      expect((await computeFixtureNames()).length).toBeGreaterThan(0);
    });

    // Both fixtures share every numeric expectation: cluster keys are opaque strings and the
    // realistic repo URLs sort into the same positions as the synthetic family tokens, so the
    // grouping structure and cluster ordering are identical. The repo-keys variant is the
    // conformance guard for realistic `https://github.com/owner/repo` provenance, where several
    // tasks share one source repo — a reversion to per-instance keys makes each task its own
    // singleton cluster and turns the pinned cluster count and draws red.
    test.each([
      "noninferiority-cluster-bca.json",
      "noninferiority-cluster-bca-repo-keys.json",
    ])("pins the mandatory non-vacuous whole-source-cluster BCa oracle and re-sealed grouping discriminator (%s)", async (fixtureName) => {
      const fixture = await loadJson<ClusterBcaOracleFixture>(fixtureName);
      expect(fixture.oracle).toEqual({
        alpha: 0.05,
        minN: 5,
        deltaAbs: 0.05,
        relativeCap: 0.15,
      });
      expect(fixture.expectedPrimitive).toEqual({
        observed: 0.04166666666666668,
        lowerBound: -0.225,
        acceleration: 0.0627085632050839,
        biasCorrection: -0.0828132919872456,
        adjustedQuantile: 0.05033626184818413,
        adjustedIndex: 50,
        draws: 3_000,
        unit: "source-cluster",
      });

      const groupedSemantic = clusterBcaMethodFixture(fixture);
      const regroupedSemantic = clusterBcaMethodFixture(fixture, true);
      expect(regroupedSemantic.parameters).toEqual(groupedSemantic.parameters);
      expect(regroupedSemantic.matrices).toEqual(groupedSemantic.matrices);
      expect(regroupedSemantic.verdictOutcomes).toEqual(groupedSemantic.verdictOutcomes);

      const grouped = prepareFixture(groupedSemantic);
      const regrouped = prepareFixture(regroupedSemantic);
      const groupedDigests = exactTaskDigestsByFixtureLabel(grouped);
      const regroupedDigests = exactTaskDigestsByFixtureLabel(regrouped);
      for (const task of fixture.tasks) {
        if (task.taskDigest === fixture.regroup.taskDigest) {
          expect(regroupedDigests.get(task.taskDigest)).not.toBe(groupedDigests.get(task.taskDigest));
        } else {
          expect(regroupedDigests.get(task.taskDigest)).toBe(groupedDigests.get(task.taskDigest));
        }
      }

      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const compute = (prepared: PreparedMethodFixture) => onlySubjectResults(method.compute!({
        subjects: prepared.subjects,
        parameters: { ...fixture.parameters, verdictRule: fixture.verdictRule },
        verdictRule: fixture.verdictRule,
        registry,
        ...prepared.ports,
      })) as { quality: unknown; bootstrap: unknown };
      const groupedResult = compute(grouped);
      expect({
        quality: groupedResult.quality,
        bootstrap: groupedResult.bootstrap,
      }).toEqual(expectedPublicForPrepared(fixture.expectedPublic, grouped));

      // The clustering is non-vacuous: strictly fewer clusters than tasks, several tasks per
      // source key, and `draws === resamples * clusterCount`.
      const groupedBootstrap = groupedResult.bootstrap as {
        readonly count: number;
        readonly draws: number;
        readonly clusters: readonly { readonly members: readonly string[] }[];
      };
      expect(groupedBootstrap.count).toBe(3);
      expect(groupedBootstrap.draws).toBe((fixture.parameters["resamples"] as number) * 3);
      expect(groupedBootstrap.clusters).toHaveLength(3);
      expect(fixture.tasks.length).toBeGreaterThan(groupedBootstrap.count);
      expect(groupedBootstrap.clusters.filter((cluster) => cluster.members.length > 1).length).toBeGreaterThan(0);

      const regroupedResult = compute(regrouped);
      expect({
        quality: regroupedResult.quality,
        bootstrap: regroupedResult.bootstrap,
      }).toEqual(expectedPublicForPrepared(fixture.regroup.expectedPublic, regrouped));
      expect(fixture.regroup.expectedPrimitive).toEqual({
        observed: 0.04166666666666668,
        lowerBound: -0.2,
        acceleration: 0.025555839127816213,
        biasCorrection: -0.002506630902398872,
        adjustedQuantile: 0.05667480707950723,
        adjustedIndex: 56,
        draws: 3_000,
      });
    });

    test("method fixtures materialize real published repository-work profile Tasks", async () => {
      const prepared = prepareFixture(await loadFixture("noninferiority-pass.json"));
      const profileDigest = sealTaskProfile(buildRepositoryWorkProfile()).digest.slice("sha256:".length);
      for (const bytes of prepared.taskBytes.values()) {
        const task = JSON.parse(new TextDecoder().decode(bytes)) as { profile?: { digest?: { sha256?: string } }; payload?: { provenance?: unknown } };
        expect(task.profile?.digest?.sha256).toBe(profileDigest);
        expect(task.payload?.provenance).toMatchObject({ timestamp: "2026-07-29T00:00:00Z" });
      }
    });

    test("noninferiority resolves provenance and changes its uncertainty under whole-source grouping", async () => {
      const original = await loadFixture("noninferiority-pass.json");
      const varied = structuredClone(original) as Omit<MethodFixture, "matrices" | "verdictOutcomes"> & { matrices: Array<{ cells: Array<{ armId: string; taskDigest: string; validVerdicts: string[] }> }>; verdictOutcomes: Record<string, VerdictOutcome> };
      const taskDigests = [...new Set(varied.matrices.flatMap((matrix) => matrix.cells.map((cell) => cell.taskDigest)))];
      for (const [index, cell] of varied.matrices[0]!.cells.entries()) {
        if (cell.armId === "armB" && index % 4 === 1) {
          for (const digest of cell.validVerdicts) varied.verdictOutcomes[digest] = { verdict: "fail" };
        }
      }
      const independentlyGrouped = structuredClone(varied) as Omit<typeof varied, "clusterKeys"> & { clusterKeys?: Record<string, string> };
      independentlyGrouped.clusterKeys = Object.fromEntries(taskDigests.map((digest, index) => [digest, index < 5 ? "family-a" : "family-b"]));
      const method = registry.get(varied.methodId, varied.methodVersion)!;
      const compute = (fixture: MethodFixture) => method.compute!({
        ...(() => {
          const prepared = prepareFixture(fixture);
          return { subjects: subjectEntries(prepared.matrices), parameters: fixture.parameters,
            verdictRule: fixture.verdictRule, registry, ...prepared.ports };
        })(),
      }).perSubject[0]!.results as { bootstrap: { lowerBound?: string; count: number; unit: string } };
      const iidLike = compute(varied);
      const grouped = compute(independentlyGrouped);
      expect(iidLike.bootstrap).toMatchObject({ unit: "source-cluster", count: 10 });
      expect(grouped.bootstrap).toMatchObject({ unit: "source-cluster", count: 2 });
      expect(grouped.bootstrap).not.toEqual(iidLike.bootstrap);
    });

    test("noninferiority cost forms one exact Task mean difference despite asymmetric R=2 passing repeats", async () => {
      const fixture = structuredClone(await loadFixture("noninferiority-pass.json")) as Omit<MethodFixture, "matrices" | "runReplicates"> & {
        matrices: MutableFixtureMatrix[];
        runReplicates?: number;
      };
      const matrix = fixture.matrices[0] as MutableFixtureMatrix;
      const original = [...matrix.cells];
      for (const cell of original) {
        if (cell.armId === "armA") {
          cell.cost = { value: "1.0", unit: "USD", source: "reported" };
          matrix.cells.push({ ...structuredClone(cell), replicate: 2, cellKey: `${cell.taskDigest}/armA/2`, cost: { value: "9.0", unit: "USD", source: "reported" } });
        } else {
          cell.cost = { value: "6.0", unit: "USD", source: "reported" };
          matrix.cells.push({
            ...structuredClone(cell), replicate: 2, cellKey: `${cell.taskDigest}/armB/2`,
            verdicts: [], validVerdicts: [], outcome: "expired",
          });
        }
      }
      fixture.runReplicates = 2;
      const prepared = prepareFixture(fixture);
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const result = onlySubjectResults(method.compute!({
        subjects: prepared.subjects,
        parameters: { ...fixture.parameters, verdictRule: fixture.verdictRule },
        verdictRule: fixture.verdictRule,
        registry,
        ...prepared.ports,
      })) as {
        verdict: string;
        pairing: { taskDigests: string[] };
        quality: unknown;
        cost: { verdict: string; pValue: string | null; n: number; replay: { scale: string; differences: string[] }; excluded: { count: number; cellKeys: string[] } };
        excluded: { count: number; cellKeys: string[] };
        conflicted: unknown;
        bootstrap: unknown;
      };
      const taskDigests = [...prepared.taskBytes.keys()]
        .map((digest) => digest.slice("sha256:".length))
        .sort();
      const sourceByTaskDigest = new Map([...prepared.taskBytes.entries()].map(([digest, bytes]) => [
        digest.slice("sha256:".length),
        `fixture-source/${(JSON.parse(new TextDecoder().decode(bytes)) as { instructions: string }).instructions.slice("Fixture task ".length)}`,
      ]));
      const asymmetricCandidateCells = taskDigests.map((digest) => `${digest}/armB/2`).sort();
      const expectedClusters = taskDigests.map((digest) => ({
        key: ["source", sourceByTaskDigest.get(digest)!],
        members: [digest],
      })).sort((left, right) => left.key[1] < right.key[1] ? -1 : left.key[1] > right.key[1] ? 1 : 0);
      expect(result).toEqual({
        verdictRule: "unanimous",
        baseline: "armA",
        candidate: "armB",
        verdict: "FAIL",
        pairing: { taskDigests },
        quality: { verdict: "pass", lowerBound: "0.0000", relativeRegression: "0.0000", reasons: [] },
        cost: {
          verdict: "not-lower", pValue: "0.9978", n: 10,
          replay: { scale: "1", differences: Array.from({ length: 10 }, () => "10") },
          excluded: { count: 10, cellKeys: asymmetricCandidateCells },
        },
        excluded: { count: 10, cellKeys: asymmetricCandidateCells },
        conflicted: { count: 0, cellKeys: [] },
        bootstrap: {
          procedure: "xorshift32-v1", seed: 123456789, resamples: 1000,
          basis: "task-provenance-source-family", count: 10, unit: "source-cluster", draws: 10_000,
          clusters: expectedClusters,
        },
      });
    });

    test("noninferiority cost keeps denominator-three Task means exact in public replay", async () => {
      const fixture = structuredClone(await loadFixture("noninferiority-pass.json")) as Omit<MethodFixture, "matrices" | "runReplicates"> & {
        matrices: MutableFixtureMatrix[];
        runReplicates?: number;
      };
      const matrix = fixture.matrices[0] as MutableFixtureMatrix;
      const original = [...matrix.cells];
      for (const cell of original) {
        if (cell.armId === "armA") {
          cell.cost = { value: "1.0", unit: "USD", source: "reported" };
          for (const replicate of [2, 3]) {
            matrix.cells.push({ ...structuredClone(cell), replicate, cellKey: `${cell.taskDigest}/armA/${replicate}`, cost: { value: "1.0", unit: "USD", source: "reported" } });
          }
        } else {
          cell.cost = { value: "0.0", unit: "USD", source: "reported" };
          matrix.cells.push({ ...structuredClone(cell), replicate: 2, cellKey: `${cell.taskDigest}/armB/2`, cost: { value: "0.0", unit: "USD", source: "reported" } });
          matrix.cells.push({ ...structuredClone(cell), replicate: 3, cellKey: `${cell.taskDigest}/armB/3`, cost: { value: "1.0", unit: "USD", source: "reported" } });
        }
      }
      fixture.runReplicates = 3;
      const prepared = prepareFixture(fixture);
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const result = onlySubjectResults(method.compute!({
        subjects: prepared.subjects,
        parameters: { ...fixture.parameters, verdictRule: fixture.verdictRule },
        verdictRule: fixture.verdictRule,
        registry,
        ...prepared.ports,
      })) as {
        verdictRule: string;
        baseline: string;
        candidate: string;
        verdict: string;
        pairing: { taskDigests: string[] };
        quality: unknown;
        cost: { verdict: string; pValue: string | null; n: number; replay: { scale: string; divisors: string[]; differences: string[] }; excluded: { count: number; cellKeys: string[] } };
        excluded: { count: number; cellKeys: string[] };
        conflicted: unknown;
        bootstrap: unknown;
      };
      const taskDigests = [...prepared.taskBytes.keys()]
        .map((digest) => digest.slice("sha256:".length))
        .sort();
      const sourceByTaskDigest = new Map([...prepared.taskBytes.entries()].map(([digest, bytes]) => [
        digest.slice("sha256:".length),
        `fixture-source/${(JSON.parse(new TextDecoder().decode(bytes)) as { instructions: string }).instructions.slice("Fixture task ".length)}`,
      ]));
      const expectedClusters = taskDigests.map((digest) => ({
        key: ["source", sourceByTaskDigest.get(digest)!],
        members: [digest],
      })).sort((left, right) => left.key[1] < right.key[1] ? -1 : left.key[1] > right.key[1] ? 1 : 0);
      expect(result).toEqual({
        verdictRule: "unanimous",
        baseline: "armA",
        candidate: "armB",
        verdict: "PASS",
        pairing: { taskDigests },
        quality: { verdict: "pass", lowerBound: "0.0000", relativeRegression: "0.0000", reasons: [] },
        cost: {
          verdict: "lower", pValue: "0.0030", n: 10,
          replay: { scale: "1", divisors: Array.from({ length: 10 }, () => "3"), differences: Array.from({ length: 10 }, () => "-20") },
          excluded: { count: 0, cellKeys: [] },
        },
        excluded: { count: 0, cellKeys: [] },
        conflicted: { count: 0, cellKeys: [] },
        bootstrap: {
          procedure: "xorshift32-v1", seed: 123456789, resamples: 1000,
          basis: "task-provenance-source-family", count: 10, unit: "source-cluster", draws: 10_000,
          clusters: expectedClusters,
        },
      });
    });

    test("noninferiority cost emits scale-zero rational replay for integer-spelled denominator-three means", async () => {
      const fixture = structuredClone(await loadFixture("noninferiority-pass.json")) as Omit<MethodFixture, "matrices" | "runReplicates"> & {
        matrices: MutableFixtureMatrix[];
        runReplicates?: number;
      };
      const matrix = fixture.matrices[0] as MutableFixtureMatrix;
      const original = [...matrix.cells];
      for (const cell of original) {
        if (cell.armId === "armA") {
          cell.cost = { value: "1", unit: "USD", source: "reported" };
          for (const replicate of [2, 3]) {
            matrix.cells.push({ ...structuredClone(cell), replicate, cellKey: `${cell.taskDigest}/armA/${replicate}`, cost: { value: "1", unit: "USD", source: "reported" } });
          }
        } else {
          cell.cost = { value: "0", unit: "USD", source: "reported" };
          matrix.cells.push({ ...structuredClone(cell), replicate: 2, cellKey: `${cell.taskDigest}/armB/2`, cost: { value: "0", unit: "USD", source: "reported" } });
          matrix.cells.push({ ...structuredClone(cell), replicate: 3, cellKey: `${cell.taskDigest}/armB/3`, cost: { value: "1", unit: "USD", source: "reported" } });
        }
      }
      fixture.runReplicates = 3;
      const prepared = prepareFixture(fixture);
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const result = onlySubjectResults(method.compute!({
        subjects: prepared.subjects,
        parameters: { ...fixture.parameters, verdictRule: fixture.verdictRule },
        verdictRule: fixture.verdictRule,
        registry,
        ...prepared.ports,
      })) as {
        verdictRule: string;
        baseline: string;
        candidate: string;
        verdict: string;
        pairing: { taskDigests: string[] };
        quality: unknown;
        cost: { verdict: string; pValue: string | null; n: number; replay: { scale: string; divisors: string[]; differences: string[] }; excluded: { count: number; cellKeys: string[] } };
        excluded: { count: number; cellKeys: string[] };
        conflicted: unknown;
        bootstrap: unknown;
      };
      const taskDigests = [...prepared.taskBytes.keys()]
        .map((digest) => digest.slice("sha256:".length))
        .sort();
      const sourceByTaskDigest = new Map([...prepared.taskBytes.entries()].map(([digest, bytes]) => [
        digest.slice("sha256:".length),
        `fixture-source/${(JSON.parse(new TextDecoder().decode(bytes)) as { instructions: string }).instructions.slice("Fixture task ".length)}`,
      ]));
      const expectedClusters = taskDigests.map((digest) => ({
        key: ["source", sourceByTaskDigest.get(digest)!],
        members: [digest],
      })).sort((left, right) => left.key[1] < right.key[1] ? -1 : left.key[1] > right.key[1] ? 1 : 0);
      expect(result).toEqual({
        verdictRule: "unanimous",
        baseline: "armA",
        candidate: "armB",
        verdict: "PASS",
        pairing: { taskDigests },
        quality: { verdict: "pass", lowerBound: "0.0000", relativeRegression: "0.0000", reasons: [] },
        cost: {
          verdict: "lower", pValue: "0.0030", n: 10,
          replay: { scale: "0", divisors: Array.from({ length: 10 }, () => "3"), differences: Array.from({ length: 10 }, () => "-2") },
          excluded: { count: 0, cellKeys: [] },
        },
        excluded: { count: 0, cellKeys: [] },
        conflicted: { count: 0, cellKeys: [] },
        bootstrap: {
          procedure: "xorshift32-v1", seed: 123456789, resamples: 1000,
          basis: "task-provenance-source-family", count: 10, unit: "source-cluster", draws: 10_000,
          clusters: expectedClusters,
        },
      });
    });

    test("noninferiority-iut refuses a single source cluster at the public method path", async () => {
      const fixture = structuredClone(await loadFixture("noninferiority-pass.json")) as Omit<MethodFixture, "matrices" | "taskProvenance"> & {
        matrices: MutableFixtureMatrix[];
        taskProvenance?: Record<string, { source?: string }>;
      };
      const sharedSource = "fixture-source/shared-cluster";
      const taskDigests = [...new Set(fixture.matrices[0]!.cells.map((cell) => cell.taskDigest))];
      fixture.taskProvenance = Object.fromEntries(taskDigests.map((taskDigest) => [taskDigest, { source: sharedSource }]));
      const prepared = prepareFixture(fixture);
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const result = onlySubjectResults(method.compute!({
        subjects: prepared.subjects,
        parameters: { ...fixture.parameters, verdictRule: fixture.verdictRule },
        verdictRule: fixture.verdictRule,
        registry,
        ...prepared.ports,
      })) as {
        verdictRule: string;
        baseline: string;
        candidate: string;
        verdict: string;
        pairing: { taskDigests: string[] };
        quality: { verdict: string; lowerBound: string | null; relativeRegression: string | null; reasons: string[] };
        cost: { verdict: string; pValue: string | null; n: number; excluded: { count: number; cellKeys: string[] } };
        excluded: { count: number; cellKeys: string[] };
        conflicted: { count: number; cellKeys: string[] };
        bootstrap: {
          procedure: string;
          seed: number;
          resamples: number;
          basis: string;
          count: number;
          unit: string;
          draws: number;
          clusters: Array<{ key: [string, string]; members: string[] }>;
        };
      };
      const pairedTaskDigests = [...prepared.taskBytes.keys()]
        .map((digest) => digest.slice("sha256:".length))
        .sort();
      expect(result).toEqual({
        verdictRule: "unanimous",
        baseline: "armA",
        candidate: "armB",
        verdict: "INCONCLUSIVE",
        pairing: { taskDigests: pairedTaskDigests },
        quality: {
          verdict: "inconclusive",
          lowerBound: null,
          relativeRegression: null,
          reasons: ["fewer than two source clusters (got 1)"],
        },
        cost: {
          verdict: "lower",
          pValue: "0.0030",
          n: 10,
          excluded: { count: 0, cellKeys: [] },
        },
        excluded: { count: 0, cellKeys: [] },
        conflicted: { count: 0, cellKeys: [] },
        bootstrap: {
          procedure: "xorshift32-v1",
          seed: 123456789,
          resamples: 1000,
          basis: "task-provenance-source-family",
          count: 1,
          unit: "source-cluster",
          draws: 0,
          clusters: [{
            key: ["source", sharedSource],
            members: pairedTaskDigests,
          }],
        },
      });
    });

    test("plaintext source and opaque source commitment remain tagged, non-colliding cluster identities", async () => {
      const fixture = structuredClone(await loadFixture("noninferiority-pass.json")) as Omit<MethodFixture, "matrices"> & { matrices: Array<{ cells: Array<{ taskDigest: string }> }>; taskProvenance?: Record<string, { source?: string; sourceCommitment?: string }> };
      const [first, second] = [...new Set(fixture.matrices[0]!.cells.map((cell) => cell.taskDigest))];
      const token = `sha256:${"a".repeat(64)}`;
      fixture.taskProvenance = {
        [first!]: { source: "\u0001" },
        [second!]: { source: '"' },
      };
      const prepared = prepareFixture(fixture);
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const result = method.compute!({ subjects: prepared.subjects, parameters: fixture.parameters, verdictRule: fixture.verdictRule, registry, ...prepared.ports })
        .perSubject[0]!.results as { bootstrap: { clusters: Array<{ key: [string, string] }> } };
      const keys = result.bootstrap.clusters.map((cluster) => cluster.key);
      expect(keys).toContainEqual(["source", "\u0001"]);
      expect(keys).toContainEqual(["source", '"']);
      expect(keys.indexOf(keys.find((key) => key[1] === "\u0001")!)).toBeLessThan(
        keys.indexOf(keys.find((key) => key[1] === '"')!),
      );
      // A same-spelling commitment remains a different tagged cluster identity.
      fixture.taskProvenance[second!] = { sourceCommitment: token };
      const committed = prepareFixture(fixture);
      const committedResult = method.compute!({ subjects: committed.subjects, parameters: fixture.parameters, verdictRule: fixture.verdictRule, registry, ...committed.ports })
        .perSubject[0]!.results as { bootstrap: { clusters: Array<{ key: [string, string] }> } };
      expect(committedResult.bootstrap.clusters.map((cluster) => cluster.key)).toContainEqual(["sourceCommitment", token]);
    });

    test("each fixture's method reproduces the pinned expectedResults", async () => {
      for (const name of await computeFixtureNames()) {
        const fixture = await loadFixture(name);
        const prepared = prepareFixture(fixture);
        const method = registry.get(fixture.methodId, fixture.methodVersion);
        expect(method, `registry has no method for ${fixture.methodId}@${fixture.methodVersion} (fixture ${name})`).toBeDefined();
        expect(method!.computeAvailability).toBe("available");
        expect(method!.compute).toBeTypeOf("function");
        const completeParameters = { ...fixture.parameters, verdictRule: fixture.verdictRule };
        expect(method!.validateParameters(completeParameters), `${name} parameters`).toEqual({ ok: true });
        const results = method!.compute!({
          subjects: prepared.subjects,
          parameters: completeParameters,
          verdictRule: fixture.verdictRule,
          registry,
          ...prepared.ports,
        });
        expect(results, `${fixture.methodId}@${fixture.methodVersion} (fixture ${name})`).toEqual(prepared.expectedResults);
      }
    });

    test("paired-delta reports one shared bootstrap ensemble's cluster draws", async () => {
      const fixture = await loadFixture("paired-delta-shared-ensemble.v2.json");
      const prepared = prepareFixture(fixture);
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const results = onlySubjectResults(method.compute!({
        subjects: prepared.subjects,
        parameters: { ...fixture.parameters, verdictRule: fixture.verdictRule },
        verdictRule: fixture.verdictRule,
        registry,
        ...prepared.ports,
      })) as { bootstrap: { draws: number; resamples: number; count: number } };

      expect(results.bootstrap.draws).toBe(results.bootstrap.resamples * results.bootstrap.count);
    });

    test("registry entries reproduce the declarative method-spec fixture", async () => {
      const expected = [
        ...await loadJson<MethodSpecFixture[]>("method-specs.json"),
        await loadJson<MethodSpecFixture>("provenance-cluster-sign-method-spec.json"),
      ];
      for (const spec of expected) {
        const method = registry.get(spec.id, spec.version);
        expect(method, `${spec.id}@${spec.version}`).toBeDefined();
        expect(method).toMatchObject(spec);
        expect(method!.deterministic).toBe(true);
        if (spec.computeAvailability === "unavailable") {
          expect(method!.compute).toBeUndefined();
        } else {
          expect(method!.compute).toBeTypeOf("function");
        }
      }
    });

    test("every v1 reference method reports verdict conflicts with count and cellKeys", async () => {
      const fixture = await loadJson<{
        matrix: unknown;
        verdictOutcomes: Record<string, VerdictOutcome>;
        taskTimestamps: Record<string, string>;
        expectedConflicted: unknown;
        cases: Array<{ methodId: string; parameters: Record<string, unknown> }>;
      }>("conflict-cases.json");
      const provenanceClusterSign = await loadJson<{
        methodId: string;
        parameters: Record<string, unknown>;
      }>("provenance-cluster-sign-conformance.json");
      for (const entry of [...fixture.cases, provenanceClusterSign]) {
        const prepared = prepareFixture({
          methodId: entry.methodId,
          methodVersion: "1",
          parameters: entry.parameters,
          verdictRule: "unanimous",
          matrices: [fixture.matrix],
          verdictOutcomes: fixture.verdictOutcomes,
          taskTimestamps: fixture.taskTimestamps,
          ...(["jinn.benchmarking.method/paired-mcnemar", "jinn.benchmarking.method/provenance-cluster-sign"].includes(entry.methodId)
            ? { runReplicates: 1 }
            : {}),
          expectedResults: {},
        });
        const matrix = prepared.matrices[0]!;
        const method = registry.get(entry.methodId, "1");
        expect(method?.computeAvailability, entry.methodId).toBe("available");
        const results = method!.compute!({
          subjects: subjectEntries([matrix]),
          parameters: { ...entry.parameters, verdictRule: "unanimous" },
          verdictRule: "unanimous",
          registry,
          ...prepared.ports,
        });
        expect((onlySubjectResults(results) as { conflicted?: unknown }).conflicted, entry.methodId).toEqual(
          mapStringsDeep(fixture.expectedConflicted, new Map(
            [...prepared.taskBytes.keys()].map((digest, index) => [
              [...new Set((fixture.matrix as { cells: Array<{ taskDigest: string }> }).cells.map((cell) => cell.taskDigest))][index]!,
              digest.slice("sha256:".length),
            ]),
          )),
        );
      }
    });

    test("paired McNemar R=1 fixture consumes its complete missing/conflicted/one-sided remainder and provenance clustering basis", async () => {
      const fixture = await loadFixture("paired-exclusion-r1.json");
      const prepared = prepareFixture(fixture);
      const method = registry.get("jinn.benchmarking.method/paired-mcnemar", "1")!;
      const results = method.compute!({
        subjects: prepared.subjects,
        parameters: { ...fixture.parameters, verdictRule: "unanimous" },
        verdictRule: "unanimous",
        registry,
        ...prepared.ports,
      });
      expect(results).toEqual(prepared.expectedResults);
      const expected = onlySubjectResults(prepared.expectedResults as MethodResults) as {
        excluded: { count: number; cellKeys: string[] };
        conflicted: { count: number; cellKeys: string[] };
        clustering: { basis: string; clusters: number };
      };
      expect(expected.excluded.count).toBe(expected.excluded.cellKeys.length);
      expect(expected.conflicted.count).toBe(expected.conflicted.cellKeys.length);
      expect(expected.clustering).toEqual({ basis: "task-provenance-source", clusters: 1 });
    });

    test("paired McNemar rejects the separate R>1 fixture before pairing", async () => {
      const fixture = await loadJson<{
        matrix: unknown; verdictOutcomes: Record<string, VerdictOutcome>; clusterKeys: Record<string, string>; parameters: Record<string, unknown>;
      }>("paired-contract.json");
      const prepared = prepareFixture({ methodId: "jinn.benchmarking.method/paired-mcnemar", methodVersion: "1", parameters: fixture.parameters, verdictRule: "unanimous", matrices: [fixture.matrix], verdictOutcomes: fixture.verdictOutcomes, clusterKeys: fixture.clusterKeys, runReplicates: 2, expectedResults: {} });
      const method = registry.get("jinn.benchmarking.method/paired-mcnemar", "1")!;
      expect(() => method.compute!({ subjects: prepared.subjects, parameters: { ...fixture.parameters, verdictRule: "unanimous" }, verdictRule: "unanimous", registry, ...prepared.ports })).toThrow(expect.objectContaining({ name: "MethodInputError", code: "incompatible-run-replicates" }));
    });

    test("noninferiority cost replay normalizes eight long -0.9 and two long +0.10 differences at one comparison-wide scale", async () => {
      const fixture = await loadFixture("noninferiority-pass.json");
      const semantic = structuredClone(fixture) as MethodFixture;
      const matrix = semantic.matrices[0] as { cells: Array<{ taskDigest: string; armId: string; cost?: { value: string; unit: string; source: "reported" | "settled" } }> };
      const taskDigests = [...new Set(matrix.cells.map((cell) => cell.taskDigest))];
      const cheaper = new Set(taskDigests.slice(0, 8));
      const nineTenths = `0.9${"0".repeat(39)}`;
      const oneTenth = `0.10${"0".repeat(38)}`;
      for (const cell of matrix.cells) {
        const candidate = cell.armId === "armB";
        const isCheaper = cheaper.has(cell.taskDigest);
        cell.cost = { value: candidate === isCheaper ? "0" : (isCheaper ? nineTenths : oneTenth), unit: "USD", source: "reported" };
      }
      const prepared = prepareFixture(semantic);
      const method = registry.get("jinn.benchmarking.method/noninferiority-iut", "1")!;
      const result = onlySubjectResults(method.compute!({ subjects: prepared.subjects, parameters: { ...semantic.parameters, verdictRule: semantic.verdictRule }, verdictRule: semantic.verdictRule, registry, ...prepared.ports })) as {
        verdict: string; cost: { verdict: string; pValue: string; n: number; replay: { scale: string; differences: string[] } };
      };
      expect(result.verdict).toBe("PASS");
      expect(result.cost).toEqual({
        verdict: "lower", pValue: "0.0072", n: 10, excluded: { count: 0, cellKeys: [] },
        // Replay order is the method's own: ascending synthetic Task digest. Those digests are
        // sealed here through `sealTask`, so the re-seal's new `TASK_EXECUTION_PROTOCOL_URI`
        // permutes them. The multiset (eight -0.9, two +0.10), n, p-value and scale are the
        // assertion; the positions are re-pinned to the post-re-seal ordering.
        replay: { scale: "40", differences: [
          ...Array.from({ length: 4 }, () => `-9${"0".repeat(39)}`), `1${"0".repeat(39)}`,
          ...Array.from({ length: 3 }, () => `-9${"0".repeat(39)}`), `1${"0".repeat(39)}`,
          `-9${"0".repeat(39)}`,
        ] },
      });
    });

    test("paired McNemar R=1 exact fixture computes with mandatory provenance clustering", async () => {
      const fixture = await loadFixture("paired-mcnemar.json");
      const prepared = prepareFixture({ ...fixture, runReplicates: 1 });
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const results = method.compute!({
        subjects: prepared.subjects,
        parameters: { ...fixture.parameters, verdictRule: fixture.verdictRule },
        verdictRule: fixture.verdictRule,
        registry,
        ...prepared.ports,
      });
      expect(results).toEqual(prepared.expectedResults);
      const subjectResults = onlySubjectResults(results) as {
        clustering: { basis: string };
        pairing: { taskDigests: string[] };
      };
      expect(subjectResults.clustering.basis).toBe("task-provenance-source");
      expect(subjectResults.pairing.taskDigests).toHaveLength(6);
    });

    test("referenced valid verdicts fail closed when unavailable or digest-mismatched", async () => {
      const fixture = await loadFixture("wilson.json");
      const prepared = prepareFixture(fixture);
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const referencedDigest = prepared.matrices[0]!.cells.find((cell) => cell.validVerdicts.length > 0)!
        .validVerdicts[0]!;
      const base = {
        subjects: prepared.subjects,
        parameters: { verdictRule: fixture.verdictRule },
        verdictRule: fixture.verdictRule,
        registry,
        resolveRunBytes: prepared.ports.resolveRunBytes,
        resolveTaskBytes: prepared.ports.resolveTaskBytes,
        resolveAnchoredBenchmarkAnnouncement: prepared.ports.resolveAnchoredBenchmarkAnnouncement,
      } as const;
      expect(() => method.compute!({
        ...base,
        resolveVerdictBytes: (digest) => digest === referencedDigest
          ? undefined
          : prepared.ports.resolveVerdictBytes(digest),
      })).toThrow(expect.objectContaining({
        name: "MethodInputError",
        code: "verdict-record-unavailable",
        digest: referencedDigest,
      }));
      expect(() => method.compute!({
        ...base,
        resolveVerdictBytes: (digest) => digest === referencedDigest
          ? canonicalJsonBytes({ substituted: true })
          : prepared.ports.resolveVerdictBytes(digest),
      })).toThrow(expect.objectContaining({
        name: "MethodInputError",
        code: "verdict-record-digest-mismatch",
        digest: referencedDigest,
      }));
    });

    test("clean-subset keeps self-declared Task bytes and proof-verified anchored announcements as distinct acquisition paths", async () => {
      const fixture = await loadFixture("clean-subset.json");
      const prepared = prepareFixture(fixture);
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const parameters = {
        verdictRule: "unanimous",
        basis: "announcement-anchored",
        cutoff: "2026-07-01T00:00:00Z",
        delegate: {
          id: "jinn.benchmarking.method/wilson",
          version: "1",
          parameters: {},
        },
      };
      const result = method.compute!({
        subjects: prepared.subjects,
        parameters,
        verdictRule: "unanimous",
        registry,
        ...prepared.ports,
      });
      const subjectResult = onlySubjectResults(result) as { basis: string; keptTaskDigests: string[] };
      expect(subjectResult.basis).toBe("announcement-anchored");
      expect(subjectResult.keptTaskDigests).toHaveLength(4);

      expect(() => method.compute!({
        subjects: prepared.subjects,
        parameters,
        verdictRule: "unanimous",
        registry,
        ...prepared.ports,
        resolveAnchoredBenchmarkAnnouncement: () => undefined,
      })).toThrow(expect.objectContaining({
        name: "MethodInputError",
        code: "anchored-announcement-unavailable",
      }));
    });

    test("comparability rejects marginal cross-version subjects and Bradley–Terry remains unavailable", () => {
      const wilson = registry.get("jinn.benchmarking.method/wilson", "1")!;
      const paired = registry.get("jinn.benchmarking.method/paired-mcnemar", "1")!;
      const noninferiority = registry.get("jinn.benchmarking.method/noninferiority-iut", "1")!;
      const subjects = [{ benchmarkDigest: "sha256:aa" }, { benchmarkDigest: "sha256:bb" }];
      expect(checkComparability(subjects, { versionRobust: wilson.versionRobust }).ok).toBe(false);
      expect(paired.versionRobust).toBe(true);
      expect(noninferiority.versionRobust).toBe(true);

      const bradleyTerry = registry.get("jinn.benchmarking.method/bradley-terry", "1")!;
      expect(bradleyTerry).toMatchObject({
        referenceSet: "registered-non-reference",
        computeAvailability: "unavailable",
      });
      expect(bradleyTerry.compute).toBeUndefined();
    });

    test("noninferiority seed is a nonzero uint32 and resamples is a positive integer", () => {
      const method = registry.get("jinn.benchmarking.method/noninferiority-iut", "1")!;
      const valid = { verdictRule: "unanimous", baseline: "armA", candidate: "armB", seed: 1, resamples: 1 };
      expect(method.validateParameters(valid)).toEqual({ ok: true });
      for (const bad of [
        { ...valid, seed: 0 },
        { ...valid, seed: 4_294_967_296 },
        { ...valid, seed: 1.5 },
        { ...valid, resamples: 0 },
        { ...valid, resamples: 1.5 },
      ]) {
        expect(method.validateParameters(bad)).toMatchObject({ ok: false });
      }
    });
  });
}
