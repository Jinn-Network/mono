import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeRequirements, type ComparisonClass } from "@jinn-network/task-execution-protocol";
import { loadFixtureFamily, runStructuralCheck } from "./testing.js";

const familyDir = fileURLToPath(new URL("../fixtures/requirement-merge", import.meta.url));

interface MergeCaseInput {
  task: Record<string, unknown>;
  submission: Record<string, unknown>;
  keyClasses: Record<string, ComparisonClass>;
}

function checkMerge(raw: unknown) {
  const { task, submission, keyClasses } = raw as MergeCaseInput;
  return mergeRequirements(task, submission, keyClasses);
}

describe("requirement-merge fixtures per comparison class (program §7.3 — executes TEP's mergeRequirements)", () => {
  it("passes every golden and adversarial fixture case, one per comparison class plus a same-key conflict", async () => {
    const cases = (await loadFixtureFamily(familyDir)).filter(
      (fixtureCase) => fixtureCase.name !== "pinning-inventory-reject",
    );
    // exact, ceiling, floor, constraint, addable: one golden + one conflict each.
    expect(cases.length).toBe(10);
    const results = runStructuralCheck(cases, checkMerge);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });

  it("keeps the pinning-inventory fixture as backend-capability-path DATA, never fed to mergeRequirements", async () => {
    const cases = await loadFixtureFamily(familyDir);
    const pinningCase = cases.find((fixtureCase) => fixtureCase.name === "pinning-inventory-reject");
    expect(pinningCase).toBeDefined();

    const data = pinningCase!.input as {
      submissionRequirementKey: string;
      backendDeclaredCapabilityKeys: string[];
    };
    // Well-formedness only (program §7.3): a pinning key the backend's declared runPinning
    // inventory does not carry — this is what a real backend capability check would reject with
    // `unsupported-requirement`, a category mergeRequirements never produces.
    expect(data.backendDeclaredCapabilityKeys).not.toContain(data.submissionRequirementKey);

    const expected = pinningCase!.expect as { category: string; key: string };
    expect(expected.category).toBe("unsupported-requirement");
    expect(expected.key).toBe(data.submissionRequirementKey);

    // mergeRequirements never produces `unsupported-requirement` — confirm the type-level
    // contract stays: MergeRequirementsResult's failure category is exactly `invalid-document`.
    const result = mergeRequirements({}, { [data.submissionRequirementKey]: "anything" }, {
      [data.submissionRequirementKey]: "addable",
    });
    // Structurally addable and absent from the Task — mergeRequirements merges it successfully;
    // it takes no position on whether a backend's capability inventory declares support for it.
    expect(result.ok).toBe(true);
  });
});
