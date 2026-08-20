import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkillsBenchClaudeMd, buildSkillsBenchTreatment } from "../method/skillsbench-treatment.js";
import { buildSkillsBenchUnit, type SkillsBenchUnitBuildInput } from "../method/skillsbench-unit.js";
import {
  SKILLSBENCH_PLUGIN_DIR,
  SKILLSBENCH_WORKSPACE_LAYOUT,
  materializeSkillsBenchWorkspace,
  verifySkillsBenchWorkspaceTriple,
} from "./skillsbench-workspace.js";

const ALPHA_BODY = "Check the manifest before replacing a part.\n";
const BETA_BODY = "Prefer the tabular export.\n";
const ALPHA_MD = `---\nname: alpha\ndescription: Repair widgets.\n---\n\n${ALPHA_BODY}`;
const BETA_MD = `---\nname: beta\ndescription: Export tables.\n---\n\n${BETA_BODY}`;

const created: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-ws-"));
  created.push(dir);
  return dir;
}
afterEach(() => { while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true }); });

const entries = [
  { path: "task.md", mode: "100644", gitBlob: "c".repeat(40), bytes: 10 },
  { path: "environment/Dockerfile", mode: "100644", gitBlob: "d".repeat(40), bytes: 10 },
  { path: "environment/data.json", mode: "100644", gitBlob: "e".repeat(40), bytes: 10 },
  { path: "environment/skills/alpha/SKILL.md", mode: "100644", gitBlob: "1".repeat(40), bytes: ALPHA_MD.length },
  { path: "environment/skills/alpha/scripts/run.py", mode: "100755", gitBlob: "2".repeat(40), bytes: 10 },
  { path: "environment/skills/beta/SKILL.md", mode: "100644", gitBlob: "3".repeat(40), bytes: BETA_MD.length },
  { path: "environment/skills/beta/references/guide.md", mode: "100644", gitBlob: "4".repeat(40), bytes: 10 },
  { path: "oracle/solve.sh", mode: "100755", gitBlob: "5".repeat(40), bytes: 10 },
  { path: "verifier/test.sh", mode: "100755", gitBlob: "6".repeat(40), bytes: 10 },
];

function unit() {
  const input: SkillsBenchUnitBuildInput = {
    task: { name: "widget-task", treeSha: "a".repeat(40), packageDigest: "b".repeat(64) },
    statement: {
      path: "task.md", gitBlob: "c".repeat(40), bytes: 10,
      frontmatter: { networkMode: "no-network", verifierType: "test-script", agentTimeoutSec: 900, verifierTimeoutSec: 900 },
      body: "Repair it.",
    },
    entries,
    skills: [{ folder: "alpha", skillMd: ALPHA_MD }, { folder: "beta", skillMd: BETA_MD }],
    rootLicenseSpdxId: "Apache-2.0",
  };
  return buildSkillsBenchUnit(input);
}

/** Writes the package to disk the way the control runner fetches it. */
function packageDir(): string {
  const dir = scratch();
  const files: Record<string, string> = {
    "environment/Dockerfile": "FROM scratch\n",
    "environment/data.json": "{}\n",
    "environment/skills/alpha/SKILL.md": ALPHA_MD,
    "environment/skills/alpha/scripts/run.py": "print('x')\n",
    "environment/skills/beta/SKILL.md": BETA_MD,
    "environment/skills/beta/references/guide.md": "# guide\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, ...path.split("/"));
    mkdirSync(resolve(target, ".."), { recursive: true });
    // Bundled scripts ship executable upstream — 49 blobs in the real roster are mode 100755 — so
    // the fixture has to be executable for the preservation test to mean anything.
    writeFileSync(target, content, { mode: path.endsWith(".py") ? 0o755 : 0o644 });
  }
  return dir;
}

function triple() {
  const built = unit();
  const bodies = [{ folder: "alpha", body: ALPHA_BODY }, { folder: "beta", body: BETA_BODY }];
  const treatment = buildSkillsBenchTreatment({ unit: built, bodies });
  const claudeMd = buildSkillsBenchClaudeMd(built, bodies);
  const pkg = packageDir();
  return (["A-native-skill", "B-flat-claude-md", "C-no-instructions"] as const).map((arm) =>
    materializeSkillsBenchWorkspace({ treatment, arm, packageDir: pkg, workspaceDir: scratch(), claudeMd }));
}

describe("arm workspace materialization", () => {
  it("produces a valid A/B/C triple", () => {
    const workspaces = triple();
    expect(workspaces[0]!.layout).toBe(SKILLSBENCH_WORKSPACE_LAYOUT);
    expect(() => verifySkillsBenchWorkspaceTriple(workspaces)).not.toThrow();
  });

  it("gives all three arms byte-identical non-instruction resources", () => {
    // The property that keeps the contrast about delivery rather than availability.
    const digests = new Set(triple().map((workspace) => workspace.resourceParityDigest));
    expect(digests.size).toBe(1);
  });

  it("places every bundle resource at the same path in every arm", () => {
    for (const workspace of triple()) {
      const paths = workspace.files.map((file) => file.path);
      expect(paths).toContain("skills/alpha/scripts/run.py");
      expect(paths).toContain("skills/beta/references/guide.md");
      expect(paths).toContain("data.json");
    }
  });

  it("preserves the executable bit on bundled scripts", () => {
    const script = triple()[2]!.files.find((file) => file.path === "skills/alpha/scripts/run.py");
    expect(script!.mode & 0o111).not.toBe(0);
  });

  describe("arm A", () => {
    it("puts every SKILL.md in a plugin root and passes --plugin-dir", () => {
      const a = triple()[0]!;
      expect(a.files.map((f) => f.path)).toContain(`${SKILLSBENCH_PLUGIN_DIR}/skills/alpha/SKILL.md`);
      expect(a.files.map((f) => f.path)).toContain(`${SKILLSBENCH_PLUGIN_DIR}/skills/beta/SKILL.md`);
      expect(a.files.map((f) => f.path)).toContain(`${SKILLSBENCH_PLUGIN_DIR}/.claude-plugin/plugin.json`);
      expect(a.argv[0]).toBe("--plugin-dir");
    });

    it("carries no root CLAUDE.md", () => {
      expect(triple()[0]!.files.map((f) => f.path)).not.toContain("CLAUDE.md");
    });
  });

  describe("arm B", () => {
    it("carries the flattened CLAUDE.md and no SKILL.md anywhere", () => {
      const b = triple()[1]!;
      expect(b.files.map((f) => f.path)).toContain("CLAUDE.md");
      expect(b.files.some((f) => f.path.endsWith("SKILL.md"))).toBe(false);
      expect(b.argv).toEqual([]);
    });
  });

  describe("arm C", () => {
    it("carries neither a SKILL.md nor a CLAUDE.md", () => {
      const c = triple()[2]!;
      expect(c.files.some((f) => f.path.endsWith("SKILL.md"))).toBe(false);
      expect(c.files.map((f) => f.path)).not.toContain("CLAUDE.md");
      expect(c.argv).toEqual([]);
    });

    it("still receives the bundle resources", () => {
      expect(triple()[2]!.files.map((f) => f.path)).toContain("skills/alpha/scripts/run.py");
    });
  });

  describe("refusals", () => {
    it("refuses to materialize an unverifiable unit", () => {
      const built = unit();
      const treatment = buildSkillsBenchTreatment({ unit: built, bodies: [{ folder: "alpha", body: ALPHA_BODY }] });
      expect(treatment.feasible).toBe(false);
      expect(() => materializeSkillsBenchWorkspace({
        treatment, arm: "C-no-instructions", packageDir: packageDir(), workspaceDir: scratch(),
      })).toThrow(/unverifiable and must not be materialized/u);
    });

    it("refuses arm B without a generated CLAUDE.md", () => {
      const built = unit();
      const bodies = [{ folder: "alpha", body: ALPHA_BODY }, { folder: "beta", body: BETA_BODY }];
      const treatment = buildSkillsBenchTreatment({ unit: built, bodies });
      expect(() => materializeSkillsBenchWorkspace({
        treatment, arm: "B-flat-claude-md", packageDir: packageDir(), workspaceDir: scratch(),
      })).toThrow(/requires the generated CLAUDE\.md/u);
    });

    it("refuses a triple whose arms were given different resources", () => {
      const workspaces = triple();
      const tampered = [workspaces[0]!, workspaces[1]!, { ...workspaces[2]!, resourceParityDigest: "0".repeat(64) }];
      expect(() => verifySkillsBenchWorkspaceTriple(tampered)).toThrow(/byte-identical non-instruction resources/u);
    });

    it("refuses a triple where arm B smuggled in a plugin root", () => {
      const workspaces = triple();
      const tampered = [
        workspaces[0]!,
        { ...workspaces[1]!, files: [...workspaces[1]!.files, { path: `${SKILLSBENCH_PLUGIN_DIR}/skills/alpha/SKILL.md`, sha256: "0".repeat(64), mode: 0o644 }] },
        workspaces[2]!,
      ];
      expect(() => verifySkillsBenchWorkspaceTriple(tampered)).toThrow(/natively discoverable SKILL\.md/u);
    });
  });
});
