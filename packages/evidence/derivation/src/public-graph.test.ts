// SPDX-License-Identifier: Apache-2.0

import {
  validateExecutionEvidence,
} from "@jinn-network/evidence-protocol";
import { expect, test } from "vitest";

import { transformSourceArtifacts } from "./artifact-transform.js";
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

test("builds a conforming derivative without substituting historical roles", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  const policy = parseDerivationPolicy(input.policyBytes);
  const extraction = extractDerivationSurfaces(source, policy.value);
  const dispositions = new Map<string, SurfaceDispositionResult>();
  for (const surface of extraction.surfaces) {
    const shouldRedact =
      surface.text === "Synthetic private execution" ||
      surface.sourceEntityId === "trace/trajectory.jsonl";
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
});
