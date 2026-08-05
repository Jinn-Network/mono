// SPDX-License-Identifier: Apache-2.0

import {
  documentDigest,
  sealDelivery,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";

import { ProfilesError } from "./errors.js";
import {
  verifyEvaluationSubject,
  type EvaluationSubjectResultMaterial,
} from "./evaluation-subject.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function subjectFixture(options: {
  readonly taskOutputs?: readonly {
    readonly name: string;
    readonly mediaType: string;
    readonly required: boolean;
  }[];
  readonly deliveryTask?: `sha256:${string}`;
  readonly deliveryOutputs?: readonly {
    readonly name: string;
    readonly mediaType?: string;
    readonly digest?: Readonly<Record<string, string>>;
  }[];
  readonly results?: readonly EvaluationSubjectResultMaterial[];
} = {}) {
  const resultBytes = encoder.encode("diff --git a/a b/a\n");
  const taskBytes = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "1".repeat(64) },
    },
    instructions: "Return the requested patch.",
    outputs: options.taskOutputs ?? [{
      name: "result.patch",
      mediaType: "text/x-diff",
      required: true,
    }],
    evaluation: {
      name: "evaluation-spec.json",
      uri: "https://spec.jinn.network/evaluation-specs/control-v1",
      mediaType: "application/vnd.jinn.task-execution.evaluation-spec.v1+json",
      digest: { sha256: "2".repeat(64) },
    },
  });
  const deliveryBytes = sealDelivery({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    attempt: "urn:uuid:33333333-3333-4333-8333-333333333333",
    task: options.deliveryTask ?? documentDigest(taskBytes),
    outputs: options.deliveryOutputs ?? [{
      name: "result.patch",
      mediaType: "text/x-diff",
      digest: {
        sha256: documentDigest(resultBytes).slice("sha256:".length),
      },
    }],
    outcome: "fulfilled",
    createdAt: "2026-07-29T12:00:00.000Z",
  });
  return {
    taskBytes,
    deliveryBytes,
    resultBytes,
    results: options.results ?? [{ name: "result.patch", bytes: resultBytes }],
  };
}

function expectInvalid(operation: () => unknown): void {
  try {
    operation();
  } catch (cause) {
    expect(cause).toBeInstanceOf(ProfilesError);
    expect((cause as ProfilesError).code).toBe("invalid-document");
    return;
  }
  throw new Error("expected evaluation subject verification to fail");
}

describe("verifyEvaluationSubject (program §7.56)", () => {
  test("returns only the exact evaluation-facing Task, Delivery, Results, and spec reference", () => {
    const fixture = subjectFixture();

    expect(verifyEvaluationSubject({
      taskBytes: fixture.taskBytes,
      deliveryBytes: fixture.deliveryBytes,
      results: fixture.results,
    })).toEqual({
      task: {
        bytes: fixture.taskBytes,
        digest: documentDigest(fixture.taskBytes),
      },
      delivery: {
        bytes: fixture.deliveryBytes,
        digest: documentDigest(fixture.deliveryBytes),
      },
      results: [{
        name: "result.patch",
        mediaType: "text/x-diff",
        bytes: fixture.resultBytes,
        digest: documentDigest(fixture.resultBytes),
      }],
      evaluationSpecification: {
        name: "evaluation-spec.json",
        uri: "https://spec.jinn.network/evaluation-specs/control-v1",
        mediaType:
          "application/vnd.jinn.task-execution.evaluation-spec.v1+json",
        digest: `sha256:${"2".repeat(64)}`,
      },
    });
  });

  test("rejects hostile or noncanonical exact Task and Delivery bytes", () => {
    const fixture = subjectFixture();
    const noncanonicalTask = encoder.encode(
      `${decoder.decode(fixture.taskBytes)}\n`,
    );
    const noncanonicalDelivery = encoder.encode(
      ` ${decoder.decode(fixture.deliveryBytes)}`,
    );
    const invalidUtf8Task = new Uint8Array([
      ...fixture.taskBytes.slice(0, fixture.taskBytes.length - 1),
      0xff,
    ]);

    expectInvalid(() => verifyEvaluationSubject({
      taskBytes: noncanonicalTask,
      deliveryBytes: fixture.deliveryBytes,
      results: fixture.results,
    }));
    expectInvalid(() => verifyEvaluationSubject({
      taskBytes: fixture.taskBytes,
      deliveryBytes: noncanonicalDelivery,
      results: fixture.results,
    }));
    expectInvalid(() => verifyEvaluationSubject({
      taskBytes: invalidUtf8Task,
      deliveryBytes: fixture.deliveryBytes,
      results: fixture.results,
    }));
  });

  test("rejects a Delivery joined to a different exact Task", () => {
    const fixture = subjectFixture({
      deliveryTask: `sha256:${"f".repeat(64)}`,
    });

    expectInvalid(() => verifyEvaluationSubject({
      taskBytes: fixture.taskBytes,
      deliveryBytes: fixture.deliveryBytes,
      results: fixture.results,
    }));
  });

  test("rejects duplicate Task, Delivery, or supplied Result output names", () => {
    const duplicateTask = subjectFixture({
      taskOutputs: [
        { name: "result.patch", mediaType: "text/x-diff", required: true },
        { name: "result.patch", mediaType: "text/x-diff", required: false },
      ],
    });
    const ordinary = subjectFixture();
    const digest = {
      sha256: documentDigest(ordinary.resultBytes).slice("sha256:".length),
    };
    const duplicateDelivery = subjectFixture({
      deliveryOutputs: [
        { name: "result.patch", mediaType: "text/x-diff", digest },
        { name: "result.patch", mediaType: "text/x-diff", digest },
      ],
      results: [
        { name: "result.patch", bytes: ordinary.resultBytes },
        { name: "other.patch", bytes: ordinary.resultBytes },
      ],
    });
    const duplicateResults = subjectFixture({
      results: [
        { name: "result.patch", bytes: ordinary.resultBytes },
        { name: "result.patch", bytes: ordinary.resultBytes },
      ],
    });

    for (const fixture of [
      duplicateTask,
      duplicateDelivery,
      duplicateResults,
    ]) {
      expectInvalid(() => verifyEvaluationSubject({
        taskBytes: fixture.taskBytes,
        deliveryBytes: fixture.deliveryBytes,
        results: fixture.results,
      }));
    }
  });

  test("rejects undeclared outputs, media-type drift, and missing Delivery digests", () => {
    const ordinary = subjectFixture();
    const digest = {
      sha256: documentDigest(ordinary.resultBytes).slice("sha256:".length),
    };
    const fixtures = [
      subjectFixture({
        deliveryOutputs: [{
          name: "undeclared.patch",
          mediaType: "text/x-diff",
          digest,
        }],
        results: [{
          name: "undeclared.patch",
          bytes: ordinary.resultBytes,
        }],
      }),
      subjectFixture({
        deliveryOutputs: [{
          name: "result.patch",
          mediaType: "application/octet-stream",
          digest,
        }],
      }),
      subjectFixture({
        deliveryOutputs: [{
          name: "result.patch",
          mediaType: "text/x-diff",
          digest: { sha512: "3".repeat(128) },
        }],
      }),
    ];

    for (const fixture of fixtures) {
      expectInvalid(() => verifyEvaluationSubject({
        taskBytes: fixture.taskBytes,
        deliveryBytes: fixture.deliveryBytes,
        results: fixture.results,
      }));
    }
  });

  test("rejects supplied Result cardinality, identity, and digest mismatches", () => {
    const ordinary = subjectFixture();
    const fixtures = [
      { ...ordinary, results: [] },
      {
        ...ordinary,
        results: [{
          name: "other.patch",
          bytes: ordinary.resultBytes,
        }],
      },
      {
        ...ordinary,
        results: [{
          name: "result.patch",
          bytes: encoder.encode("different bytes"),
        }],
      },
    ];

    for (const fixture of fixtures) {
      expectInvalid(() => verifyEvaluationSubject({
        taskBytes: fixture.taskBytes,
        deliveryBytes: fixture.deliveryBytes,
        results: fixture.results,
      }));
    }
  });
});
