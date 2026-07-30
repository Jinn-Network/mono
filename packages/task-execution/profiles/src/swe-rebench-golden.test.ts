import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TASK_EXECUTION_PROTOCOL_URI } from "@jinn-network/task-execution-protocol";
import { sealDocument } from "./bytes.js";
import { sealEvaluationSpec } from "./evaluation-spec/seal.js";
import { buildRepositoryWorkProfile } from "./documents/repository-work-1.0.js";
import { sealTaskProfile } from "./task-profile/seal.js";
import { REPOSITORY_WORK_PROFILE_URI } from "./identifiers.js";
import { sweRebenchRowToTaskAndSpec, type SweRebenchRow } from "./documents/swe-rebench.js";

const fixture = (relativePath: string) =>
  readFile(new URL(`../fixtures/swe-rebench-golden/${relativePath}`, import.meta.url), "utf8");

function stripSha256Prefix(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

describe("swe-rebench-v2.v1 row → repository-work Task + EvaluationSpec pair (design §10.3/§13)", () => {
  it("maps the hardest deterministic golden row to pinned Task + EvaluationSpec digests", async () => {
    const row = JSON.parse(await fixture("golden/row.json")) as SweRebenchRow;
    const expected = JSON.parse(await fixture("golden/expected.json")) as {
      evaluationSpecDigest: string;
      taskDigest: string;
    };

    const mapped = sweRebenchRowToTaskAndSpec(row);

    // The spec is sealed strictly before the Task references it (design §7): the digest the
    // mapper returns is exactly what re-sealing the returned EvaluationSpec produces, and the
    // Task built below only ever references that already-computed digest.
    expect(sealEvaluationSpec(mapped.evaluationSpec).digest).toBe(mapped.evaluationSpecDigest);
    expect(mapped.evaluationSpecDigest).toBe(expected.evaluationSpecDigest);

    // Access classes (design §10.3): swe-rebench rows are public upstream, so their test material
    // stays public.
    const block = mapped.evaluationSpec.familyBlock as { testMaterial: { accessClass?: string }[] };
    for (const material of block.testMaterial) {
      expect(material.accessClass).toBe("public");
    }

    const repositoryWorkProfileDigest = sealTaskProfile(buildRepositoryWorkProfile()).digest;
    const task = {
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: {
        uri: REPOSITORY_WORK_PROFILE_URI,
        digest: { sha256: stripSha256Prefix(repositoryWorkProfileDigest) },
      },
      instructions: row.problem_statement,
      payload: mapped.taskPayload,
      inputs: mapped.taskInputs,
      outputs: buildRepositoryWorkProfile().outputConventions.slots.map((slot) => ({
        name: slot.name,
        mediaType: slot.mediaType,
        required: slot.required,
      })),
      evaluation: { digest: { sha256: stripSha256Prefix(mapped.evaluationSpecDigest) } },
    };

    const sealedTask = sealDocument(task);
    expect(sealedTask.digest).toBe(expected.taskDigest);
  });
});
