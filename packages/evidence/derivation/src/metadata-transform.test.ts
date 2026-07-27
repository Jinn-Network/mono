// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import type { SurfaceDispositionResult } from "./disposition.js";
import { syntheticDerivationInput } from "./fixtures.js";
import { transformSourceMetadata } from "./metadata-transform.js";
import { parseDerivationPolicy } from "./policy.js";
import { validateDerivationSource } from "./source.js";
import { extractDerivationSurfaces } from "./surfaces.js";

test("replaces only the exact admitted metadata pointer", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  const extraction = extractDerivationSurfaces(
    source,
    parseDerivationPolicy(input.policyBytes).value,
  );
  const target = extraction.surfaces.find(
    ({ text }) => text === "Synthetic private execution",
  )!;
  const results = new Map<string, SurfaceDispositionResult>([
    [
      target.surfaceId,
      {
        status: "redacted",
        text: "[REDACTED_IDENTITY]",
        counts: [
          { class: "known-identity", disposition: "redact", count: 1 },
        ],
      },
    ],
  ]);
  for (const candidate of extraction.surfaces) {
    if (!results.has(candidate.surfaceId)) {
      results.set(candidate.surfaceId, {
        status: "retained",
        text: candidate.text,
        counts: [],
      });
    }
  }

  const transformed = transformSourceMetadata(source, extraction, results);
  expect(transformed.status).toBe("transformed");
  if (transformed.status !== "transformed") return;
  expect(transformed.changed).toBe(true);
  expect(
    transformed.graph["@graph"].find(({ "@id": id }) => id === "./")?.name,
  ).toBe("[REDACTED_IDENTITY]");
  expect(
    source.document["@graph"].find(({ "@id": id }) => id === "./")?.name,
  ).toBe("Synthetic private execution");
});

test("promotes metadata withhold-artifact to a record hold", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  const extraction = extractDerivationSurfaces(
    source,
    parseDerivationPolicy(input.policyBytes).value,
  );
  const target = extraction.surfaces.find(({ surfaceId }) =>
    surfaceId.startsWith("metadata:"),
  )!;
  expect(
    transformSourceMetadata(
      source,
      extraction,
      new Map([
        [
          target.surfaceId,
          { status: "withhold-artifact", counts: [] } as const,
        ],
      ]),
    ),
  ).toEqual({
    status: "withhold-record",
    reasons: [{ code: "metadata-withheld" }],
  });
});
