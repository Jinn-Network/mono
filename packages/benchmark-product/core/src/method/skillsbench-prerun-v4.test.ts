import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessSkillsBenchStaticAdmission, type SkillsBenchAdmissionInput } from "./skillsbench-admission.js";
import {
  DEMO1_PRE_RUN_FREEZE_V4_SCHEMA,
  buildDemo1PreRunFreezeV4,
  canonicalDemo1PreRunFreezeV4Bytes,
  demo1PreRunFreezeV4AsE2Input,
  demo1PreRunFreezeV4Digest,
  verifyDemo1PreRunFreezeV4,
  type Demo1PreRunFreezeV4Input,
} from "./skillsbench-prerun-v4.js";
import { SKILLSBENCH_V1_1_SOURCE } from "./skillsbench-source.js";
import { readSkillsBenchReward } from "./skillsbench-reward.js";
import { buildSkillsBenchUnit, type SkillsBenchUnitBuildInput } from "./skillsbench-unit.js";

const V3_PATH = new URL(
  "../../../../../docs/superpowers/plans/demo-report-1/E1-pre-run-freeze.stop.v3.json",
  import.meta.url,
);
const V3_SHA256 = createHash("sha256").update(readFileSync(V3_PATH)).digest("hex");

const SKILL_MD = `---\nname: widget-repair\ndescription: Repair widgets.\n---\n\nRead the manifest first.\n`;

function admissionInput(name: string, networkMode = "no-network"): SkillsBenchAdmissionInput {
  const built: SkillsBenchUnitBuildInput = {
    task: { name, treeSha: "a".repeat(40), packageDigest: "b".repeat(64) },
    statement: {
      path: "task.md",
      gitBlob: "c".repeat(40),
      bytes: 50,
      frontmatter: { networkMode, verifierType: "test-script", agentTimeoutSec: 900, verifierTimeoutSec: 900 },
      body: "Repair the assembly.",
    },
    entries: [
      { path: "task.md", mode: "100644", gitBlob: "c".repeat(40), bytes: 50 },
      { path: "environment/Dockerfile", mode: "100644", gitBlob: "d".repeat(40), bytes: 200 },
      { path: `environment/skills/widget-repair/SKILL.md`, mode: "100644", gitBlob: "e".repeat(40), bytes: SKILL_MD.length },
      { path: "oracle/solve.sh", mode: "100755", gitBlob: "f".repeat(40), bytes: 10 },
      { path: "verifier/test.sh", mode: "100755", gitBlob: "1".repeat(40), bytes: 10 },
    ],
    skills: [{ folder: "widget-repair", skillMd: SKILL_MD }],
    rootLicenseSpdxId: "Apache-2.0",
  };
  return {
    unit: buildSkillsBenchUnit(built),
    statementBody: built.statement.body,
    // Cluster depth matters: pools need 6 + 10 + 5 units across disjoint clusters, so an inventory
    // of singleton clusters cannot fill them however many units it has.
    cluster: { skillContentDigests: [`s-${name.replace(/-u\d+$/u, "")}`], inputFamilyDigests: [], taskLineageIds: [], verificationDigests: [] },
    answerCollision: null,
  };
}

function freezeInput(units: readonly SkillsBenchAdmissionInput[], refused: readonly { taskId: string; reason: string }[] = []): Demo1PreRunFreezeV4Input {
  return {
    supersedes: { schema: "jinn.demo1.pre-run-freeze.v3", sha256: V3_SHA256 },
    source: {
      repositoryUrl: SKILLSBENCH_V1_1_SOURCE.repositoryUrl,
      releaseTag: SKILLSBENCH_V1_1_SOURCE.releaseTag,
      commit: SKILLSBENCH_V1_1_SOURCE.commit,
      tasksTree: SKILLSBENCH_V1_1_SOURCE.tasksTree,
      benchflowCommit: SKILLSBENCH_V1_1_SOURCE.benchflow.pinnedCommit,
    },
    roster: { declaredActive: units.length + refused.length, inventoried: units.length, refused },
    admission: assessSkillsBenchStaticAdmission(units),
    treatment: units.map((entry) => ({ taskId: entry.unit.task.name, feasible: true, unverifiableReasons: [] })),
  };
}

/** `clusters` independence groups, `perCluster` units in each. */
function deepInventory(clusters: number, perCluster = 3, networkMode = "no-network"): SkillsBenchAdmissionInput[] {
  const rows: SkillsBenchAdmissionInput[] = [];
  for (let c = 0; c < clusters; c += 1) {
    for (let u = 0; u < perCluster; u += 1) {
      rows.push(admissionInput(`c${String(c).padStart(2, "0")}-u${u}`, networkMode));
    }
  }
  return rows;
}

describe("pre-run freeze v4", () => {
  it("supersedes the exact on-disk v3 bytes, continuing the v2 ← v3 ← v4 chain", () => {
    const freeze = buildDemo1PreRunFreezeV4(freezeInput([admissionInput("a")]));
    expect(freeze.schema).toBe(DEMO1_PRE_RUN_FREEZE_V4_SCHEMA);
    expect(freeze.inputs.supersedes.schema).toBe("jinn.demo1.pre-run-freeze.v3");
    expect(freeze.inputs.supersedes.sha256).toBe(V3_SHA256);
  });

  it("refuses a supersession that does not name v3 by digest", () => {
    const input = freezeInput([admissionInput("a")]);
    expect(() => buildDemo1PreRunFreezeV4({ ...input, supersedes: { ...input.supersedes, sha256: "nope" } }))
      .toThrow(/supersession identity is invalid/u);
  });

  it("refuses a source commit that is not the pinned release", () => {
    const input = freezeInput([admissionInput("a")]);
    expect(() => buildDemo1PreRunFreezeV4({ ...input, source: { ...input.source, commit: "0".repeat(40) as never } }))
      .toThrow(/does not match the pinned SkillsBench release/u);
  });

  it("refuses a roster that does not account for every declared active task", () => {
    const input = freezeInput([admissionInput("a")]);
    expect(() => buildDemo1PreRunFreezeV4({ ...input, roster: { ...input.roster, declaredActive: 87 } }))
      .toThrow(/does not account for every declared active task/u);
  });

  it("accounts zero execution of every kind", () => {
    expect(buildDemo1PreRunFreezeV4(freezeInput([admissionInput("a")])).execution).toEqual({
      modelArms: 0, previews: 0, dockerControls: 0, suitabilityCells: 0, rehearsalCells: 0, officialCells: 0,
    });
  });

  describe("status derivation", () => {
    it("STOPs when the pools cannot be filled cluster-disjointly", () => {
      // 21 units in 21 singleton clusters clears the unit and cluster counts but cannot supply a
      // ten-unit rehearsal pool from five clusters. Counting units alone would have missed this.
      const freeze = buildDemo1PreRunFreezeV4(freezeInput(Array.from({ length: 21 }, (_, i) => admissionInput(`solo${i}`))));
      expect(freeze.derived.capacity.admissible.units).toBe(21);
      expect(freeze.derived.status).toBe("stop");
      expect(freeze.derived.stopReasons).toContain("pools-cannot-be-filled-cluster-disjointly");
      expect(freeze.derived.partition).toBeNull();
    });

    it("STOPs below the unit floor and names the shortfall exactly", () => {
      const freeze = buildDemo1PreRunFreezeV4(freezeInput(Array.from({ length: 20 }, (_, i) => admissionInput(`t${i}`))));
      expect(freeze.derived.status).toBe("stop");
      expect(freeze.derived.stopReasons).toContain("insufficient-admissible-units:20/21");
    });

    it("is READY at 21 admissible units across 21 clusters", () => {
      const freeze = buildDemo1PreRunFreezeV4(freezeInput(deepInventory(13, 3)));
      expect(freeze.derived.status).toBe("ready");
      expect(freeze.derived.stopReasons).toEqual([]);
      expect(freeze.derived.partition).not.toBeNull();
    });

    it("derives READY from measured admissible capacity, never from the broker counterfactual", () => {
      // 30 units that would clear everything except egress. A broker that has not been built and
      // evidenced cannot make a unit admissible, so this must still STOP.
      const freeze = buildDemo1PreRunFreezeV4(freezeInput(
        Array.from({ length: 30 }, (_, i) => admissionInput(`t${i}`, "public")),
      ));
      expect(freeze.derived.capacity.egressBlockedOnly.units).toBe(30);
      expect(freeze.derived.capacity.admissible.units).toBe(0);
      expect(freeze.derived.status).toBe("stop");
    });

    it("reports the counterfactual and treatment-feasible capacities separately", () => {
      const units = Array.from({ length: 10 }, (_, i) => admissionInput(`t${i}`, "public"));
      const input = freezeInput(units);
      const freeze = buildDemo1PreRunFreezeV4({
        ...input,
        treatment: units.map((entry, index) => ({
          taskId: entry.unit.task.name,
          feasible: index < 4,
          unverifiableReasons: index < 4 ? [] : ["widget-repair:relative-resource-reference:scripts/x.py"],
        })),
      });
      expect(freeze.derived.capacity.egressBlockedOnly.units).toBe(10);
      expect(freeze.derived.capacity.treatmentFeasible.units).toBe(4);
    });
  });

  describe("E2 handoff guard", () => {
    it("refuses to convert a STOP freeze into E2 input", () => {
      const freeze = buildDemo1PreRunFreezeV4(freezeInput([admissionInput("a")]));
      expect(freeze.derived.status).toBe("stop");
      expect(() => demo1PreRunFreezeV4AsE2Input(freeze)).toThrow(/a STOP freeze cannot authorize E2/u);
    });

    it("refuses a STOP freeze whose status was hand-edited to ready", () => {
      const freeze = buildDemo1PreRunFreezeV4(freezeInput([admissionInput("a")]));
      const forged = { ...freeze, derived: { ...freeze.derived, status: "ready" as const, stopReasons: [] } };
      expect(() => demo1PreRunFreezeV4AsE2Input(forged)).toThrow(/do not recompute/u);
    });

    it("refuses E2 from a statically-READY freeze that has no dynamic evidence", () => {
      // The dangerous case. Static capacity clearing the floor must authorize the no-model
      // controls and nothing more; treating it as permission to spend inference is exactly how a
      // screening step silently becomes a green light.
      const freeze = buildDemo1PreRunFreezeV4(freezeInput(deepInventory(13, 3)));
      expect(freeze.derived.status).toBe("ready");
      expect(freeze.derived.authorizes).toBe("dynamic-controls");
      expect(() => demo1PreRunFreezeV4AsE2Input(freeze))
        .toThrow(/authorizes the no-model dynamic controls, not E2/u);
    });

    it("hands off to E2 only once every admitted unit carries oracle and no-op evidence", () => {
      const controls = {
        oracle: readSkillsBenchReward({ rewardTxt: "1" }),
        noOp: readSkillsBenchReward({ rewardTxt: "0" }),
      };
      const units = deepInventory(13, 3).map((entry) => ({ ...entry, dynamicControls: controls }));
      const freeze = buildDemo1PreRunFreezeV4(freezeInput(units));
      expect(freeze.derived.authorizes).toBe("e2");
      expect(freeze.derived.dynamicEvidence).toEqual({ admitted: 39, withOracleEvidence: 39, withNoOpEvidence: 39 });
      const handoff = demo1PreRunFreezeV4AsE2Input(freeze);
      expect(handoff.taskIds).toHaveLength(39);
      expect(handoff.seed).toBeGreaterThan(0);
    });

    it("refuses E2 when even one admitted unit lacks a passing oracle", () => {
      const good = { oracle: readSkillsBenchReward({ rewardTxt: "1" }), noOp: readSkillsBenchReward({ rewardTxt: "0" }) };
      const bad = { oracle: readSkillsBenchReward({ rewardTxt: "0" }), noOp: readSkillsBenchReward({ rewardTxt: "0" }) };
      const units = deepInventory(13, 3).map((entry, i) => ({ ...entry, dynamicControls: i === 7 ? bad : good }));
      const freeze = buildDemo1PreRunFreezeV4(freezeInput(units));
      expect(freeze.derived.authorizes).not.toBe("e2");
      expect(() => demo1PreRunFreezeV4AsE2Input(freeze)).toThrow(/not E2/u);
    });
  });

  describe("recomputability", () => {
    it("rebuilds byte-identically from its own inputs", () => {
      const freeze = buildDemo1PreRunFreezeV4(freezeInput([admissionInput("a")]));
      expect(() => verifyDemo1PreRunFreezeV4(freeze)).not.toThrow();
      expect(Buffer.from(canonicalDemo1PreRunFreezeV4Bytes(freeze)))
        .toEqual(Buffer.from(canonicalDemo1PreRunFreezeV4Bytes(buildDemo1PreRunFreezeV4(freeze.inputs))));
      expect(demo1PreRunFreezeV4Digest(freeze)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    });

    it("refuses a substituted capacity number", () => {
      const freeze = buildDemo1PreRunFreezeV4(freezeInput([admissionInput("a")]));
      const forged = {
        ...freeze,
        derived: { ...freeze.derived, capacity: { ...freeze.derived.capacity, admissible: { units: 99, clusters: 99 } } },
      };
      expect(() => verifyDemo1PreRunFreezeV4(forged)).toThrow(/do not recompute/u);
    });

    it("resolves a nonzero seed that authorizes nothing while status is stop", () => {
      const freeze = buildDemo1PreRunFreezeV4(freezeInput([admissionInput("a")]));
      expect(freeze.derived.seeds.taskSelection).toBeGreaterThan(0);
      expect(() => demo1PreRunFreezeV4AsE2Input(freeze)).toThrow();
    });
  });
});
