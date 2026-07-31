// SPDX-License-Identifier: Apache-2.0
import { recordDigest, validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";

import { executionEvidenceFixture } from "./testing-fixture.js";

const VARIANTS = [
  { executorId: "https://agents.test/alice", executionId: "exec-1" },
  { executorId: "https://agents.test/alice", executionId: "exec-2" },
  { executorId: "https://agents.test/mallory", executionId: "exec-3" },
] as const;

describe("execution-evidence fixture variants", () => {
  test("the golden fixture validates before mutation", () => {
    const report = validateExecutionEvidence(executionEvidenceFixture.bytes);
    expect(report).toMatchObject({ conforms: true, diagnostics: [] });
  });

  test("each seeded variant validates and all three digests are distinct", () => {
    const digests = new Set<string>();
    for (const variant of VARIANTS) {
      const bytes = variantBytesFromGolden(variant);
      const report = validateExecutionEvidence(bytes);
      expect(report.conforms, JSON.stringify(report.diagnostics)).toBe(true);
      digests.add(recordDigest(bytes));
    }
    expect(digests.size).toBe(3);
  });
});

type RoCrateEntity = Record<string, unknown> & { "@id": string };
type RoCrateDocument = {
  readonly "@context": unknown;
  readonly "@graph": RoCrateEntity[];
};

const GOLDEN_EXECUTION_ID = "urn:uuid:22222222-2222-4222-8222-222222222222";
const GOLDEN_EXECUTOR_ID = "urn:uuid:33333333-3333-4333-8333-333333333333";
const EXECUTION_IRIS = {
  "exec-1": "urn:uuid:a0000001-0001-4001-8001-000000000001",
  "exec-2": "urn:uuid:a0000002-0002-4002-8002-000000000002",
  "exec-3": "urn:uuid:a0000003-0003-4003-8003-000000000003",
} as const;

function replaceEntityId(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((entry) => replaceEntityId(entry, from, to));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      next[key] = key === "@id" && entry === from ? to : replaceEntityId(entry, from, to);
    }
    return next;
  }
  return value;
}

function variantBytesFromGolden(variant: {
  readonly executorId: string;
  readonly executionId: string;
}): Uint8Array {
  const template = JSON.parse(new TextDecoder().decode(executionEvidenceFixture.bytes)) as RoCrateDocument;
  const executionIri =
    EXECUTION_IRIS[variant.executionId as keyof typeof EXECUTION_IRIS] ?? variant.executionId;
  const document = structuredClone(template) as RoCrateDocument;
  const execution = document["@graph"].find((entity) => entity["@id"] === GOLDEN_EXECUTION_ID);
  const executor = document["@graph"].find((entity) => entity["@id"] === GOLDEN_EXECUTOR_ID);
  if (execution === undefined || executor === undefined) {
    throw new Error("golden execution-evidence fixture is missing required entities");
  }
  execution["@id"] = executionIri;
  executor["@id"] = variant.executorId;
  let mutated = replaceEntityId(document, GOLDEN_EXECUTION_ID, executionIri) as RoCrateDocument;
  mutated = replaceEntityId(mutated, GOLDEN_EXECUTOR_ID, variant.executorId) as RoCrateDocument;
  return new TextEncoder().encode(`${JSON.stringify(mutated, null, 2)}\n`);
}
