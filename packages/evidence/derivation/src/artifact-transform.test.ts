import { expect, test } from "vitest";

import type { SurfaceDispositionResult } from "./disposition.js";
import { syntheticDerivationInput } from "./fixtures.js";
import { transformSourceArtifacts } from "./artifact-transform.js";
import { parseDerivationPolicy } from "./policy.js";
import { validateDerivationSource } from "./source.js";
import { extractDerivationSurfaces } from "./surfaces.js";

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
