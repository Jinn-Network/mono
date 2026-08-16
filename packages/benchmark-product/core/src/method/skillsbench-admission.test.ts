import { describe, expect, it } from "vitest";
import {
  SKILLSBENCH_ADMISSION_CHECKS,
  SKILLSBENCH_REQUIRED_CLUSTERS,
  SKILLSBENCH_REQUIRED_UNITS,
  SKILLSBENCH_STATIC_CHECKS,
  assessSkillsBenchStaticAdmission,
  type SkillsBenchAdmissionInput,
} from "./skillsbench-admission.js";
import { buildSkillsBenchUnit, type SkillsBenchUnitBuildInput } from "./skillsbench-unit.js";

const SKILL_MD = `---
name: widget-repair
description: Repair widgets from a parts manifest.
---

Read the manifest before replacing any part.
`;

function unitInput(name: string, overrides: Partial<SkillsBenchUnitBuildInput> = {}): SkillsBenchUnitBuildInput {
  return {
    task: { name, treeSha: "a".repeat(40), packageDigest: "b".repeat(64) },
    statement: {
      path: "task.md",
      gitBlob: "c".repeat(40),
      bytes: 100,
      frontmatter: { networkMode: "no-network", verifierType: "test-script", agentTimeoutSec: 900, verifierTimeoutSec: 900 },
      body: "Repair the broken assembly and write the result to /root/answer.json.",
    },
    entries: [
      { path: "task.md", mode: "100644", gitBlob: "c".repeat(40), bytes: 100 },
      { path: "environment/Dockerfile", mode: "100644", gitBlob: "d".repeat(40), bytes: 200 },
      { path: "environment/skills/widget-repair/SKILL.md", mode: "100644", gitBlob: "e".repeat(40), bytes: SKILL_MD.length },
      { path: "oracle/solve.sh", mode: "100755", gitBlob: "f".repeat(40), bytes: 300 },
      { path: "verifier/test.sh", mode: "100755", gitBlob: "1".repeat(40), bytes: 400 },
    ],
    skills: [{ folder: "widget-repair", skillMd: SKILL_MD }],
    rootLicenseSpdxId: "Apache-2.0",
    ...overrides,
  };
}

function admissionInput(name: string, overrides: Partial<SkillsBenchAdmissionInput> = {}, unitOverrides: Partial<SkillsBenchUnitBuildInput> = {}): SkillsBenchAdmissionInput {
  const built = unitInput(name, unitOverrides);
  return {
    unit: buildSkillsBenchUnit(built),
    statementBody: built.statement.body,
    cluster: { skillContentDigests: [`skill-${name}`], inputFamilyDigests: [], taskLineageIds: [], verificationDigests: [] },
    answerCollision: null,
    ...overrides,
  };
}

describe("static admission", () => {
  it("admits an offline, permissively licensed, non-disclosing unit", () => {
    const result = assessSkillsBenchStaticAdmission([admissionInput("alpha")]);
    expect(result.verdicts[0]!.staticallyEligible).toBe(true);
    expect(result.verdicts[0]!.rejectionReasons).toEqual([]);
  });

  it("accounts zero model execution and zero Docker controls", () => {
    const result = assessSkillsBenchStaticAdmission([admissionInput("alpha")]);
    expect(result.execution).toEqual({ modelArms: 0, previews: 0, dockerControls: 0 });
  });

  it("resolves every dynamic check unverifiable with an exact reason, never a pass", () => {
    const { checks } = assessSkillsBenchStaticAdmission([admissionInput("alpha")]).verdicts[0]!;
    const dynamic = SKILLSBENCH_ADMISSION_CHECKS.filter((name) => !SKILLSBENCH_STATIC_CHECKS.includes(name));
    for (const name of dynamic) {
      expect(checks[name].status).toBe("unverifiable");
      expect(checks[name].detail.length).toBeGreaterThan(0);
    }
  });

  describe("runtime isolation", () => {
    it("admits a no-network unit outright", () => {
      const { checks } = assessSkillsBenchStaticAdmission([admissionInput("alpha")]).verdicts[0]!;
      expect(checks.runtimeIsolationSatisfiable.status).toBe("match");
    });

    it("refuses to pass a public-network unit on its own evidence", () => {
      // This is the rule that decides Demo-1's fate on this source: SkillsBench has no allowlist,
      // so a public-mode agent could fetch its own task's oracle from GitHub.
      const result = assessSkillsBenchStaticAdmission([
        admissionInput("alpha", {}, {
          statement: { ...unitInput("alpha").statement, frontmatter: { networkMode: "public", verifierType: "test-script", agentTimeoutSec: 900, verifierTimeoutSec: 900 } },
        }),
      ]);
      expect(result.verdicts[0]!.checks.runtimeIsolationSatisfiable.status).toBe("unverifiable");
      expect(result.verdicts[0]!.staticallyEligible).toBe(false);
      expect(result.verdicts[0]!.rejectionReasons).toContain("runtimeIsolationSatisfiable:unverifiable");
    });
  });

  it("rejects a unit whose skill carries the source-available license", () => {
    const base = unitInput("alpha");
    const result = assessSkillsBenchStaticAdmission([admissionInput("alpha", {}, {
      entries: [...base.entries, {
        path: "environment/skills/widget-repair/LICENSE.txt",
        mode: "100644",
        gitBlob: "c55ab42224874608473643de0a85736b7fec0730",
        bytes: 1467,
      }],
    })]);
    expect(result.verdicts[0]!.checks.licenseCompatible.status).toBe("mismatch");
    expect(result.verdicts[0]!.staticallyEligible).toBe(false);
  });

  it("rejects a workspace that already contains a conflicting instruction file", () => {
    const base = unitInput("alpha");
    const result = assessSkillsBenchStaticAdmission([admissionInput("alpha", {}, {
      entries: [...base.entries, { path: "environment/CLAUDE.md", mode: "100644", gitBlob: "9".repeat(40), bytes: 10 }],
    })]);
    expect(result.verdicts[0]!.checks.conflictingInstructionFileAbsent.status).toBe("mismatch");
  });

  it("rejects a statement that names its own bundled skill", () => {
    const result = assessSkillsBenchStaticAdmission([
      admissionInput("alpha", { statementBody: "Use widget-repair to fix the assembly." }),
    ]);
    expect(result.verdicts[0]!.checks.statementDisclosureAbsent.status).toBe("mismatch");
  });

  it("rejects a statement that discloses the delivery mechanism", () => {
    const result = assessSkillsBenchStaticAdmission([
      admissionInput("alpha", { statementBody: "Consult SKILL.md before starting." }),
    ]);
    expect(result.verdicts[0]!.checks.statementDisclosureAbsent.status).toBe("mismatch");
  });

  it("rejects a declared answer collision", () => {
    const result = assessSkillsBenchStaticAdmission([
      admissionInput("alpha", { answerCollision: "statement shares token 'crossref_snapshot' with oracle" }),
    ]);
    expect(result.verdicts[0]!.checks.answerCollisionAbsent.status).toBe("mismatch");
  });

  describe("capacity floors", () => {
    it("imports the floors from the superseded method so the lineages cannot drift", () => {
      expect(SKILLSBENCH_REQUIRED_UNITS).toBe(21);
      expect(SKILLSBENCH_REQUIRED_CLUSTERS).toBe(13);
    });

    it("is insufficient at 20 units", () => {
      const inputs = Array.from({ length: 20 }, (_, index) => admissionInput(`task-${String(index).padStart(2, "0")}`));
      const { capacity } = assessSkillsBenchStaticAdmission(inputs);
      expect(capacity.units).toBe(20);
      expect(capacity.sufficient).toBe(false);
    });

    it("is sufficient at 21 units across 21 clusters", () => {
      const inputs = Array.from({ length: 21 }, (_, index) => admissionInput(`task-${String(index).padStart(2, "0")}`));
      const { capacity } = assessSkillsBenchStaticAdmission(inputs);
      expect(capacity.units).toBe(21);
      expect(capacity.clusters).toBe(21);
      expect(capacity.sufficient).toBe(true);
    });

    it("is insufficient at 21 units collapsed into 12 clusters", () => {
      // Unit count alone is not capacity. Twenty-one units that share skills across only twelve
      // independent clusters cannot fill three cluster-disjoint pools.
      const inputs = Array.from({ length: 21 }, (_, index) => admissionInput(
        `task-${String(index).padStart(2, "0")}`,
        { cluster: { skillContentDigests: [`shared-${Math.min(index, 11)}`], inputFamilyDigests: [], taskLineageIds: [], verificationDigests: [] } },
      ));
      const { capacity } = assessSkillsBenchStaticAdmission(inputs);
      expect(capacity.units).toBe(21);
      expect(capacity.clusters).toBe(12);
      expect(capacity.sufficient).toBe(false);
    });

    it("is sufficient at 21 units across exactly 13 clusters", () => {
      const inputs = Array.from({ length: 21 }, (_, index) => admissionInput(
        `task-${String(index).padStart(2, "0")}`,
        { cluster: { skillContentDigests: [`shared-${Math.min(index, 12)}`], inputFamilyDigests: [], taskLineageIds: [], verificationDigests: [] } },
      ));
      const { capacity } = assessSkillsBenchStaticAdmission(inputs);
      expect(capacity.clusters).toBe(13);
      expect(capacity.sufficient).toBe(true);
    });

    it("counts clusters over eligible units only", () => {
      const good = Array.from({ length: 5 }, (_, i) => admissionInput(`ok-${i}`));
      const bad = Array.from({ length: 30 }, (_, i) => admissionInput(`no-${i}`, {}, {
        statement: { ...unitInput(`no-${i}`).statement, frontmatter: { networkMode: "public", verifierType: "test-script", agentTimeoutSec: 900, verifierTimeoutSec: 900 } },
      }));
      const { capacity } = assessSkillsBenchStaticAdmission([...good, ...bad]);
      expect(capacity.units).toBe(5);
      expect(capacity.clusters).toBe(5);
      expect(capacity.sufficient).toBe(false);
    });
  });

  it("summarizes rejection reasons by frequency", () => {
    const inputs = Array.from({ length: 3 }, (_, i) => admissionInput(`t-${i}`, {}, {
      statement: { ...unitInput(`t-${i}`).statement, frontmatter: { networkMode: "public", verifierType: "test-script", agentTimeoutSec: 900, verifierTimeoutSec: 900 } },
    }));
    const { rejectionSummary } = assessSkillsBenchStaticAdmission(inputs);
    expect(rejectionSummary[0]).toEqual({ reason: "runtimeIsolationSatisfiable:unverifiable", units: 3 });
  });

  it("is deterministic across input orderings", () => {
    const inputs = Array.from({ length: 6 }, (_, i) => admissionInput(`t-${i}`));
    const forward = assessSkillsBenchStaticAdmission(inputs);
    const reverse = assessSkillsBenchStaticAdmission([...inputs].reverse());
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
  });
});
