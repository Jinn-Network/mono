import type { DerivationDetectorDescriptor } from "./types.js";

import { transformSourceArtifacts } from "./artifact-transform.js";
import { copyBytes } from "./bytes.js";
import {
  normalizeDetectorFindings,
  snapshotDetectors,
} from "./detectors/index.js";
import {
  applyDerivationDispositions,
  type SurfaceDispositionResult,
} from "./disposition.js";
import { EvidenceDerivationError } from "./errors.js";
import { transformSourceMetadata } from "./metadata-transform.js";
import { parseDerivationPolicy } from "./policy.js";
import { buildPublicExecutionEvidence } from "./public-graph.js";
import {
  buildScrubReceipt,
  parseScrubberImplementationDescriptor,
} from "./receipt.js";
import { validateDerivationSource } from "./source.js";
import { extractDerivationSurfaces } from "./surfaces.js";
import type {
  CreateEvidenceDeriverOptions,
  DerivationFinding,
  DerivationOperationOptions,
  DeriveExecutionEvidenceInput,
  EvidenceDerivationOutcome,
  EvidenceDeriver,
  PublishableArtifact,
} from "./types.js";

function descriptorKey(value: DerivationDetectorDescriptor): string {
  return JSON.stringify({
    id: value.id,
    version: value.version,
    implementationDigest: value.implementationDigest,
    reproducibility: value.reproducibility,
    ...(value.configurationDigest
      ? { configurationDigest: value.configurationDigest }
      : {}),
  });
}

function abortIfNeeded(options?: DerivationOperationOptions): void {
  if (options?.signal?.aborted) {
    throw new EvidenceDerivationError(
      "OPERATION_ABORTED",
      "Derivation was aborted.",
    );
  }
}

function strictTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}

function absoluteIri(value: string): boolean {
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function unchangedArtifacts(
  source: ReturnType<typeof validateDerivationSource>,
): readonly PublishableArtifact[] {
  return Object.freeze(
    [...source.artifacts]
      .map(([entityId, bytes]) => {
        const digest = `sha256:${String(
          source.entities.get(entityId)?.sha256,
        )}` as const;
        return {
          entityId,
          digest,
          bytes: copyBytes(bytes),
          kind: "retained" as const,
        };
      })
      .sort((left, right) => left.entityId.localeCompare(right.entityId)),
  );
}

export function createEvidenceDeriver(
  options: CreateEvidenceDeriverOptions,
): EvidenceDeriver {
  if (!options || !Array.isArray(options.detectors)) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Deriver construction requires an explicit detector array.",
    );
  }
  const detectors = snapshotDetectors(options.detectors);
  return Object.freeze({
    async derive(
      input: DeriveExecutionEvidenceInput,
      operationOptions?: DerivationOperationOptions,
    ): Promise<EvidenceDerivationOutcome> {
      abortIfNeeded(operationOptions);
      const source = validateDerivationSource(input);
      const policy = parseDerivationPolicy(copyBytes(input.policyBytes));
      const implementation = parseScrubberImplementationDescriptor(
        copyBytes(input.scrubber.implementationDescriptorBytes),
      );
      if (
        !absoluteIri(input.scrubber.agentId) ||
        !strictTimestamp(input.completedAt)
      ) {
        throw new EvidenceDerivationError(
          "INVALID_DERIVATION_INPUT",
          "Scrubber Agent and completedAt must be explicit valid values.",
        );
      }
      const requiredKeys = policy.value.requiredDetectors
        .map(descriptorKey)
        .sort();
      const implementationKeys = implementation.value.detectors
        .map(descriptorKey)
        .sort();
      if (
        requiredKeys.length !== implementationKeys.length ||
        requiredKeys.some((key, index) => key !== implementationKeys[index])
      ) {
        throw new EvidenceDerivationError(
          "SCRUBBER_DESCRIPTOR_INVALID",
          "Implementation detector descriptors do not match the policy.",
        );
      }
      const required = policy.value.requiredDetectors.map((requirement) => ({
        requirement,
        detector: detectors.find(
          ({ descriptor }) =>
            descriptorKey(descriptor) === descriptorKey(requirement),
        ),
      }));
      if (required.some(({ detector }) => !detector)) {
        return {
          status: "withheld",
          reasons: [{ code: "required-detector-unavailable" }],
        };
      }
      if (
        policy.value.reproducibility === "byte-stable" &&
        required.some(
          ({ requirement }) => requirement.reproducibility === "best-effort",
        )
      ) {
        return {
          status: "withheld",
          reasons: [{ code: "byte-stability-unsatisfied" }],
        };
      }
      abortIfNeeded(operationOptions);
      const extraction = extractDerivationSurfaces(source, policy.value);
      if (extraction.hold) {
        return { status: "withheld", reasons: [extraction.hold] };
      }
      const dispositions = new Map<string, SurfaceDispositionResult>();
      const reviewFindings: DerivationFinding[] = [];
      for (const surface of extraction.surfaces) {
        const findings: DerivationFinding[] = [];
        for (const { detector } of required) {
          abortIfNeeded(operationOptions);
          try {
            const raw = await detector!.detect(surface, operationOptions);
            findings.push(...normalizeDetectorFindings(surface, raw));
          } catch (cause) {
            if (
              cause instanceof EvidenceDerivationError &&
              (cause.code === "OPERATION_ABORTED" ||
                cause.code === "DETECTOR_CONTRACT_VIOLATION")
            ) {
              throw cause;
            }
            return {
              status: "withheld",
              reasons: [{ code: "required-detector-failed" }],
            };
          }
        }
        const result = applyDerivationDispositions(
          surface,
          normalizeDetectorFindings(surface, findings),
          policy.value,
        );
        dispositions.set(surface.surfaceId, result);
        if (result.status === "withhold-record") {
          return { status: "withheld", reasons: result.reasons };
        }
        if (result.status === "review-required") {
          reviewFindings.push(...result.findings);
        }
      }
      if (reviewFindings.length > 0) {
        return {
          status: "review-required",
          findings: Object.freeze(reviewFindings),
        };
      }
      abortIfNeeded(operationOptions);
      const metadata = transformSourceMetadata(
        source,
        extraction,
        dispositions,
      );
      if (metadata.status === "withhold-record") {
        return { status: "withheld", reasons: metadata.reasons };
      }
      if (metadata.status === "review-required") {
        return { status: "review-required", findings: [] };
      }
      const artifacts = transformSourceArtifacts(
        source,
        extraction,
        dispositions,
        policy.value,
      );
      if (artifacts.status === "withhold-record") {
        return { status: "withheld", reasons: artifacts.reasons };
      }
      if (artifacts.status === "review-required") {
        return { status: "review-required", findings: [] };
      }
      if (
        !metadata.changed &&
        artifacts.derived.length === 0 &&
        artifacts.withheld.length === 0
      ) {
        return {
          status: "publishable-unchanged",
          record: {
            reference: input.sourceRecord.reference,
            bytes: copyBytes(source.recordBytes),
          },
          artifacts: unchangedArtifacts(source),
          bindingImpact: {
            executionVerification: "existing-verification-applicable",
            resultEvaluation: "preserved-for-exact-subjects",
            taskDerived: false,
            resultDerived: false,
          },
        };
      }
      abortIfNeeded(operationOptions);
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
        reproducibility: required.some(
          ({ requirement }) =>
            requirement.reproducibility === "best-effort",
        )
          ? "content-addressed"
          : "byte-stable",
        bindingImpact: artifacts.bindingImpact,
      });
      abortIfNeeded(operationOptions);
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
      return {
        status: "derived",
        record: derivative.record,
        artifacts: derivative.artifacts,
        receipt: {
          digest: receipt.digest,
          bytes: copyBytes(receipt.bytes),
        },
        bindingImpact: artifacts.bindingImpact,
      };
    },
  });
}
