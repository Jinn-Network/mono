// SPDX-License-Identifier: Apache-2.0

import {
  validateExecutionEvidence,
} from "@jinn-network/evidence-protocol";
import { expect, test } from "vitest";

import { transformSourceArtifacts } from "./artifact-transform.js";
import { sha256Digest } from "./bytes.js";
import type { SurfaceDispositionResult } from "./disposition.js";
import { syntheticDerivationInput } from "./fixtures.js";
import { transformSourceMetadata } from "./metadata-transform.js";
import { parseDerivationPolicy } from "./policy.js";
import { buildPublicExecutionEvidence } from "./public-graph.js";
import {
  buildScrubReceipt,
  parseScrubberImplementationDescriptor,
} from "./receipt.js";
import { validateDerivationSource } from "./source.js";
import { extractDerivationSurfaces } from "./surfaces.js";

function recursivelySorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recursivelySorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, recursivelySorted(child)]),
  );
}

test("builds a conforming derivative without substituting historical roles", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  const policy = parseDerivationPolicy(input.policyBytes);
  const extraction = extractDerivationSurfaces(source, policy.value);
  const dispositions = new Map<string, SurfaceDispositionResult>();
  for (const surface of extraction.surfaces) {
    const shouldRedact =
      surface.text === "Synthetic private execution" ||
      surface.sourceEntityId === "trace/trace.jsonl";
    dispositions.set(surface.surfaceId, {
      status: shouldRedact ? "redacted" : "retained",
      text: shouldRedact ? "[REDACTED]" : surface.text,
      counts: shouldRedact
        ? [{ class: "credential", disposition: "redact", count: 1 }]
        : [],
    });
  }
  const metadata = transformSourceMetadata(source, extraction, dispositions);
  const artifacts = transformSourceArtifacts(
    source,
    extraction,
    dispositions,
    policy.value,
  );
  expect(metadata.status).toBe("transformed");
  expect(artifacts.status).toBe("transformed");
  if (metadata.status !== "transformed" || artifacts.status !== "transformed") {
    return;
  }
  const implementation = parseScrubberImplementationDescriptor(
    input.scrubber.implementationDescriptorBytes,
  );
  const receipt = buildScrubReceipt({
    sourceRecord: input.sourceRecord.reference,
    scrubberAgentId: input.scrubber.agentId,
    implementationDigest: implementation.digest,
    policyDigest: policy.digest,
    detectorDescriptors: implementation.value.detectors,
    completedAt: input.completedAt,
    mappings: artifacts.derived.map((artifact) => ({
      sourceEntityId: artifact.sourceEntityId,
      sourceDigest: artifact.sourceDigest,
      derivedEntityId: artifact.entityId,
      derivedDigest: artifact.digest,
    })),
    artifactCounts: {
      retained: artifacts.retained.length,
      derived: artifacts.derived.length,
      withheld: artifacts.withheld.length,
    },
    dispositions: [...metadata.counts, ...artifacts.counts],
    reproducibility: "byte-stable",
    bindingImpact: artifacts.bindingImpact,
  });
  const derivative = buildPublicExecutionEvidence({
    source,
    metadata,
    artifacts,
    policy,
    implementation,
    receipt,
    scrubberAgentId: input.scrubber.agentId,
    completedAt: input.completedAt,
  });
  const report = validateExecutionEvidence(derivative.record.bytes);
  expect(report.diagnostics).toEqual([]);
  expect(report.conforms).toBe(true);
  const document = JSON.parse(new TextDecoder().decode(derivative.record.bytes));
  const execution = document["@graph"].find(
    (entity: Record<string, unknown>) =>
      entity["@id"] ===
      "urn:uuid:22222222-2222-4222-8222-222222222222",
  );
  const historicalIds = JSON.stringify({
    object: execution.object,
    result: execution.result,
    instrument: execution.instrument,
    subjectOf: execution.subjectOf,
  });
  expect(historicalIds).not.toContain("derived/");
  expect(new TextDecoder().decode(derivative.record.bytes)).not.toContain(
    "Synthetic private execution",
  );
  expect(derivative.record.reference.digest).not.toBe(source.recordDigest);
  const expectedBytes = new TextEncoder().encode(
    `${JSON.stringify(recursivelySorted(document), null, 2)}\n`,
  );
  const expectedDigest =
    "sha256:855f5d78b3ee94a685adf3262abe62c76c1240bbb733821ac10f899f6e064dc6";
  expect(sha256Digest(expectedBytes)).toBe(expectedDigest);
  expect(derivative.record.bytes).toEqual(expectedBytes);
  expect(derivative.record.reference.digest).toBe(expectedDigest);
});
