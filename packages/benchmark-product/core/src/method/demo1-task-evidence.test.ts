import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEMO1_POOL_PARTITION_POLICY,
  DEMO1_PRE_RUN_FREEZE_V3_SCHEMA,
  DEMO1_TASK_EVIDENCE_SCHEMA,
  buildDemo1PreRunFreezeV3,
  buildDemo1TaskEvidenceArtifact,
  canonicalDemo1PreRunFreezeV3Bytes,
  demo1PreRunFreezeV3Digest,
  demo1PreRunFreezeV3AsV2,
  demo1TaskEvidenceDigest,
  parseDemo1UpstreamSkill,
  verifyDemo1PreRunFreezeV3,
  verifyDemo1TaskEvidenceArtifact,
  type Demo1EvidenceCheck,
  type Demo1PreRunFreeze,
  type Demo1PreRunFreezeV3Input,
  type Demo1PreRunFreezeV3,
  type Demo1TaskEvidenceArtifact,
  type Demo1TaskEvidenceBuildInput,
  type Demo1TaskEvidenceUniverseTask,
} from "../index.js";

const oldArtifactUrl = new URL(
  "../../../../../docs/superpowers/plans/demo-report-1/E1-pre-run-freeze.stop.v2.json",
  import.meta.url,
);
const brandSkillUrl = new URL("./__fixtures__/anthropics-skills-f17010-brand-guidelines.SKILL.md", import.meta.url);
const taskEvidenceUrl = new URL(
  "../../../../../docs/superpowers/plans/demo-report-1/E1-task-evidence.v1.json",
  import.meta.url,
);
const v3ArtifactUrl = new URL(
  "../../../../../docs/superpowers/plans/demo-report-1/E1-pre-run-freeze.stop.v3.json",
  import.meta.url,
);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const evidence = (name: string) => ({ uri: `urn:jinn:demo1:external-evidence:${name}`, sha256: digest(name) });
const match = (name: string): Demo1EvidenceCheck => ({ status: "match", evidence: [evidence(name)] });
const mismatch = (name: string): Demo1EvidenceCheck => ({ status: "mismatch", evidence: [evidence(name)] });

function task(index: number, repository: string, problem = "Update the brand theme colors"): Demo1TaskEvidenceUniverseTask {
  const id = `fixture-task-${index}`;
  return {
    taskId: id,
    repository,
    dataset: "fixture/dataset",
    split: "test",
    baseCommit: digest(`commit:${id}`).slice(0, 40),
    rowHash: `sha256:${digest(`row:${id}`)}`,
    imageDigest: `sha256:${digest(`image:${id}`)}`,
    imageName: `fixture/${id}:latest`,
    problemStatement: problem,
    goldPatch: `diff --git a/ui/file-${index}.css b/ui/file-${index}.css\n--- a/ui/file-${index}.css\n+++ b/ui/file-${index}.css\n@@ -1 +1 @@\n---x: red;\n+--x: blue;\n`,
    testPatch: "",
    failToPass: [],
  };
}

function taskEvidence(
  tasks: readonly Demo1TaskEvidenceUniverseTask[],
  complete: boolean,
  licenseMismatchTaskId?: string,
) {
  const parsed = parseDemo1UpstreamSkill(readFileSync(brandSkillUrl));
  const candidate = {
    repositoryPath: "skills/brand-guidelines",
    description: parsed.description,
    sourceMd: new TextDecoder().decode(parsed.sourceMd),
  };
  const externalEvidence = complete ? Object.fromEntries(tasks.map((entry) => [
    `${candidate.repositoryPath}\u0000${entry.taskId}`,
    {
      goldPatchPasses: match(`${entry.taskId}:gold`),
      emptyPatchFails: match(`${entry.taskId}:empty`),
      compatibleTaskLicense: entry.taskId === licenseMismatchTaskId
        ? mismatch(`${entry.taskId}:license-mismatch`)
        : match(`${entry.taskId}:license`),
      conflictingInstructionFileAbsent: match(`${entry.taskId}:conflict`),
    },
  ])) : undefined;
  return buildDemo1TaskEvidenceArtifact({
    sourceSnapshots: {
      poolCacheSha256: digest("pool"),
      validatedPoolSha256: digest("validated"),
      validationSemanticsVersion: "fixture-v1",
    },
    candidates: [candidate],
    tasks,
    ...(externalEvidence === undefined ? {} : { externalEvidence }),
  });
}

function v3Input(evidenceArtifact: ReturnType<typeof taskEvidence>): Demo1PreRunFreezeV3Input {
  const old = JSON.parse(readFileSync(oldArtifactUrl, "utf8")) as Demo1PreRunFreeze;
  const { candidates: oldCandidates, ...method } = old.inputs;
  const candidates = oldCandidates.map(({ tasks: _tasks, ...candidate }) => candidate.repositoryPath === "skills/brand-guidelines"
    ? { ...candidate, skillMdBase64: readFileSync(brandSkillUrl).toString("base64") }
    : candidate);
  return {
    supersedes: { schema: old.schema, sha256: digest(readFileSync(oldArtifactUrl)) },
    method,
    candidates,
    taskEvidence: evidenceArtifact,
  };
}

describe("Demo-1 task evidence", () => {
  it("derives candidate-specific domain checks and stops dynamic work at a static capacity ceiling", () => {
    const tasks = [
      task(0, "repo/a"),
      task(1, "repo/b"),
      task(2, "repo/c", "Fix a parser edge case"),
    ];
    const artifact = taskEvidence(tasks, false);
    verifyDemo1TaskEvidenceArtifact(artifact);
    expect(artifact.schema).toBe(DEMO1_TASK_EVIDENCE_SCHEMA);
    expect(artifact.universe).toMatchObject({ tasks: 3, repositories: 3 });
    expect(artifact.derived).toEqual([{
      repositoryPath: "skills/brand-guidelines",
      domainCompatibleTasks: 2,
      fullyEligibleTasks: 0,
      repositoriesWithDomainCompatibleTasks: 2,
    }]);
    expect(artifact.execution).toEqual({ modelArms: 0, previews: 0, dockerControls: 0 });
    expect(artifact.entries.find((entry) => entry.taskId === "fixture-task-2")?.checks.domainCompatible.status)
      .toBe("mismatch");
  });

  it("fails closed on a missing proof, substituted fact, or incomplete cross product", () => {
    const input: Demo1TaskEvidenceBuildInput = {
      sourceSnapshots: {
        poolCacheSha256: digest("pool"),
        validatedPoolSha256: digest("validated"),
        validationSemanticsVersion: "fixture-v1",
      },
      candidates: [{ repositoryPath: "skills/brand-guidelines", description: "brand", sourceMd: "body" }],
      tasks: [task(0, "repo/a")],
      externalEvidence: {
        "skills/brand-guidelines\u0000fixture-task-0": {
          goldPatchPasses: { status: "match", evidence: [] },
        },
      },
    };
    expect(() => buildDemo1TaskEvidenceArtifact(input)).toThrow(/cannot match without evidence/u);
    const artifact = taskEvidence([task(0, "repo/a")], false);
    const changedFact = structuredClone(artifact) as unknown as { facts: Array<{ fact: { detail: string } }> };
    changedFact.facts[0]!.fact.detail = "substituted";
    expect(() => verifyDemo1TaskEvidenceArtifact(changedFact as unknown as ReturnType<typeof taskEvidence>)).toThrow(/fact digest/u);
    const missing = structuredClone(artifact);
    (missing.entries as unknown as unknown[]).pop();
    expect(() => verifyDemo1TaskEvidenceArtifact(missing)).toThrow(/cross product/u);

    const swapped = structuredClone(taskEvidence([task(0, "repo/a"), task(1, "repo/b")], false));
    (swapped.entries[0]!.checks.goldPatchPasses as { evidence: typeof swapped.entries[number]["checks"]["goldPatchPasses"]["evidence"] })
      .evidence = swapped.entries[1]!.checks.goldPatchPasses.evidence;
    expect(() => verifyDemo1TaskEvidenceArtifact(swapped)).toThrow(/does not bind the check/u);

    const checked = JSON.parse(readFileSync(taskEvidenceUrl, "utf8")) as Demo1TaskEvidenceArtifact;
    const changedIdentity = structuredClone(checked);
    const secondCandidateEntry = changedIdentity.entries.find((entry) => entry.candidate === "skills/frontend-design");
    (secondCandidateEntry as unknown as { taskSha256: string }).taskSha256 = digest("substituted-task-identity");
    expect(() => verifyDemo1TaskEvidenceArtifact(changedIdentity)).toThrow(/identity differs across candidates/u);
  });
});

describe("Demo-1 v3 deterministic freeze", () => {
  it("independently verifies the checked-in 197-task STOP and preserves v2 bytes", () => {
    const taskArtifact = JSON.parse(readFileSync(taskEvidenceUrl, "utf8")) as Demo1TaskEvidenceArtifact;
    const freeze = JSON.parse(readFileSync(v3ArtifactUrl, "utf8")) as Demo1PreRunFreezeV3;
    verifyDemo1TaskEvidenceArtifact(taskArtifact);
    verifyDemo1PreRunFreezeV3(freeze);
    expect(taskArtifact.universe).toMatchObject({ tasks: 197, repositories: 123 });
    expect(taskArtifact.derived).toEqual([
      expect.objectContaining({ repositoryPath: "skills/brand-guidelines", domainCompatibleTasks: 0 }),
      expect.objectContaining({ repositoryPath: "skills/frontend-design", domainCompatibleTasks: 3 }),
    ]);
    expect(demo1TaskEvidenceDigest(taskArtifact)).toBe("b136f80342e5d6e7179267590c72d6bcde9c6922ecd61841faf18905daada8e1");
    expect(demo1PreRunFreezeV3Digest(freeze)).toBe("sha256:d439e6729144a74c84f124c058a3c1e01e557091085b9e2c26740884e24b2f3c");
    expect(digest(readFileSync(oldArtifactUrl))).toBe("08b7e7d0a17d8a4c1ff876111a2e0cb49056b3e5bfe313e8684f46d2b85ae58a");
  });

  it("records a terminal static STOP without Docker, model, preview, E2, or official cells", () => {
    const artifact = taskEvidence(Array.from({ length: 6 }, (_, index) => task(index, `repo/${index}`)), false);
    const freeze = buildDemo1PreRunFreezeV3(v3Input(artifact));
    verifyDemo1PreRunFreezeV3(freeze);
    expect(freeze.schema).toBe(DEMO1_PRE_RUN_FREEZE_V3_SCHEMA);
    expect(freeze.derived.status).toBe("stop");
    expect(freeze.derived.stopReasons).toEqual(["no-candidate-meets-static-domain-capacity"]);
    expect(freeze.derived.poolPartitionPolicy).toBe(DEMO1_POOL_PARTITION_POLICY);
    expect(freeze.derived.candidates.find((entry) => entry.repositoryPath === "skills/brand-guidelines"))
      .toMatchObject({ domainCompatibleTaskCount: 6, staticCapacityPossible: false, preE2Ready: false });
    expect(freeze.execution).toEqual({ modelArms: 0, previews: 0, dockerControls: 0, rehearsalCells: 0, officialCells: 0 });
    expect(() => demo1PreRunFreezeV3AsV2(freeze)).toThrow(/STOP/u);
    expect(canonicalDemo1PreRunFreezeV3Bytes(freeze)).toEqual(canonicalDemo1PreRunFreezeV3Bytes(freeze));
  });

  it("partitions repositories without caller pool labels and exposes E2 only after complete evidence", () => {
    const repositories = [
      ...Array.from({ length: 3 }, () => "repo/0"),
      ...Array.from({ length: 2 }, () => "repo/1"),
      ...Array.from({ length: 5 }, (_, repo) => [`repo/${repo + 2}`, `repo/${repo + 2}`]).flat(),
      ...Array.from({ length: 6 }, (_, repo) => `repo/${repo + 7}`),
    ];
    const artifact = taskEvidence(repositories.map((repository, index) => task(index, repository)), true);
    const freeze = buildDemo1PreRunFreezeV3(v3Input(artifact));
    expect(freeze.derived.status).toBe("ready");
    expect(freeze.derived.winner?.repositoryPath).toBe("skills/brand-guidelines");
    expect(freeze.derived.winner?.selectedPools.suitability).toHaveLength(6);
    expect(freeze.derived.winner?.selectedPools.rehearsal).toHaveLength(10);
    expect(freeze.derived.winner?.selectedPools.officialFeasibility).toHaveLength(5);
    const repositoriesByPool = Object.values(freeze.derived.winner!.selectedPools)
      .map((pool) => new Set(pool.map((entry) => entry.repository)));
    expect([...repositoriesByPool[0]!].some((repository) => repositoriesByPool[1]!.has(repository))).toBe(false);
    expect([...repositoriesByPool[0]!].some((repository) => repositoriesByPool[2]!.has(repository))).toBe(false);
    expect([...repositoriesByPool[1]!].some((repository) => repositoriesByPool[2]!.has(repository))).toBe(false);
    const v2 = demo1PreRunFreezeV3AsV2(freeze);
    expect(v2.derived.status).toBe("ready");
    expect(v2.inputs.officialDesign.exactCapacity).toBeNull();

    const staticallyIneligible = buildDemo1PreRunFreezeV3(v3Input(taskEvidence(
      repositories.map((repository, index) => task(index, repository)),
      true,
      "fixture-task-20",
    )));
    expect(staticallyIneligible.derived.status).toBe("stop");
    expect(staticallyIneligible.derived.stopReasons).toEqual(["no-candidate-meets-static-domain-capacity"]);
    expect(staticallyIneligible.derived.candidates.find((entry) => entry.repositoryPath === "skills/brand-guidelines"))
      .toMatchObject({ domainCompatibleTaskCount: 21, staticCapacityPossible: false, preE2Ready: false });
  });
});
