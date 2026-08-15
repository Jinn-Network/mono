// SPDX-License-Identifier: Apache-2.0

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
import { assertNotProxy, ownDataProperty } from "./inert.js";
import { transformSourceMetadata } from "./metadata-transform.js";
import { parseDerivationPolicy } from "./policy.js";
import { buildPublicExecutionEvidence } from "./public-graph.js";
import {
  buildScrubReceipt,
  parseScrubberImplementationDescriptor,
} from "./receipt.js";
import {
  snapshotDerivationInput,
  validateDerivationSource,
} from "./source.js";
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
import { compareCodeUnitStrings } from "./order.js";

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

function snapshotOperationOptions(
  options?: DerivationOperationOptions,
): DerivationOperationOptions | undefined {
  if (options === undefined) return undefined;
  assertNotProxy(options, "Derivation operation options must not be a Proxy.");
  if (!options || typeof options !== "object") {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Derivation operation options are invalid.",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        key !== "signal" ||
        !("value" in descriptors[key as keyof typeof descriptors]!),
    )
  ) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Derivation operation options must contain only an own signal data property.",
    );
  }
  const signal = descriptors.signal?.value as unknown;
  if (signal !== undefined) {
    assertNotProxy(signal, "AbortSignal must not be a Proxy.");
    if (!(signal instanceof AbortSignal)) {
      throw new EvidenceDerivationError(
        "INVALID_DERIVATION_INPUT",
        "signal must be an AbortSignal.",
      );
    }
  }
  return signal === undefined ? Object.freeze({}) : Object.freeze({ signal });
}

function checkedOutcome<T>(
  value: T,
  options?: DerivationOperationOptions,
): T {
  abortIfNeeded(options);
  return value;
}

function strictTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= daysInMonth.length &&
    day >= 1 &&
    day <= daysInMonth[month - 1]! &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
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
      .sort((left, right) => compareCodeUnitStrings(left.entityId, right.entityId)),
  );
}

export function createEvidenceDeriver(
  options: CreateEvidenceDeriverOptions,
): EvidenceDeriver {
  assertNotProxy(options, "Deriver construction options must not be a Proxy.");
  if (!options || typeof options !== "object") {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Deriver construction requires an explicit detector array.",
    );
  }
  const detectors = snapshotDetectors(
    ownDataProperty(options, "detectors", "deriver construction options") as
      CreateEvidenceDeriverOptions["detectors"],
  );
  return Object.freeze({
    async derive(
      input: DeriveExecutionEvidenceInput,
      operationOptions?: DerivationOperationOptions,
    ): Promise<EvidenceDerivationOutcome> {
      operationOptions = snapshotOperationOptions(operationOptions);
      abortIfNeeded(operationOptions);
      input = snapshotDerivationInput(input);
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
        return checkedOutcome({
          status: "withheld",
          reasons: [{ code: "required-detector-unavailable" }],
        } as const, operationOptions);
      }
      if (
        policy.value.reproducibility === "byte-stable" &&
        required.some(
          ({ requirement }) => requirement.reproducibility === "best-effort",
        )
      ) {
        return checkedOutcome({
          status: "withheld",
          reasons: [{ code: "byte-stability-unsatisfied" }],
        } as const, operationOptions);
      }
      abortIfNeeded(operationOptions);
      const extraction = extractDerivationSurfaces(source, policy.value);
      if (extraction.hold) {
        return checkedOutcome(
          { status: "withheld", reasons: [extraction.hold] } as const,
          operationOptions,
        );
      }
      const dispositions = new Map<string, SurfaceDispositionResult>();
      const reviewFindings: DerivationFinding[] = [];
      for (const surface of extraction.surfaces) {
        const findings: DerivationFinding[] = [];
        for (const { detector } of required) {
          abortIfNeeded(operationOptions);
          try {
            const raw = await detector!.detect(surface, operationOptions);
            abortIfNeeded(operationOptions);
            findings.push(
              ...normalizeDetectorFindings(
                surface,
                raw,
                detector!.descriptor,
              ).filter(
                (finding) =>
                  !policy.value.technicalAllowlist.includes(
                    surface.text.slice(finding.start, finding.end),
                  ),
              ),
            );
          } catch (cause) {
            if (
              cause instanceof EvidenceDerivationError &&
              (cause.code === "OPERATION_ABORTED" ||
                cause.code === "DETECTOR_CONTRACT_VIOLATION")
            ) {
              throw cause;
            }
            return checkedOutcome({
              status: "withheld",
              reasons: [{ code: "required-detector-failed" }],
            } as const, operationOptions);
          }
        }
        const result = applyDerivationDispositions(
          surface,
          normalizeDetectorFindings(surface, findings),
          policy.value,
        );
        dispositions.set(surface.surfaceId, result);
        if (result.status === "withhold-record") {
          return checkedOutcome(
            { status: "withheld", reasons: result.reasons } as const,
            operationOptions,
          );
        }
        if (result.status === "review-required") {
          reviewFindings.push(...result.findings);
        }
      }
      if (reviewFindings.length > 0) {
        return checkedOutcome({
          status: "review-required",
          findings: Object.freeze(reviewFindings),
        } as const, operationOptions);
      }
      abortIfNeeded(operationOptions);
      const metadata = transformSourceMetadata(
        source,
        extraction,
        dispositions,
      );
      if (metadata.status === "withhold-record") {
        return checkedOutcome(
          { status: "withheld", reasons: metadata.reasons } as const,
          operationOptions,
        );
      }
      if (metadata.status === "review-required") {
        return checkedOutcome(
          { status: "review-required", findings: [] } as const,
          operationOptions,
        );
      }
      const artifacts = transformSourceArtifacts(
        source,
        extraction,
        dispositions,
        policy.value,
      );
      if (artifacts.status === "withhold-record") {
        return checkedOutcome(
          { status: "withheld", reasons: artifacts.reasons } as const,
          operationOptions,
        );
      }
      if (artifacts.status === "review-required") {
        return checkedOutcome(
          { status: "review-required", findings: [] } as const,
          operationOptions,
        );
      }
      if (
        !metadata.changed &&
        artifacts.derived.length === 0 &&
        artifacts.withheld.length === 0
      ) {
        return checkedOutcome({
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
        } as const, operationOptions);
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
      return checkedOutcome({
        status: "derived",
        record: derivative.record,
        artifacts: derivative.artifacts,
        receipt: {
          digest: receipt.digest,
          bytes: copyBytes(receipt.bytes),
        },
        bindingImpact: artifacts.bindingImpact,
      } as const, operationOptions);
    },
  });
}
