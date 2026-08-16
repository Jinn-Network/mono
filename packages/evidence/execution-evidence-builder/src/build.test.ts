// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";

import { buildExecutionEvidence } from "./build.js";
import {
  ExecutionEvidenceBuilderError,
} from "./errors.js";
import type {
  ExecutionEvidenceArtifactSource,
  ExecutionEvidenceBuilderInput,
} from "./types.js";

const ORIGIN = {
  kind: "producer-observed",
  observer: "urn:agent:evidence-builder",
} as const;

function source(
  digit: string,
  mediaType: string,
): ExecutionEvidenceArtifactSource {
  return {
    digest: `sha256:${digit.repeat(64)}`,
    size: 4,
    mediaType,
  };
}

function fixture(): ExecutionEvidenceBuilderInput {
  return {
    recording: {
      executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-16T09:00:00.000Z",
      record: {
        name: "Pure builder fixture",
        description: "Exact content descriptors with no capture side effects.",
        license: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
      task: {
        entityId: "task/task.json",
        name: "Answer the fixed subject",
        source: source("1", "application/json"),
        origin: ORIGIN,
      },
      initialInputs: [],
      executor: {
        entityId: "urn:agent:subject",
        kind: "software",
        name: "Subject executor",
        softwareVersion: "1.0.0",
        origin: ORIGIN,
      },
      runtime: {
        entityId: "runtime/runtime.json",
        specification: source("2", "application/json"),
        name: "Subject runtime",
        softwareVersion: "1.0.0",
        origin: ORIGIN,
        components: [
          {
            kind: "controlled",
            artifact: {
              kind: "file",
              entityId: "runtime/runner.mjs",
              source: source("5", "text/javascript"),
              origin: ORIGIN,
            },
          },
        ],
      },
      producer: {
        entityId: "urn:agent:evidence-builder",
        kind: "software",
        name: "Evidence builder fixture producer",
        softwareVersion: "0.1.0",
        origin: ORIGIN,
      },
    },
    additionalInputs: [],
    runtimeObservations: [],
    outcome: "completed",
    endedAt: "2026-08-16T09:00:01.250Z",
    finalizedAt: "2026-08-16T09:00:02.000Z",
    results: [
      {
        kind: "file",
        entityId: "results/answer.txt",
        source: source("3", "text/plain"),
        origin: ORIGIN,
      },
    ],
    nativeTrace: {
      artifact: {
        kind: "file",
        entityId: "trace/native.jsonl",
        source: source("4", "application/x-ndjson"),
        origin: ORIGIN,
      },
      format: {
        entityId: "https://example.test/formats/native-trace/v1",
      },
    },
  };
}

describe("buildExecutionEvidence", () => {
  test("constructs deterministic, conforming v1 bytes without I/O", () => {
    const input = fixture();
    const first = buildExecutionEvidence(input);
    const second = buildExecutionEvidence(structuredClone(input));

    expect(first).toEqual(second);
    expect(validateExecutionEvidence(first)).toMatchObject({
      conforms: true,
      diagnostics: [],
    });
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      "5336a077f48ad62da9743b5d049a3370d5658603ec532a54d543c7ab51de62e1",
    );
    expect(new TextDecoder().decode(first).endsWith("\n")).toBe(true);
  });

  test("refuses a completed execution without a Result", () => {
    expect(() =>
      buildExecutionEvidence({
        ...fixture(),
        results: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ExecutionEvidenceBuilderError>>({
        code: "PROTOCOL_CONFORMANCE_FAILED",
      }),
    );
  });
});
