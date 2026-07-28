import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseMatrix, sealMatrix, type MatrixRecord } from "@jinn-network/benchmarking-records";
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
      expect((await fixtureNames()).length).toBeGreaterThan(0);
    });

    test("each fixture's method reproduces the pinned expectedResults", async () => {
      for (const name of await fixtureNames()) {
        const fixture = await loadFixture(name);
        const method = registry.get(fixture.methodId, fixture.methodVersion);
        expect(method, `registry has no method for ${fixture.methodId}@${fixture.methodVersion} (fixture ${name})`).toBeDefined();
        const verdictOutcomes = new Map(Object.entries(fixture.verdictOutcomes));
        const taskTimestamps = fixture.taskTimestamps === undefined
          ? undefined
          : new Map(Object.entries(fixture.taskTimestamps));
        const results = method!.compute({
          matrices: parseMatrices(fixture.matrices),
          parameters: fixture.parameters,
          verdictRule: fixture.verdictRule,
          resolveVerdict: (digest) => verdictOutcomes.get(digest),
          registry,
          ...(taskTimestamps === undefined ? {} : { resolveTaskTimestamp: (digest: string) => taskTimestamps.get(digest) }),
        });
        expect(results, `${fixture.methodId}@${fixture.methodVersion} (fixture ${name})`).toEqual(fixture.expectedResults);
      }
    });
  });
}
