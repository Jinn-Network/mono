import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../testing.js";
import { parseTaskProfile, sealTaskProfile } from "../task-profile/seal.js";
import { buildRepositoryWorkProfile, migrateJinnRepoTask } from "./repository-work-1.0.js";

describe("repository-work/1.0 sealed document (design §8)", () => {
  it("seals to the pinned digest and round-trips", async () => {
    const built = buildRepositoryWorkProfile();
    const sealed = sealTaskProfile(built);
    const pinned = (
      await readFile(
        new URL(
          "../../profiles/task-profiles/repository-work/1.0/profile.sha256",
          import.meta.url,
        ),
        "utf8",
      )
    ).trim();
    expect(sealed.digest).toBe(pinned);
    expect(parseTaskProfile(sealed.bytes)).toEqual(built);
  });

  it("declares the design §8 payload/input/output/evaluation shape", () => {
    const built = buildRepositoryWorkProfile();
    expect(built.evaluationFamilies).toEqual(["deterministic-process", "model-graded"]);
    expect(built.requirementKeys).toContainEqual({ key: "effort", comparisonClass: "floor" });
    expect(built.inputConventions.slots.some((slot) => slot.name === "repository-state" && slot.required)).toBe(
      true,
    );
    expect(built.outputConventions.slots.some((slot) => slot.name === "patch" && slot.required)).toBe(true);
  });
});

describe("jinn-repo.v1 → repository-work/1.0 migration (design §13)", () => {
  it("passes every migration golden fixture", async () => {
    const familyDir = fileURLToPath(
      new URL("../../fixtures/migration/jinn-repo-to-repository-work", import.meta.url),
    );
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, (input) => migrateJinnRepoTask(input as never));
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });

  it("defaults a legacy document with no `source` field to merged-pr (mined) provenance", () => {
    const migrated = migrateJinnRepoTask({
      instance_id: "jinn-repo-legacy-1",
      repo: "Jinn-Network/mono",
      base_commit: "1111111111111111111111111111111111111111",
      problem_statement: "Legacy task with no source field.",
      language: "typescript",
    });
    expect(migrated.payload.provenance).toEqual({ kind: "mined" });
    expect(migrated.requirements).toBeUndefined();
  });
});
