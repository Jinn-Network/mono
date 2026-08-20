import { describe, expect, it } from "vitest";
import {
  SKILLSBENCH_TASK_BUNDLE_UNIT_SCHEMA,
  buildSkillsBenchUnit,
  canonicalSkillsBenchUnitBytes,
  classifySkillsBenchResource,
  skillsBenchUnitDigest,
  verifySkillsBenchUnitBodies,
  verifySkillsBenchUnit,
  type SkillsBenchUnitBuildInput,
} from "./skillsbench-unit.js";

const SKILL_MD = `---
name: citation-management
description: Verify academic citations against public bibliographic sources.
---

Run the validator before reporting any citation as fake.
`;

/** A two-skill unit exercising every resource class the roster actually contains. */
function input(overrides: Partial<SkillsBenchUnitBuildInput> = {}): SkillsBenchUnitBuildInput {
  return {
    task: { name: "citation-check", treeSha: "c4ec550995c7593788fda27b2e68efc1abbbeb42", packageDigest: "a".repeat(64) },
    statement: {
      path: "task.md",
      gitBlob: "b".repeat(40),
      bytes: 1588,
      frontmatter: { networkMode: "public", verifierType: "test-script", agentTimeoutSec: 900, verifierTimeoutSec: 900 },
      body: "Identify which citations are fake and write /root/answer.json.",
    },
    entries: [
      { path: "task.md", mode: "100644", gitBlob: "b".repeat(40), bytes: 1588 },
      { path: "environment/Dockerfile", mode: "100644", gitBlob: "c".repeat(40), bytes: 518 },
      { path: "environment/test.bib", mode: "100644", gitBlob: "d".repeat(40), bytes: 17346 },
      { path: "environment/skills/citation-management/SKILL.md", mode: "100644", gitBlob: "e".repeat(40), bytes: SKILL_MD.length },
      { path: "environment/skills/citation-management/references/pubmed_search.md", mode: "100644", gitBlob: "f".repeat(40), bytes: 17698 },
      { path: "environment/skills/citation-management/scripts/validate.py", mode: "100755", gitBlob: "1".repeat(40), bytes: 17322 },
      { path: "environment/skills/citation-management/assets/template.bib", mode: "100644", gitBlob: "2".repeat(40), bytes: 9200 },
      { path: "environment/skills/citation-management/LICENSE.txt", mode: "100644", gitBlob: "c55ab42224874608473643de0a85736b7fec0730", bytes: 1467 },
      { path: "environment/skills/d3-visualization/SKILL.md", mode: "100644", gitBlob: "3".repeat(40), bytes: 6202 },
      { path: "oracle/solve.sh", mode: "100755", gitBlob: "4".repeat(40), bytes: 994 },
      { path: "verifier/test.sh", mode: "100755", gitBlob: "5".repeat(40), bytes: 699 },
      { path: "verifier/test_outputs.py", mode: "100644", gitBlob: "6".repeat(40), bytes: 4844 },
    ],
    skills: [
      { folder: "citation-management", skillMd: SKILL_MD },
      { folder: "d3-visualization", skillMd: "---\nname: d3-visualization\ndescription: Build D3 charts.\n---\n\nUse the tooltip handler.\n" },
    ],
    rootLicenseSpdxId: "Apache-2.0",
    ...overrides,
  };
}

describe("skillsbench task-bundle unit", () => {
  it("binds the schema, task identity, and both skills", () => {
    const unit = buildSkillsBenchUnit(input());
    expect(unit.schema).toBe(SKILLSBENCH_TASK_BUNDLE_UNIT_SCHEMA);
    expect(unit.task.name).toBe("citation-check");
    expect(unit.skills).toHaveLength(2);
    expect(unit.skills.map((skill) => skill.folder)).toEqual(["citation-management", "d3-visualization"]);
  });

  it("separates each skill's frontmatter identity from its instruction-body identity", () => {
    const [skill] = buildSkillsBenchUnit(input()).skills;
    expect(skill!.name).toBe("citation-management");
    expect(skill!.description).toBe("Verify academic citations against public bibliographic sources.");
    expect(skill!.frontmatterSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(skill!.bodySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(skill!.bodySha256).not.toBe(skill!.frontmatterSha256);
    expect(skill!.skillMdSha256).not.toBe(skill!.bodySha256);
  });

  it("orders skills lexically by folder path regardless of input order", () => {
    const reversed = input();
    const unit = buildSkillsBenchUnit({ ...reversed, skills: [...reversed.skills].reverse() });
    expect(unit.skills.map((skill) => skill.folder)).toEqual(["citation-management", "d3-visualization"]);
  });

  it("classifies every resource explicitly and never blanket-labels non-SKILL.md files", () => {
    const unit = buildSkillsBenchUnit(input());
    const byPath = new Map(unit.skills.flatMap((skill) => skill.resources.map((r) => [r.path, r.classification])));
    expect(byPath.get("references/pubmed_search.md")).toBe("instruction-bearing");
    expect(byPath.get("scripts/validate.py")).toBe("executable-resource");
    expect(byPath.get("assets/template.bib")).toBe("data-resource");
    expect(byPath.get("LICENSE.txt")).toBe("license-notice");
    expect([...byPath.values()]).not.toContain(undefined);
  });

  it("preserves executable mode bits, which a text-only tree digest would lose", () => {
    const unit = buildSkillsBenchUnit(input());
    const script = unit.skills[0]!.resources.find((r) => r.path === "scripts/validate.py");
    expect(script!.mode).toBe("100755");
  });

  it("records the per-skill license and recognizes the source-available blob as incompatible", () => {
    const unit = buildSkillsBenchUnit(input());
    expect(unit.skills[0]!.license).toEqual({
      path: "LICENSE.txt",
      gitBlob: "c55ab42224874608473643de0a85736b7fec0730",
      spdxId: "LicenseRef-Anthropic-Source-Available",
      status: "incompatible",
    });
    expect(unit.license.status).toBe("incompatible");
    expect(unit.license.reasons).toContain("skill-citation-management-source-available");
  });

  it("inherits the compatible root license when no skill carries its own", () => {
    const base = input();
    const unit = buildSkillsBenchUnit({
      ...base,
      entries: base.entries.filter((entry) => !entry.path.endsWith("LICENSE.txt")),
    });
    expect(unit.skills[0]!.license).toBeNull();
    expect(unit.license.status).toBe("compatible");
    expect(unit.license.rootSpdxId).toBe("Apache-2.0");
  });

  it("carries the oracle, verifier, and environment identities", () => {
    const unit = buildSkillsBenchUnit(input());
    expect(unit.oracle.map((f) => f.path)).toEqual(["oracle/solve.sh"]);
    expect(unit.verifier.map((f) => f.path)).toEqual(["verifier/test.sh", "verifier/test_outputs.py"]);
    expect(unit.environment.dockerfile.gitBlob).toBe("c".repeat(40));
    expect(unit.environment.nonSkillFiles.map((f) => f.path)).toEqual(["environment/test.bib"]);
  });

  it("records the declared network mode as first-class admission evidence", () => {
    expect(buildSkillsBenchUnit(input()).statement.frontmatter.networkMode).toBe("public");
  });

  it("canonically serializes and digests, and recomputes from its own inputs", () => {
    const unit = buildSkillsBenchUnit(input());
    expect(() => verifySkillsBenchUnit(unit)).not.toThrow();
    expect(skillsBenchUnitDigest(unit)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Buffer.from(canonicalSkillsBenchUnitBytes(unit))).toEqual(
      Buffer.from(canonicalSkillsBenchUnitBytes(buildSkillsBenchUnit(input()))),
    );
  });

  it("refuses a substituted structural field", () => {
    const unit = buildSkillsBenchUnit(input());
    const forged = {
      ...unit,
      license: { ...unit.license, status: "compatible" as const, reasons: [] },
    };
    expect(() => verifySkillsBenchUnit(forged)).toThrow(/do not recompute/u);
  });

  it("refuses a resource whose classification was hand-edited", () => {
    const unit = buildSkillsBenchUnit(input());
    const [first, ...rest] = unit.skills;
    const forged = {
      ...unit,
      skills: [{
        ...first!,
        resources: first!.resources.map((r) => r.path === "scripts/validate.py"
          ? { ...r, classification: "data-resource" as const }
          : r),
      }, ...rest],
    };
    expect(() => verifySkillsBenchUnit(forged)).toThrow(/classification does not recompute/u);
  });

  describe("body-byte re-derivation against supplied source", () => {
    // A manifest that carries digests but not bytes cannot detect a substituted digest on its own.
    // That limit is real, so the byte proof is a separate function fed the actual bytes — this is
    // what makes arm B's "byte-identical to the authenticated upstream body" checkable.
    it("accepts the exact upstream bytes", () => {
      const built = input();
      expect(() => verifySkillsBenchUnitBodies(buildSkillsBenchUnit(built), built.skills)).not.toThrow();
    });

    it("refuses a forged body digest once the real bytes are supplied", () => {
      const built = input();
      const unit = buildSkillsBenchUnit(built);
      const forged = { ...unit, skills: [{ ...unit.skills[0]!, bodySha256: "0".repeat(64) }, unit.skills[1]!] };
      expect(() => verifySkillsBenchUnitBodies(forged, built.skills)).toThrow(/do not recompute from the supplied/u);
    });

    it("refuses a body whose bytes changed by one character", () => {
      const built = input();
      const unit = buildSkillsBenchUnit(built);
      const tampered = built.skills.map((skill) => skill.folder === "citation-management"
        ? { ...skill, skillMd: skill.skillMd.replace("Run the validator", "Skip the validator") }
        : skill);
      expect(() => verifySkillsBenchUnitBodies(unit, tampered)).toThrow(/do not recompute from the supplied/u);
    });

    it("refuses when a skill's bytes are missing entirely", () => {
      const built = input();
      expect(() => verifySkillsBenchUnitBodies(buildSkillsBenchUnit(built), [built.skills[0]!]))
        .toThrow(/no supplied SKILL\.md bytes/u);
    });
  });

  describe("fail-closed refusals", () => {
    it("refuses a skill folder with no SKILL.md", () => {
      const base = input();
      expect(() => buildSkillsBenchUnit({
        ...base,
        entries: [...base.entries, { path: "environment/skills/orphan/scripts/x.py", mode: "100644", gitBlob: "7".repeat(40), bytes: 1 }],
      })).toThrow(/orphan.*no SKILL\.md/u);
    });

    it("refuses a task package containing a git submodule", () => {
      const base = input();
      expect(() => buildSkillsBenchUnit({
        ...base,
        entries: [...base.entries, { path: "environment/SimPO/alignment-handbook", mode: "160000", gitBlob: "8".repeat(40), bytes: 0 }],
      })).toThrow(/submodule/u);
    });

    it("refuses a symlink or other non-regular entry", () => {
      const base = input();
      expect(() => buildSkillsBenchUnit({
        ...base,
        entries: [...base.entries, { path: "environment/link", mode: "120000", gitBlob: "9".repeat(40), bytes: 0 }],
      })).toThrow(/unsupported file mode/u);
    });

    it("refuses a unit with no skills at all", () => {
      const base = input();
      expect(() => buildSkillsBenchUnit({ ...base, skills: [], entries: base.entries.filter((e) => !e.path.includes("/skills/")) }))
        .toThrow(/carries no curated skill/u);
    });

    it("refuses a SKILL.md whose frontmatter names a different skill than its folder", () => {
      // Verified against the pinned release: all 232 SKILL.md files agree with their folder, so
      // this rejects nothing real. It is fail-closed because the folder is what the runtime mounts
      // while the name is what the agent routes on — a disagreement is a live ambiguity in arm A.
      const base = input();
      expect(() => buildSkillsBenchUnit({
        ...base,
        skills: [{ folder: "citation-management", skillMd: SKILL_MD }, { folder: "d3-visualization", skillMd: SKILL_MD }],
      })).toThrow(/frontmatter name/u);
    });

    it("refuses an unknown declared network mode", () => {
      const base = input();
      expect(() => buildSkillsBenchUnit({
        ...base,
        statement: { ...base.statement, frontmatter: { ...base.statement.frontmatter, networkMode: "wide-open" } },
      })).toThrow(/network mode/u);
    });
  });
});

describe("resource classification", () => {
  it.each([
    ["references/a.md", "100644", "instruction-bearing"],
    ["rules/style.md", "100644", "instruction-bearing"],
    ["reference.md", "100644", "instruction-bearing"],
    ["scripts/run.py", "100644", "executable-resource"],
    ["tool.py", "100755", "executable-resource"],
    ["assets/logo.png", "100644", "data-resource"],
    ["ooxml/theme.xml", "100644", "data-resource"],
    ["LICENSE.txt", "100644", "license-notice"],
    ["obspy.LICENSE", "100644", "license-notice"],
    ["NOTICE", "100644", "license-notice"],
  ])("classifies %s (%s) as %s", (path, mode, expected) => {
    expect(classifySkillsBenchResource(path, mode)).toBe(expected);
  });

  it("treats a markdown resource as instruction-bearing even outside references/", () => {
    // The roster ships forms.md, ooxml.md, html2pptx.md, HOW_TO_USE.md at skill roots. Calling
    // those "non-instruction resources" would understate what arms B and C still receive.
    expect(classifySkillsBenchResource("HOW_TO_USE.md", "100644")).toBe("instruction-bearing");
  });
});
