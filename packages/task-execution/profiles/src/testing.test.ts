import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareCodeUnitStrings } from "./order.js";
import {
  FIXTURE_FAMILIES,
  checkAdmissionReceipt,
  checkAllOfConstruction,
  checkMeasurementCoverage,
  checkStatePredicateBlock,
  checkStatePredicateSpec,
  checkVerdictConsistency,
  deriveEvaluationTask,
  evaluatePredicates,
  loadFixtureFamily,
  resolveFamilyUri,
  runStructuralCheck,
} from "./testing.js";
import { ProfilesError } from "./errors.js";

describe("conformance-kit backbone", () => {
  let familyDir: string;

  beforeEach(async () => {
    familyDir = await mkdtemp(join(tmpdir(), "jinn-task-execution-profiles-testing-"));
    await mkdir(join(familyDir, "golden"), { recursive: true });
    await mkdir(join(familyDir, "adversarial"), { recursive: true });
    await writeFile(
      join(familyDir, "golden", "identity.json"),
      JSON.stringify({ input: { value: 1 }, expect: { value: 1 } }),
    );
    await writeFile(
      join(familyDir, "adversarial", "rejects.json"),
      JSON.stringify({ input: { poison: true }, expect: { ok: false, code: "invalid-document" } }),
    );
  });

  afterEach(async () => {
    await rm(familyDir, { recursive: true, force: true });
  });

  it("loads and tags golden and adversarial fixture cases", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases).toHaveLength(2);
    const golden = cases.find((c) => c.kind === "golden");
    const adversarial = cases.find((c) => c.kind === "adversarial");
    expect(golden).toEqual({ name: "identity", kind: "golden", input: { value: 1 }, expect: { value: 1 } });
    expect(adversarial).toEqual({
      name: "rejects",
      kind: "adversarial",
      input: { poison: true },
      expect: { ok: false, code: "invalid-document" },
    });
  });

  it("reports golden pass and adversarial pass for an identity check with a thrown-error projection", async () => {
    const cases = await loadFixtureFamily(familyDir);
    const identityCheck = (input: unknown) => {
      const record = input as { poison?: boolean; value?: number };
      if (record.poison) {
        throw new ProfilesError("invalid-document", "poisoned input");
      }
      return { value: record.value };
    };
    const results = runStructuralCheck(cases, identityCheck);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.ok).toBe(true);
    }
    const golden = results.find((r) => r.case === "identity");
    const adversarial = results.find((r) => r.case === "rejects");
    expect(golden?.kind).toBe("golden");
    expect(adversarial?.kind).toBe("adversarial");
  });
});

describe("./testing re-export surface (design §12, plan Task 15)", () => {
  it("FIXTURE_FAMILIES names exactly the directories under fixtures/, sorted by code unit", async () => {
    const fixturesRoot = fileURLToPath(new URL("../fixtures", import.meta.url));
    const entries = await readdir(fixturesRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect([...FIXTURE_FAMILIES].sort(compareCodeUnitStrings)).toEqual(FIXTURE_FAMILIES);
    expect([...directories].sort(compareCodeUnitStrings)).toEqual([...FIXTURE_FAMILIES].sort(compareCodeUnitStrings));
  });

  it("re-exports every structural check named in the plan's Task 15 interfaces block", () => {
    expect(typeof checkAdmissionReceipt).toBe("function");
    expect(typeof checkAllOfConstruction).toBe("function");
    expect(typeof checkMeasurementCoverage).toBe("function");
    expect(typeof checkStatePredicateBlock).toBe("function");
    expect(typeof checkStatePredicateSpec).toBe("function");
    expect(typeof checkVerdictConsistency).toBe("function");
    expect(typeof deriveEvaluationTask).toBe("function");
    expect(typeof evaluatePredicates).toBe("function");
    expect(typeof resolveFamilyUri).toBe("function");
  });

  it("loads state-predicate fixture families through the kit path", async () => {
    const fixturesRoot = fileURLToPath(new URL("../fixtures", import.meta.url));
    for (const family of ["state-predicate-block", "state-predicate-evaluation"] as const) {
      const cases = await loadFixtureFamily(`${fixturesRoot}/${family}`);
      expect(cases.length).toBeGreaterThan(0);
    }
  });
});
