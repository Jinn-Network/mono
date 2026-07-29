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
  canonicalJsonBytes,
  recordDigest,
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
  MethodRegistry,
  VerifiedAnchoredBenchmarkAnnouncement,
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
  readonly runReplicates?: number;
  readonly expectedResults: unknown;
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
  const fixtures = await Promise.all(names.map(async (name) => [name, await loadJson<Record<string, unknown>>(name)] as const));
  return fixtures
    .filter(([, fixture]) => Array.isArray(fixture["matrices"]) && Object.hasOwn(fixture, "expectedResults"))
    .map(([name]) => name);
}

/** Validates + parses each fixture's raw matrix documents through the real records schema, so a
 * method fixture can never smuggle a structurally invalid Matrix in as "input". */
function parseMatrices(raw: readonly unknown[]): MatrixRecord[] {
  return raw.map((document) => parseMatrix(sealMatrix(document).bytes));
}

function mapStringsDeep(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
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
    predicateType: "https://jinn.network/attestations/result-evaluation/v1",
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
  return canonicalJsonBytes(buildVerdictEnvelope(statement, [{ keyid: "did:key:zFixture", sig: "AA==" }]));
}

interface PreparedMethodFixture {
  readonly matrices: MatrixRecord[];
  readonly expectedResults: unknown;
  readonly ports: Pick<
    MethodComputeInput,
    | "resolveVerdictBytes"
    | "resolveRunBytes"
    | "resolveTaskBytes"
    | "resolveAnchoredBenchmarkAnnouncement"
  >;
  readonly verdictBytes: Map<string, Uint8Array>;
  readonly runBytes: Map<string, Uint8Array>;
  readonly taskBytes: Map<string, Uint8Array>;
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
  const announcements = new Map<string, VerifiedAnchoredBenchmarkAnnouncement>();
  const replacements = new Map<string, string>();

  const rawMatrices = structuredClone(fixture.matrices) as Array<{
    run: { digest: { sha256: string } };
    cells: Array<{
      cellKey: string;
      taskDigest: string;
      armId: string;
      replicate: number;
      verdicts: string[];
      validVerdicts: string[];
    }>;
  }>;

  const oldTaskDigests = [...new Set(rawMatrices.flatMap((matrix) => matrix.cells.map((cell) => cell.taskDigest)))];
  for (const oldTaskDigest of oldTaskDigests) {
    const task = sealTask({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: { digest: { sha256: "f".repeat(64) } },
      instructions: `Fixture task ${oldTaskDigest}`,
      payload: {
        provenance: {
          source: fixture.clusterKeys?.[oldTaskDigest] ?? `fixture-source/${oldTaskDigest}`,
          timestamp: fixture.taskTimestamps?.[oldTaskDigest] ?? "2026-07-29T00:00:00Z",
        },
      },
      outputs: [{ name: "result", mediaType: "application/json", required: true }],
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

    const armIds = [...new Set(matrix.cells.map((cell) => cell.armId))].sort();
    const benchmarkDigest = `sha256:${String(matrixIndex + 1).padStart(64, "b")}`;
    const methodParameters = { ...fixture.parameters, verdictRule: fixture.verdictRule };
    const sealedRun = sealRun({
      protocol: "https://jinn.network/protocols/benchmarking/1.0",
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
      protocol: "https://jinn.network/record-discovery/1.0",
      source: { agent: "urn:uuid:88888888-8888-5888-8888-888888888888", name: "fixture" },
      sequence: "0000000000000001",
      previous: null,
      timestamp: "2026-07-29T00:00:00Z",
      announcements: [{
        announcementId: `benchmark-${matrixIndex}`,
        action: "available",
        record: {
          kind: "https://jinn.network/records/benchmark/1.0",
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
      anchoredAt: "2026-07-29T00:00:00Z",
      verification: "verified",
    });
  });

  for (const [before, after] of verdictReplacements) replacements.set(before, after);
  return {
    matrices: parseMatrices(rawMatrices),
    expectedResults: sortIdentifierArraysDeep(mapStringsDeep(fixture.expectedResults, replacements)),
    ports: {
      resolveVerdictBytes: (digest) => verdictBytes.get(digest),
      resolveRunBytes: (digest) => runBytes.get(digest),
      resolveTaskBytes: (digest) => taskBytes.get(digest),
      resolveAnchoredBenchmarkAnnouncement: (digest) => announcements.get(digest),
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
          matrices: prepared.matrices,
          parameters: completeParameters,
          verdictRule: fixture.verdictRule,
          registry,
          ...prepared.ports,
        });
        expect(results, `${fixture.methodId}@${fixture.methodVersion} (fixture ${name})`).toEqual(prepared.expectedResults);
      }
    });

    test("registry entries reproduce the declarative method-spec fixture", async () => {
      const expected = await loadJson<MethodSpecFixture[]>("method-specs.json");
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
      for (const entry of fixture.cases) {
        const prepared = prepareFixture({
          methodId: entry.methodId,
          methodVersion: "1",
          parameters: entry.parameters,
          verdictRule: "unanimous",
          matrices: [fixture.matrix],
          verdictOutcomes: fixture.verdictOutcomes,
          taskTimestamps: fixture.taskTimestamps,
          ...(entry.methodId === "jinn.benchmarking.method/paired-mcnemar"
            ? { runReplicates: 1 }
            : {}),
          expectedResults: {},
        });
        const matrix = prepared.matrices[0]!;
        const method = registry.get(entry.methodId, "1");
        expect(method?.computeAvailability, entry.methodId).toBe("available");
        const results = method!.compute!({
          matrices: [matrix],
          parameters: { ...entry.parameters, verdictRule: "unanimous" },
          verdictRule: "unanimous",
          registry,
          ...prepared.ports,
        }) as { conflicted?: unknown };
        expect(results.conflicted, entry.methodId).toEqual(
          mapStringsDeep(fixture.expectedConflicted, new Map(
            [...prepared.taskBytes.keys()].map((digest, index) => [
              [...new Set((fixture.matrix as { cells: Array<{ taskDigest: string }> }).cells.map((cell) => cell.taskDigest))][index]!,
              digest.slice("sha256:".length),
            ]),
          )),
        );
      }
    });

    test("paired McNemar reports the full excluded remainder and pins provenance-source clustering", async () => {
      const fixture = await loadJson<{
        matrix: unknown;
        verdictOutcomes: Record<string, VerdictOutcome>;
        clusterKeys: Record<string, string>;
        parameters: Record<string, unknown>;
        expected: { clusteringBasis: string; excludedCount: number; excludedCellKeys: string[] };
      }>("paired-contract.json");
      const prepared = prepareFixture({
        methodId: "jinn.benchmarking.method/paired-mcnemar",
        methodVersion: "1",
        parameters: fixture.parameters,
        verdictRule: "unanimous",
        matrices: [fixture.matrix],
        verdictOutcomes: fixture.verdictOutcomes,
        clusterKeys: fixture.clusterKeys,
        runReplicates: 2,
        expectedResults: {},
      });
      const method = registry.get("jinn.benchmarking.method/paired-mcnemar", "1")!;
      expect(() => method.compute!({
        matrices: prepared.matrices,
        parameters: { ...fixture.parameters, verdictRule: "unanimous" },
        verdictRule: "unanimous",
        registry,
        ...prepared.ports,
      })).toThrow(expect.objectContaining({
        name: "MethodInputError",
        code: "incompatible-run-replicates",
      }));
    });

    test("paired McNemar R=1 exact fixture computes with mandatory provenance clustering", async () => {
      const fixture = await loadFixture("paired-mcnemar.json");
      const prepared = prepareFixture({ ...fixture, runReplicates: 1 });
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const results = method.compute!({
        matrices: prepared.matrices,
        parameters: { ...fixture.parameters, verdictRule: fixture.verdictRule },
        verdictRule: fixture.verdictRule,
        registry,
        ...prepared.ports,
      }) as { clustering: { basis: string }; pairing: { taskDigests: string[] } };
      expect(results).toEqual(prepared.expectedResults);
      expect(results.clustering.basis).toBe("task-provenance-source");
      expect(results.pairing.taskDigests).toHaveLength(6);
    });

    test("referenced valid verdicts fail closed when unavailable or digest-mismatched", async () => {
      const fixture = await loadFixture("wilson.json");
      const prepared = prepareFixture(fixture);
      const method = registry.get(fixture.methodId, fixture.methodVersion)!;
      const referencedDigest = prepared.matrices[0]!.cells.find((cell) => cell.validVerdicts.length > 0)!
        .validVerdicts[0]!;
      const base = {
        matrices: prepared.matrices,
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

    test("clean-subset keeps self-declared Task bytes and verified anchored announcements as distinct acquisition paths", async () => {
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
        matrices: prepared.matrices,
        parameters,
        verdictRule: "unanimous",
        registry,
        ...prepared.ports,
      }) as { basis: string; keptTaskDigests: string[] };
      expect(result.basis).toBe("announcement-anchored");
      expect(result.keptTaskDigests).toHaveLength(4);

      expect(() => method.compute!({
        matrices: prepared.matrices,
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
      const subjects = [{ benchmarkDigest: "sha256:aa" }, { benchmarkDigest: "sha256:bb" }];
      expect(checkComparability(subjects, { versionRobust: wilson.versionRobust }).ok).toBe(false);
      expect(paired.versionRobust).toBe(true);

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
