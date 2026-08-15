import { describe, expect, test } from "vitest";

import { collectDeclaredArtifacts } from "./declared-artifacts.js";
import { validatedFixture } from "./test-support.js";

describe("collectDeclaredArtifacts", () => {
  test("extracts execution artifact identities and relationship roles", async () => {
    const record = await validatedFixture("execution-evidence");
    const artifacts = collectDeclaredArtifacts(record);
    expect(artifacts).toContainEqual({
      entityId: "task/task.md",
      reference: {
        digest:
          "sha256:1f42fd35cecf09d1bdf953fe4c7a1c8d25fd0bcf415a6b39aa7b61f1e982ef93",
      },
      roles: expect.arrayContaining(["object"]),
    });
    expect(artifacts).toContainEqual(
      expect.objectContaining({
        entityId: "trace/trace.jsonl",
        roles: expect.arrayContaining(["subjectOf"]),
      }),
    );
  });

  test("extracts attestation subjects and supporting evidence", async () => {
    const evaluation = await validatedFixture("result-evaluation");
    const verification = await validatedFixture("execution-verification");
    const evaluationArtifacts = collectDeclaredArtifacts(evaluation);
    const verificationArtifacts = collectDeclaredArtifacts(verification);
    expect(evaluationArtifacts.some((artifact) =>
      artifact.roles.includes("subject"),
    ))
      .toBe(true);
    expect(evaluationArtifacts.some((artifact) =>
      artifact.roles.includes("supporting-evidence"),
    )).toBe(true);
    expect(verificationArtifacts.some((artifact) =>
      artifact.roles.includes("supporting-evidence"),
    )).toBe(true);
  });

  test("merges duplicate entity/digest declarations across multiple checks", async () => {
    const verification = await validatedFixture("execution-verification");
    const artifacts = collectDeclaredArtifacts(verification);
    const trace = artifacts.filter(
      (artifact) => artifact.entityId === "execution/trace/trace.jsonl",
    );
    expect(trace).toHaveLength(1);
    expect(trace[0]?.roles).toEqual(["supporting-evidence"]);
  });

  test("sorts the result deterministically by entity id then digest", async () => {
    const record = await validatedFixture("execution-evidence");
    const artifacts = collectDeclaredArtifacts(record);
    const entityIds = artifacts.map((artifact) => artifact.entityId);
    expect(entityIds).toEqual([...entityIds].sort());
  });
});
