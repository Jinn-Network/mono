// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { sha256Digest } from "./bytes.js";
import {
  normalizeDetectorFindings,
} from "./detectors/index.js";
import { applyDerivationDispositions } from "./disposition.js";
import type { SurfaceDispositionResult } from "./disposition.js";
import { syntheticDerivationInput } from "./fixtures.js";
import { transformSourceArtifacts } from "./artifact-transform.js";
import { parseDerivationPolicy } from "./policy.js";
import { validateDerivationSource } from "./source.js";
import { extractDerivationSurfaces } from "./surfaces.js";
import type {
  DeriveExecutionEvidenceInput,
  DerivationFinding,
  DerivationPolicy,
  DerivationSurface,
} from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const detector = {
  id: "synthetic-astral-detector",
  version: "1",
  implementationDigest: `sha256:${"a".repeat(64)}` as const,
  reproducibility: "byte-stable" as const,
};

function replaceArtifact(
  input: DeriveExecutionEvidenceInput,
  entityId: string,
  text: string,
): void {
  const artifact = input.sourceArtifacts.find(
    (candidate) => candidate.entityId === entityId,
  )!;
  const bytes = encoder.encode(text);
  (artifact as { bytes: Uint8Array }).bytes = bytes;
  const document = JSON.parse(decoder.decode(input.sourceRecord.bytes));
  document["@graph"].find(
    (candidate: Record<string, unknown>) => candidate["@id"] === entityId,
  ).sha256 = sha256Digest(bytes).slice("sha256:".length);
  (input.sourceRecord as { bytes: Uint8Array }).bytes = encoder.encode(
    `${JSON.stringify(document, null, 2)}\n`,
  );
  (input.sourceRecord.reference as { digest: `sha256:${string}` }).digest =
    sha256Digest(input.sourceRecord.bytes);
}

function redactAstralSurface(
  surface: DerivationSurface,
  policy: DerivationPolicy,
  start: number,
  end: number,
): SurfaceDispositionResult {
  const finding: DerivationFinding = {
    class: "email",
    confidence: "HIGH",
    surfaceId: surface.surfaceId,
    start,
    end,
    evidence: ["synthetic-astral-span"],
    detector,
  };
  return applyDerivationDispositions(
    surface,
    normalizeDetectorFindings(surface, [finding], detector),
    policy,
  );
}

function transformedArtifactText(
  input: DeriveExecutionEvidenceInput,
  entityId: string,
  surfaceText: string,
  start: number,
  end: number,
): {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly sourceBytes: Uint8Array;
} {
  const source = validateDerivationSource(input);
  const policy = parseDerivationPolicy(input.policyBytes).value;
  const extraction = extractDerivationSurfaces(source, policy);
  const surface = extraction.surfaces.find(
    (candidate) =>
      candidate.sourceEntityId === entityId &&
      candidate.text === surfaceText,
  )!;
  const sourceBytes = input.sourceArtifacts.find(
    (candidate) => candidate.entityId === entityId,
  )!.bytes.slice();
  const transformed = transformSourceArtifacts(
    source,
    extraction,
    new Map([
      [surface.surfaceId, redactAstralSurface(surface, policy, start, end)],
    ]),
    policy,
  );
  expect(transformed.status).toBe("transformed");
  if (transformed.status !== "transformed") {
    throw new Error("expected transformed artifact set");
  }
  const artifact = transformed.derived.find(
    (candidate) => candidate.sourceEntityId === entityId,
  )!;
  return {
    bytes: artifact.bytes,
    text: decoder.decode(artifact.bytes),
    sourceBytes,
  };
}

test("gives changed bytes a deterministic derived identity without role substitution", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  const policy = parseDerivationPolicy(input.policyBytes).value;
  const extraction = extractDerivationSurfaces(source, policy);
  const task = extraction.surfaces.find(
    ({ sourceEntityId }) => sourceEntityId === "task/task.md",
  )!;
  const dispositions = new Map<string, SurfaceDispositionResult>();
  for (const candidate of extraction.surfaces) {
    dispositions.set(candidate.surfaceId, {
      status: candidate.surfaceId === task.surfaceId ? "redacted" : "retained",
      text:
        candidate.surfaceId === task.surfaceId
          ? "[REDACTED_TASK]"
          : candidate.text,
      counts:
        candidate.surfaceId === task.surfaceId
          ? [{ class: "credential", disposition: "redact", count: 1 }]
          : [],
    });
  }
  const transformed = transformSourceArtifacts(
    source,
    extraction,
    dispositions,
    policy,
  );
  expect(transformed.status).toBe("transformed");
  if (transformed.status !== "transformed") return;
  expect(transformed.bindingImpact.taskDerived).toBe(true);
  expect(transformed.bindingImpact.resultEvaluation).toBe(
    "not-transferable-to-derived-subject",
  );
  expect(transformed.derived[0]?.entityId).toMatch(
    /^derived\/[a-f0-9]{64}\/[a-f0-9]{64}$/,
  );
  expect(transformed.derived[0]?.sourceEntityId).toBe("task/task.md");
});

test("withholds a transformed Result when policy requires it", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  const policy = structuredClone(parseDerivationPolicy(input.policyBytes).value);
  (policy as { resultTransform: "withhold-record" }).resultTransform =
    "withhold-record";
  const extraction = extractDerivationSurfaces(source, policy);
  const result = extraction.surfaces.find(
    ({ sourceEntityId }) => sourceEntityId === "results/result.patch",
  )!;
  expect(
    transformSourceArtifacts(
      source,
      extraction,
      new Map([
        [
          result.surfaceId,
          { status: "redacted", text: "changed", counts: [] } as const,
        ],
      ]),
      policy,
    ),
  ).toEqual({
    status: "withhold-record",
    reasons: [{ code: "result-transform-withheld" }],
  });
});

test("an explicit surface hold omits only that artifact even when the unsupported-codec default withholds the record", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  const policy = structuredClone(parseDerivationPolicy(input.policyBytes).value);
  (
    policy as {
      defaultArtifactDisposition: "withhold-artifact" | "withhold-record";
    }
  ).defaultArtifactDisposition = "withhold-record";
  const extraction = extractDerivationSurfaces(source, policy);
  const task = extraction.surfaces.find(
    ({ sourceEntityId }) => sourceEntityId === "task/task.md",
  )!;
  const transformed = transformSourceArtifacts(
    source,
    extraction,
    new Map([
      [
        task.surfaceId,
        {
          status: "withhold-artifact",
          counts: [
            {
              class: "credential",
              disposition: "withhold-artifact",
              count: 1,
            },
          ],
        } as const,
      ],
    ]),
    policy,
  );
  expect(transformed.status).toBe("transformed");
  if (transformed.status !== "transformed") return;
  expect(transformed.withheld).toEqual([
    {
      entityId: "task/task.md",
      digest: `sha256:${String(source.entities.get("task/task.md")?.sha256)}`,
      reason: "policy-withheld",
    },
  ]);
  expect(
    transformed.retained.some(
      ({ entityId }) => entityId === "inputs/base-tree.txt",
    ),
  ).toBe(true);
});

test("retains signed and binary artifacts only through exact policy rules", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  const policy = parseDerivationPolicy(input.policyBytes).value;
  const extraction = extractDerivationSurfaces(source, policy);
  const transformed = transformSourceArtifacts(
    source,
    extraction,
    new Map(),
    policy,
  );
  expect(transformed.status).toBe("transformed");
  if (transformed.status !== "transformed") return;
  expect(
    transformed.retained.find(({ entityId }) => entityId === "task/task.md")
      ?.bytes,
  ).toEqual(
    input.sourceArtifacts.find(({ entityId }) => entityId === "task/task.md")
      ?.bytes,
  );
});

test.each([
  {
    name: "after an astral character",
    source: "😀 ada@example.invalid tail",
    start: 3,
    end: 22,
    expected: "😀 [REDACTED_EMAIL] tail",
  },
  {
    name: "around an astral character",
    source: "A😀B",
    start: 1,
    end: 3,
    expected: "A[REDACTED_EMAIL]B",
  },
])(
  "transforms exact UTF-16 text spans $name without splitting astral characters",
  ({ source, start, end, expected }) => {
    const input = syntheticDerivationInput();
    replaceArtifact(input, "task/task.md", source);
    const result = transformedArtifactText(
      input,
      "task/task.md",
      source,
      start,
      end,
    );
    expect(result.bytes).toEqual(encoder.encode(expected));
    expect(result.text).toBe(expected);
    expect(
      input.sourceArtifacts.find(
        ({ entityId }) => entityId === "task/task.md",
      )!.bytes,
    ).toEqual(result.sourceBytes);
  },
);

test("preserves JSON structure and neighboring astral characters around an exact UTF-16 span", () => {
  const input = syntheticDerivationInput();
  const source =
    '{"before":"😀","target":"😀 ada@example.invalid tail","after":"🧪"}';
  replaceArtifact(input, "runtime/runtime-specification.json", source);
  const result = transformedArtifactText(
    input,
    "runtime/runtime-specification.json",
    "😀 ada@example.invalid tail",
    3,
    22,
  );
  const expected =
    '{"after":"🧪","before":"😀","target":"😀 [REDACTED_EMAIL] tail"}';
  expect(result.bytes).toEqual(encoder.encode(expected));
  expect(result.text).toBe(expected);
  expect(
    input.sourceArtifacts.find(
      ({ entityId }) => entityId === "runtime/runtime-specification.json",
    )!.bytes,
  ).toEqual(result.sourceBytes);
});

test("transforms an exact UTF-16 JSONL span on only its intended line", () => {
  const input = syntheticDerivationInput();
  const source = [
    '{"line":"keep 😀","target":"😀 ada@example.invalid tail"}',
    '{"line":"stay 🧪"}',
    "",
  ].join("\n");
  replaceArtifact(input, "trace/trace.jsonl", source);
  const result = transformedArtifactText(
    input,
    "trace/trace.jsonl",
    "😀 ada@example.invalid tail",
    3,
    22,
  );
  const expected = [
    '{"line":"keep 😀","target":"😀 [REDACTED_EMAIL] tail"}',
    '{"line":"stay 🧪"}',
    "",
  ].join("\n");
  expect(result.bytes).toEqual(encoder.encode(expected));
  expect(result.text).toBe(expected);
  expect(
    input.sourceArtifacts.find(
      ({ entityId }) => entityId === "trace/trace.jsonl",
    )!.bytes,
  ).toEqual(result.sourceBytes);
});
