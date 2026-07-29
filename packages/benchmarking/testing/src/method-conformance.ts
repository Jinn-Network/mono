import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkComparability, parseMatrix, sealMatrix, type MatrixRecord } from "@jinn-network/benchmarking-records";
import type { VerdictOutcome } from "@jinn-network/task-execution-profiles";
import { describe, expect, test } from "vitest";
import type { MethodRegistry, VerdictRuleName } from "./method-types.js";

interface MethodFixture {
  readonly methodId: string;
  readonly methodVersion: string;
  readonly parameters: Record<string, unknown>;
  readonly verdictRule: VerdictRuleName;
  readonly matrices: readonly unknown[];
  readonly verdictOutcomes: Record<string, VerdictOutcome>;
  readonly taskTimestamps?: Record<string, string>;
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
        const method = registry.get(fixture.methodId, fixture.methodVersion);
        expect(method, `registry has no method for ${fixture.methodId}@${fixture.methodVersion} (fixture ${name})`).toBeDefined();
        expect(method!.computeAvailability).toBe("available");
        expect(method!.compute).toBeTypeOf("function");
        const completeParameters = { ...fixture.parameters, verdictRule: fixture.verdictRule };
        expect(method!.validateParameters(completeParameters), `${name} parameters`).toEqual({ ok: true });
        const verdictOutcomes = new Map(Object.entries(fixture.verdictOutcomes));
        const taskTimestamps = fixture.taskTimestamps === undefined
          ? undefined
          : new Map(Object.entries(fixture.taskTimestamps));
        const results = method!.compute!({
          matrices: parseMatrices(fixture.matrices),
          parameters: completeParameters,
          verdictRule: fixture.verdictRule,
          resolveVerdict: (digest) => verdictOutcomes.get(digest),
          registry,
          ...(taskTimestamps === undefined ? {} : { resolveTaskTimestamp: (digest: string) => taskTimestamps.get(digest) }),
        });
        expect(results, `${fixture.methodId}@${fixture.methodVersion} (fixture ${name})`).toEqual(fixture.expectedResults);
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
      const matrix = parseMatrices([fixture.matrix])[0]!;
      for (const entry of fixture.cases) {
        const method = registry.get(entry.methodId, "1");
        expect(method?.computeAvailability, entry.methodId).toBe("available");
        const results = method!.compute!({
          matrices: [matrix],
          parameters: { ...entry.parameters, verdictRule: "unanimous" },
          verdictRule: "unanimous",
          resolveVerdict: (digest) => fixture.verdictOutcomes[digest],
          resolveTaskTimestamp: (digest) => fixture.taskTimestamps[digest],
          resolveClusterKey: () => "fixture-source",
          registry,
        }) as { conflicted?: unknown };
        expect(results.conflicted, entry.methodId).toEqual(fixture.expectedConflicted);
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
      const method = registry.get("jinn.benchmarking.method/paired-mcnemar", "1")!;
      const results = method.compute!({
        matrices: parseMatrices([fixture.matrix]),
        parameters: { ...fixture.parameters, verdictRule: "unanimous" },
        verdictRule: "unanimous",
        resolveVerdict: (digest) => fixture.verdictOutcomes[digest],
        resolveClusterKey: (digest) => fixture.clusterKeys[digest],
        registry,
      }) as {
        excluded: { count: number; cellKeys: string[] };
        clustering: { basis: string };
      };
      expect(results.excluded.count).toBe(fixture.expected.excludedCount);
      expect(results.excluded.cellKeys).toEqual(fixture.expected.excludedCellKeys);
      expect(results.clustering.basis).toBe(fixture.expected.clusteringBasis);
    });

    test("comparability rejects marginal cross-version subjects and Bradley–Terry remains unavailable", () => {
      const wilson = registry.get("jinn.benchmarking.method/wilson", "1")!;
      const paired = registry.get("jinn.benchmarking.method/paired-mcnemar", "1")!;
      const subjects = [{ benchmarkDigest: "sha256:aa" }, { benchmarkDigest: "sha256:bb" }];
      expect(checkComparability(subjects, { versionRobust: wilson.versionRobust }).ok).toBe(false);
      expect(checkComparability(subjects, { versionRobust: paired.versionRobust }).ok).toBe(true);

      const bradleyTerry = registry.get("jinn.benchmarking.method/bradley-terry", "1")!;
      expect(bradleyTerry).toMatchObject({
        referenceSet: "registered-non-reference",
        computeAvailability: "unavailable",
      });
      expect(bradleyTerry.compute).toBeUndefined();
    });
  });
}
