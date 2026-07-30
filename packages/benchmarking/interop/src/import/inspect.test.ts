import { checkJudgeability } from "@jinn-network/benchmarking-records";
import {
  buildRepositoryWorkProfile,
  REPOSITORY_WORK_PROFILE_URI,
  sealTaskProfile,
} from "@jinn-network/task-execution-profiles";
import { describe, expect, test } from "vitest";
import { importInspectEvals } from "./inspect.js";

function repositoryWorkPin() {
  const sealed = sealTaskProfile(buildRepositoryWorkProfile());
  return {
    profile: {
      uri: REPOSITORY_WORK_PROFILE_URI,
      digest: sealed.digest,
    },
    outputs: buildRepositoryWorkProfile().outputConventions.slots.map((slot) => ({
      name: slot.name,
      mediaType: slot.mediaType ?? "application/octet-stream",
      required: slot.required,
    })),
  };
}

describe("importInspectEvals (§10.2 seam 1)", () => {
  test("rejects missing or invalid profile pins (no repository-work default)", () => {
    expect(() => importInspectEvals([{
      id: "mmlu",
      version: "1.2.0",
      instructions: "Answer the multiple-choice question.",
      dataExpressible: true,
      datasetDigest: `sha256:${"1".repeat(64)}`,
      scorerDigest: `sha256:${"2".repeat(64)}`,
    }], {
      name: "missing profile",
      description: "fixture",
      version: "1.0.0",
    } as never)).toThrow(/profile/i);

    expect(() => importInspectEvals([{
      id: "mmlu",
      version: "1.2.0",
      instructions: "Answer the multiple-choice question.",
      dataExpressible: true,
      datasetDigest: `sha256:${"1".repeat(64)}`,
      scorerDigest: `sha256:${"2".repeat(64)}`,
    }], {
      name: "bad profile",
      description: "fixture",
      version: "1.0.0",
      profile: { uri: "https://example.org/not-a-pin", digest: "sha256:not-a-digest" as `sha256:${string}` },
      outputs: [],
    })).toThrow(/profile/i);
  });

  test("seals the caller-supplied profile descriptor unchanged", () => {
    const pin = repositoryWorkPin();
    const imported = importInspectEvals([{
      id: "mmlu",
      version: "1.2.0",
      instructions: "Answer the multiple-choice question.",
      dataExpressible: true,
      datasetDigest: `sha256:${"1".repeat(64)}`,
      scorerDigest: `sha256:${"2".repeat(64)}`,
      provenanceTimestamp: "2026-07-29T00:00:00Z",
    }], {
      name: "inspect data-expressible",
      description: "fixture",
      version: "1.0.0",
      ...pin,
    });
    const doc = JSON.parse(new TextDecoder().decode(imported.tasks[0]!.bytes)) as {
      profile: { uri: string; digest: { sha256: string } };
    };
    expect(doc.profile.uri).toBe(pin.profile.uri);
    expect(`sha256:${doc.profile.digest.sha256}`).toBe(pin.profile.digest);
  });

  test("data-expressible tasks seal dataset/scorer and pass checkJudgeability", () => {
    const pin = repositoryWorkPin();
    const first = importInspectEvals([{
      id: "mmlu",
      version: "1.2.0",
      instructions: "Answer the multiple-choice question.",
      dataExpressible: true,
      datasetDigest: `sha256:${"1".repeat(64)}`,
      scorerDigest: `sha256:${"2".repeat(64)}`,
      provenanceTimestamp: "2026-07-29T00:00:00Z",
    }], {
      name: "inspect data-expressible",
      description: "fixture",
      version: "1.0.0",
      ...pin,
    });
    const second = importInspectEvals([{
      id: "mmlu",
      version: "1.2.0",
      instructions: "Answer the multiple-choice question.",
      dataExpressible: true,
      datasetDigest: `sha256:${"1".repeat(64)}`,
      scorerDigest: `sha256:${"2".repeat(64)}`,
      provenanceTimestamp: "2026-07-29T00:00:00Z",
    }], {
      name: "inspect data-expressible",
      description: "fixture",
      version: "1.0.0",
      ...pin,
    });
    expect(first.tasks[0]!.digest).toBe(second.tasks[0]!.digest);
    expect(checkJudgeability(
      first.benchmark.record,
      (digest) => first.tasks.find((task) => task.digest === `sha256:${digest}` || task.digest.endsWith(digest))?.bytes,
    )).toEqual({ ok: true });
  });

  test("non-data-expressible tasks pin Inspect task/version/digest as an input (no attested-only authority)", () => {
    const pin = repositoryWorkPin();
    const imported = importInspectEvals([{
      id: "custom-python-scorer",
      version: "0.3.1",
      instructions: "Run the Inspect task with an arbitrary Python scorer.",
      dataExpressible: false,
      provenanceTimestamp: "2026-07-29T00:00:00Z",
    }], {
      name: "inspect non-data pin",
      description: "fixture",
      version: "1.0.0",
      ...pin,
    });
    const doc = JSON.parse(new TextDecoder().decode(imported.tasks[0]!.bytes)) as {
      inputs?: { name: string; digest?: { sha256?: string } }[];
      payload?: { inspect?: { integrityTier?: string } };
    };
    expect(doc.inputs?.some((input) => input.name === "inspect-task-pin")).toBe(true);
    expect(doc.payload?.inspect?.integrityTier).toBeUndefined();
    expect("integrityTiers" in imported).toBe(false);
    expect(checkJudgeability(
      imported.benchmark.record,
      (digest) => imported.tasks.find((task) => task.digest.endsWith(digest))?.bytes,
    )).toEqual({ ok: true });
  });
});
