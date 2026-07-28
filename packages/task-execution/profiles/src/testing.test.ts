import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "./testing.js";
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
