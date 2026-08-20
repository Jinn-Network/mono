import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SKILLSBENCH_ARMS,
  SKILLSBENCH_CLAUDE_MD_TRANSFORM,
  SKILLSBENCH_TREATMENT_SCHEMA,
  buildSkillsBenchClaudeMd,
  buildSkillsBenchTreatment,
  canonicalSkillsBenchTreatmentBytes,
  verifySkillsBenchClaudeMdBodies,
  verifySkillsBenchTreatment,
} from "./skillsbench-treatment.js";
import { buildSkillsBenchUnit, type SkillsBenchUnitBuildInput } from "./skillsbench-unit.js";

const ALPHA_BODY = "Check the manifest before replacing a part.\n";
const BETA_BODY = "Prefer the tabular export when both are available.\n";
const ALPHA_MD = `---\nname: alpha-skill\ndescription: Repair widgets.\n---\n\n${ALPHA_BODY}`;
const BETA_MD = `---\nname: beta-skill\ndescription: Export tables.\n---\n\n${BETA_BODY}`;

function unitInput(overrides: Partial<SkillsBenchUnitBuildInput> = {}): SkillsBenchUnitBuildInput {
  return {
    task: { name: "widget-task", treeSha: "a".repeat(40), packageDigest: "b".repeat(64) },
    statement: {
      path: "task.md",
      gitBlob: "c".repeat(40),
      bytes: 80,
      frontmatter: { networkMode: "no-network", verifierType: "test-script", agentTimeoutSec: 900, verifierTimeoutSec: 900 },
      body: "Repair the assembly.",
    },
    entries: [
      { path: "task.md", mode: "100644", gitBlob: "c".repeat(40), bytes: 80 },
      { path: "environment/Dockerfile", mode: "100644", gitBlob: "d".repeat(40), bytes: 200 },
      { path: "environment/data/parts.csv", mode: "100644", gitBlob: "e".repeat(40), bytes: 500 },
      { path: "environment/skills/alpha-skill/SKILL.md", mode: "100644", gitBlob: "1".repeat(40), bytes: ALPHA_MD.length },
      { path: "environment/skills/alpha-skill/scripts/run.py", mode: "100755", gitBlob: "2".repeat(40), bytes: 300 },
      { path: "environment/skills/beta-skill/SKILL.md", mode: "100644", gitBlob: "3".repeat(40), bytes: BETA_MD.length },
      { path: "environment/skills/beta-skill/references/guide.md", mode: "100644", gitBlob: "4".repeat(40), bytes: 900 },
      { path: "oracle/solve.sh", mode: "100755", gitBlob: "5".repeat(40), bytes: 100 },
      { path: "verifier/test.sh", mode: "100755", gitBlob: "6".repeat(40), bytes: 100 },
    ],
    skills: [{ folder: "alpha-skill", skillMd: ALPHA_MD }, { folder: "beta-skill", skillMd: BETA_MD }],
    rootLicenseSpdxId: "Apache-2.0",
    ...overrides,
  };
}

const bodies = [{ folder: "alpha-skill", body: ALPHA_BODY }, { folder: "beta-skill", body: BETA_BODY }];
const unit = () => buildSkillsBenchUnit(unitInput());
const treatment = (b = bodies) => buildSkillsBenchTreatment({ unit: unit(), bodies: b });

describe("treatment manifest", () => {
  it("generates all three arms from one authenticated unit", () => {
    const result = treatment();
    expect(result.schema).toBe(SKILLSBENCH_TREATMENT_SCHEMA);
    expect(result.arms.map((arm) => arm.arm)).toEqual([...SKILLSBENCH_ARMS]);
    expect(result.feasible).toBe(true);
    expect(() => verifySkillsBenchTreatment(result)).not.toThrow();
  });

  it("orders skills lexically by upstream folder path", () => {
    expect(treatment().skillOrder).toEqual(["alpha-skill", "beta-skill"]);
  });

  it("is deterministic — the same unit yields byte-identical output", () => {
    expect(Buffer.from(canonicalSkillsBenchTreatmentBytes(treatment())))
      .toEqual(Buffer.from(canonicalSkillsBenchTreatmentBytes(treatment())));
  });

  describe("arm A", () => {
    it("keeps every SKILL.md and native discovery", () => {
      const a = treatment().arms.find((arm) => arm.arm === "A-native-skill")!;
      expect(a.nativeSkillDiscovery).toBe(true);
      expect(a.files.filter((f) => f.role === "instruction-body").map((f) => f.path)).toEqual([
        "environment/skills/alpha-skill/SKILL.md",
        "environment/skills/beta-skill/SKILL.md",
      ]);
      expect(a.claudeMdSha256).toBeNull();
    });
  });

  describe("arm B", () => {
    it("exposes no native-discoverable SKILL.md", () => {
      const b = treatment().arms.find((arm) => arm.arm === "B-flat-claude-md")!;
      expect(b.nativeSkillDiscovery).toBe(false);
      expect(b.files.some((f) => f.path.endsWith("SKILL.md"))).toBe(false);
      expect(b.claudeMdSha256).toMatch(/^[0-9a-f]{64}$/u);
    });

    it("embeds every body byte-identically, provably from the emitted file alone", () => {
      const claudeMd = buildSkillsBenchClaudeMd(unit(), bodies);
      expect(() => verifySkillsBenchClaudeMdBodies(claudeMd, unit())).not.toThrow();
      // The proof a third party runs: pull each span out and hash it.
      for (const body of [ALPHA_BODY, BETA_BODY]) expect(claudeMd).toContain(body);
      const digests = [...claudeMd.matchAll(/sha256=([0-9a-f]{64})/gu)].map((m) => m[1]);
      expect(digests).toContain(createHash("sha256").update(ALPHA_BODY).digest("hex"));
      expect(digests).toContain(createHash("sha256").update(BETA_BODY).digest("hex"));
    });

    it("carries only a versioned, content-neutral wrapper", () => {
      const claudeMd = buildSkillsBenchClaudeMd(unit(), bodies);
      const withoutBodies = claudeMd.replace(ALPHA_BODY, "").replace(BETA_BODY, "");
      expect(withoutBodies).toContain(SKILLSBENCH_CLAUDE_MD_TRANSFORM);
      // No trigger wording, no instruction, no summary — only markers and source identity.
      expect(withoutBodies).not.toMatch(/\b(?:use|invoke|follow|consult|apply|should|must)\b/iu);
    });

    it("emits no frontmatter", () => {
      expect(buildSkillsBenchClaudeMd(unit(), bodies)).not.toMatch(/^---$/mu);
    });

    it("refuses a body that does not match its authenticated digest", () => {
      expect(() => buildSkillsBenchClaudeMd(unit(), [{ folder: "alpha-skill", body: "tampered\n" }, bodies[1]!]))
        .toThrow(/does not match its authenticated digest/u);
    });

    it("detects a body swapped after generation", () => {
      const claudeMd = buildSkillsBenchClaudeMd(unit(), bodies).replace(ALPHA_BODY, "Skip the manifest.\n");
      expect(() => verifySkillsBenchClaudeMdBodies(claudeMd, unit())).toThrow(/not byte-identical/u);
    });

    it("detects a dropped body", () => {
      const claudeMd = buildSkillsBenchClaudeMd(unit(), bodies);
      const truncated = claudeMd.slice(0, claudeMd.indexOf(`<!-- ${SKILLSBENCH_CLAUDE_MD_TRANSFORM} begin source=environment/skills/beta-skill`));
      expect(() => verifySkillsBenchClaudeMdBodies(truncated, unit())).toThrow(/carries 1 wrapped bodies/u);
    });
  });

  describe("arm C", () => {
    it("carries no instruction body and no experiment-created instruction path", () => {
      const c = treatment().arms.find((arm) => arm.arm === "C-no-instructions")!;
      expect(c.claudeMdSha256).toBeNull();
      expect(c.files.some((f) => f.role === "instruction-body" || f.role === "flattened-instruction")).toBe(false);
      expect(c.files.some((f) => f.path.endsWith("SKILL.md") || f.path === "CLAUDE.md")).toBe(false);
    });

    it("still receives the bundle resources, unlike BenchFlow's native no-skill mode", () => {
      // Native no-skill strips the whole skills tree. That would confound delivery with resource
      // availability, so arm C keeps every script, reference, and asset.
      const c = treatment().arms.find((arm) => arm.arm === "C-no-instructions")!;
      expect(c.files.map((f) => f.path)).toContain("environment/skills/alpha-skill/scripts/run.py");
      expect(c.files.map((f) => f.path)).toContain("environment/skills/beta-skill/references/guide.md");
    });
  });

  describe("resource parity", () => {
    it("gives all three arms byte-identical non-instruction resources", () => {
      const result = treatment();
      const digests = result.arms.map((arm) => JSON.stringify(
        arm.files.filter((f) => f.role === "bundle-resource" || f.role === "environment"),
      ));
      expect(new Set(digests).size).toBe(1);
    });

    it("refuses a manifest whose arms were given different resources", () => {
      const result = treatment();
      const forged = {
        ...result,
        arms: result.arms.map((arm) => arm.arm === "C-no-instructions"
          ? { ...arm, files: arm.files.filter((f) => !f.path.endsWith("run.py")) }
          : arm),
      };
      expect(() => verifySkillsBenchTreatment(forged)).toThrow(/byte-identical non-instruction resources/u);
    });

    it("refuses a manifest that smuggled a SKILL.md into arm B", () => {
      const result = treatment();
      const forged = {
        ...result,
        arms: result.arms.map((arm) => arm.arm === "B-flat-claude-md"
          ? { ...arm, files: [...arm.files, { path: "environment/skills/alpha-skill/SKILL.md", mode: "100644", role: "instruction-body" as const }] }
          : arm),
      };
      expect(() => verifySkillsBenchTreatment(forged)).toThrow(/no native-discoverable SKILL\.md/u);
    });
  });

  describe("relative-path feasibility", () => {
    it("marks a unit unverifiable when a body reaches for a sibling resource", () => {
      // Moving this body to the repository root changes what scripts/run.py resolves to, so arms A
      // and B would not receive the same instructions in practice. Never hand-repaired.
      const withReference = "Run scripts/run.py before replacing a part.\n";
      const md = `---\nname: alpha-skill\ndescription: Repair widgets.\n---\n\n${withReference}`;
      const built = buildSkillsBenchUnit(unitInput({
        skills: [{ folder: "alpha-skill", skillMd: md }, { folder: "beta-skill", skillMd: BETA_MD }],
      }));
      const result = buildSkillsBenchTreatment({
        unit: built,
        bodies: [{ folder: "alpha-skill", body: withReference }, { folder: "beta-skill", body: BETA_BODY }],
      });
      expect(result.feasible).toBe(false);
      expect(result.unverifiableReasons[0]).toMatch(/alpha-skill:relative-resource-reference/u);
      expect(result.arms.find((arm) => arm.arm === "B-flat-claude-md")!.claudeMdSha256).toBeNull();
      expect(() => verifySkillsBenchTreatment(result)).not.toThrow();
    });

    it("marks a unit unverifiable when a body is not supplied", () => {
      const result = treatment([bodies[0]!]);
      expect(result.feasible).toBe(false);
      expect(result.unverifiableReasons).toContain("beta-skill:body-not-supplied");
    });

    it("does not flag prose that merely mentions a directory word", () => {
      const plain = "Keep references consistent and document the assets you used.\n";
      const md = `---\nname: alpha-skill\ndescription: Repair widgets.\n---\n\n${plain}`;
      const built = buildSkillsBenchUnit(unitInput({
        skills: [{ folder: "alpha-skill", skillMd: md }, { folder: "beta-skill", skillMd: BETA_MD }],
      }));
      const result = buildSkillsBenchTreatment({
        unit: built,
        bodies: [{ folder: "alpha-skill", body: plain }, { folder: "beta-skill", body: BETA_BODY }],
      });
      expect(result.feasible).toBe(true);
    });
  });
});
