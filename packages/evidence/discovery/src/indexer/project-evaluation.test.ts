// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";

import {
  DSSE_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";

import { projectResultEvaluation } from "./project-evaluation.js";

const fixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

function envelopeBytes(statement: unknown): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      signatures: [{ sig: Buffer.alloc(64, 1).toString("base64") }],
    }),
  );
}

describe("Result Evaluation projection", () => {
  test("projects the exact golden subjects, actor, verdict, and time", async () => {
    const bytes = await readFile(
      new URL(
        "claims/result-evaluation/result-evaluation.dsse.json",
        fixtureRoot,
      ),
    );
    const report = validateResultEvaluation(bytes);
    expect(report.conforms).toBe(true);
    const projection = projectResultEvaluation(
      { family: "result-evaluation", digest: report.recordDigest },
      bytes.byteLength,
      report.value!,
    );

    expect(projection).toMatchObject({
      family: "result-evaluation",
      reference: {
        family: "result-evaluation",
        digest: report.recordDigest,
      },
      byteSize: bytes.byteLength,
      taskSubject: {
        name: "execution/task/task.md",
        digest:
          "sha256:1f42fd35cecf09d1bdf953fe4c7a1c8d25fd0bcf415a6b39aa7b61f1e982ef93",
      },
      resultSubjects: [
        {
          name: "execution/results/slug-normalization.patch",
          digest:
            "sha256:c43b406505b8c53ff9bf0a1c57442080d99a14b9f278739cb426313cf3238b07",
        },
      ],
      evaluatorId: "urn:uuid:55555555-5555-4555-8555-555555555555",
      verdict: "pass",
      evaluatedAt: "2026-07-23T16:00:00Z",
      supersedes: [],
      disputes: [],
    });
    expect(projection).not.toHaveProperty("measurements");
    expect(projection).not.toHaveProperty("evidence");
    expect(projection).not.toHaveProperty("explanation");
  });

  test("projects a minimal predicate without inventing optional fields", () => {
    const statement = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [
        {
          name: "task.md",
          digest: { sha256: "a".repeat(64) },
          uri: "https://example.invalid/task",
          mediaType: "text/markdown",
          content: "must-not-project",
          "x-extension": "must-not-project",
        },
        { name: "result.patch", digest: { sha256: "b".repeat(64) } },
      ],
      predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
      predicate: {
        evaluatedAt: "2026-07-23T16:00:00Z",
        evaluator: { id: "urn:uuid:55555555-5555-4555-8555-555555555555" },
        taskSubject: "task.md",
        resultSubjects: ["result.patch"],
        verdict: "inconclusive",
      },
    };
    const bytes = envelopeBytes(statement);
    const report = validateResultEvaluation(bytes);
    expect(report.conforms).toBe(true);
    const projection = projectResultEvaluation(
      { family: "result-evaluation", digest: report.recordDigest },
      bytes.byteLength,
      report.value!,
    );

    expect(projection.taskSubject).toEqual({
      name: "task.md",
      digest: `sha256:${"a".repeat(64)}`,
      uri: "https://example.invalid/task",
      mediaType: "text/markdown",
    });
    expect(projection.supersedes).toEqual([]);
    expect(projection.disputes).toEqual([]);
    expect(projection.declaredEntities).toContainEqual({
      entityId: "https://example.invalid/task",
      types: [],
    });
    expect(JSON.stringify(projection)).not.toContain("must-not-project");
  });

  test("projects exact correction and dispute descriptors", () => {
    const statement = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [
        { name: "task.md", digest: { sha256: "a".repeat(64) } },
        { name: "result.patch", digest: { sha256: "b".repeat(64) } },
      ],
      predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
      predicate: {
        evaluatedAt: "2026-07-23T16:00:00Z",
        evaluator: { id: "urn:uuid:55555555-5555-4555-8555-555555555555" },
        taskSubject: "task.md",
        resultSubjects: ["result.patch"],
        verdict: "fail",
        supersedes: [
          {
            name: "prior.dsse.json",
            digest: { sha256: "c".repeat(64) },
            uri: "https://example.invalid/prior",
          },
        ],
        disputes: [
          {
            name: "disputed.dsse.json",
            digest: { sha256: "d".repeat(64) },
          },
        ],
      },
    };
    const bytes = envelopeBytes(statement);
    const report = validateResultEvaluation(bytes);
    expect(report.conforms).toBe(true);
    const projection = projectResultEvaluation(
      { family: "result-evaluation", digest: report.recordDigest },
      bytes.byteLength,
      report.value!,
    );
    expect(projection.supersedes).toEqual([
      {
        name: "prior.dsse.json",
        digest: `sha256:${"c".repeat(64)}`,
        uri: "https://example.invalid/prior",
      },
    ]);
    expect(projection.disputes).toEqual([
      {
        name: "disputed.dsse.json",
        digest: `sha256:${"d".repeat(64)}`,
      },
    ]);
  });
});
