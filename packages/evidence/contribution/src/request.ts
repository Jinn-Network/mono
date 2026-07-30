// SPDX-License-Identifier: Apache-2.0
import { parseEvidenceRecordFamily } from "@jinn-network/evidence-repository";
import type { Sha256Digest } from "@jinn-network/evidence-repository";

import { EvidenceContributionError } from "./errors.js";
import {
  compareCodeUnitStrings,
  fingerprintContributionRecord,
} from "./identities.js";
import { canonicalJsonBytes } from "./canonical-json.js";
import type {
  ContributionDestination,
  ContributionResourceLimits,
  CreateContributionRequestInput,
  DisclosurePolicyDecisionReference,
  EvidenceSourceSelection,
  VerifiedDisclosurePolicyDecision,
} from "./types.js";
import {
  parseAbsoluteIri,
  parseBoundedCount,
  parseContributionDigest,
} from "./validation.js";

const MAX_SEALED_INTENT_BYTES = 4 * 1024 * 1024;

function fail(): never {
  throw new EvidenceContributionError("INVALID_INPUT");
}

function normalizeSourceSelection(
  value: EvidenceSourceSelection,
): EvidenceSourceSelection {
  if (typeof value !== "object" || value === null) fail();
  const repositoryBindingId = value.repositoryBindingId;
  if (typeof repositoryBindingId !== "string" || repositoryBindingId.length === 0) {
    fail();
  }
  const record = value.record;
  if (typeof record !== "object" || record === null) fail();
  return {
    repositoryBindingId,
    record: {
      family: parseEvidenceRecordFamily(record.family),
      digest: parseContributionDigest(record.digest, "source.record.digest"),
    },
  };
}

function normalizePolicyDecision(
  value: DisclosurePolicyDecisionReference,
): DisclosurePolicyDecisionReference {
  if (typeof value !== "object" || value === null) fail();
  const decisionId = value.decisionId;
  if (typeof decisionId !== "string" || decisionId.length === 0) fail();
  return {
    authorityId: parseAbsoluteIri(value.authorityId, "policyDecision.authorityId"),
    decisionId,
    digest: parseContributionDigest(value.digest, "policyDecision.digest"),
  };
}

function normalizeDestination(
  value: ContributionDestination,
): ContributionDestination {
  if (typeof value !== "object" || value === null) fail();
  const label = value.label;
  if (typeof label !== "string" || label.length === 0) fail();
  if (value.irreversible !== true && value.irreversible !== false) fail();
  if (value.deactivation !== "supported" && value.deactivation !== "unsupported") {
    fail();
  }
  return {
    destination: parseAbsoluteIri(value.destination, "destination.destination"),
    medium: parseAbsoluteIri(value.medium, "destination.medium"),
    profile: parseAbsoluteIri(value.profile, "destination.profile"),
    configurationDigest: parseContributionDigest(
      value.configurationDigest,
      "destination.configurationDigest",
    ),
    label,
    irreversible: value.irreversible,
    deactivation: value.deactivation,
  };
}

function normalizeDestinations(
  value: readonly ContributionDestination[],
  limits: ContributionResourceLimits,
): readonly ContributionDestination[] {
  if (!Array.isArray(value) || value.length === 0) fail();
  if (value.length > limits.maxDestinations) {
    throw new EvidenceContributionError("RESOURCE_LIMIT_EXCEEDED");
  }
  const normalized = value.map((destination) => normalizeDestination(destination));
  const seen = new Set<string>();
  for (const destination of normalized) {
    if (seen.has(destination.destination)) fail();
    seen.add(destination.destination);
  }
  return [...normalized].sort((left, right) =>
    compareCodeUnitStrings(left.destination, right.destination));
}

function normalizeLimits(
  value: ContributionResourceLimits,
): ContributionResourceLimits {
  if (typeof value !== "object" || value === null) fail();
  return {
    maxDestinations: parseBoundedCount(value.maxDestinations, "limits.maxDestinations", { min: 1 }),
    maxArtifacts: parseBoundedCount(value.maxArtifacts, "limits.maxArtifacts", { min: 0 }),
    maxArtifactBytes: parseBoundedCount(value.maxArtifactBytes, "limits.maxArtifactBytes", { min: 0 }),
    maxTotalArtifactBytes: parseBoundedCount(value.maxTotalArtifactBytes, "limits.maxTotalArtifactBytes", { min: 0 }),
    maxManifestBytes: parseBoundedCount(value.maxManifestBytes, "limits.maxManifestBytes", { min: 0 }),
    maxConcurrentDestinations: parseBoundedCount(value.maxConcurrentDestinations, "limits.maxConcurrentDestinations", { min: 1 }),
  };
}

function normalizeHostContext(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const keys = Object.keys(value).sort(compareCodeUnitStrings);
  const normalized: Record<string, string> = {};
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry !== "string") fail();
    normalized[key] = entry;
  }
  return normalized;
}

/**
 * Defensively snapshot and validate a caller-supplied contribution request
 * proposal. The result never shares array/object identity with the input.
 */
export function normalizeCreateContributionRequestInput(
  input: CreateContributionRequestInput,
): CreateContributionRequestInput {
  if (typeof input !== "object" || input === null) fail();
  const stagingRepositoryBindingId = input.stagingRepositoryBindingId;
  if (
    typeof stagingRepositoryBindingId !== "string" ||
    stagingRepositoryBindingId.length === 0
  ) {
    fail();
  }
  if (input.idempotencyKey !== undefined && (
    typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0
  )) {
    fail();
  }
  if (input.supersedes !== undefined && (
    typeof input.supersedes !== "string" || input.supersedes.length === 0
  )) {
    fail();
  }
  const limits = normalizeLimits(input.limits);
  return {
    ...(input.idempotencyKey !== undefined
      ? { idempotencyKey: input.idempotencyKey }
      : {}),
    source: normalizeSourceSelection(input.source),
    stagingRepositoryBindingId,
    policyDecision: normalizePolicyDecision(input.policyDecision),
    destinations: normalizeDestinations(input.destinations, limits),
    limits,
    ...(input.hostContext !== undefined
      ? { hostContext: normalizeHostContext(input.hostContext) }
      : {}),
    ...(input.supersedes !== undefined
      ? { supersedes: input.supersedes }
      : {}),
  };
}

function proposalFingerprintPayload(
  input: CreateContributionRequestInput,
): unknown {
  return {
    source: {
      repositoryBindingId: input.source.repositoryBindingId,
      family: input.source.record.family,
      digest: input.source.record.digest,
    },
    stagingRepositoryBindingId: input.stagingRepositoryBindingId,
    policyDecision: {
      authorityId: input.policyDecision.authorityId,
      decisionId: input.policyDecision.decisionId,
      digest: input.policyDecision.digest,
    },
    destinations: [...input.destinations]
      .map((destination) => ({ ...destination }))
      .sort((left, right) =>
        compareCodeUnitStrings(left.destination, right.destination)),
    limits: { ...input.limits },
    supersedes: input.supersedes ?? null,
    hostContext: Object.entries(input.hostContext ?? {})
      .sort(([left], [right]) => compareCodeUnitStrings(left, right)),
  };
}

/**
 * Fingerprint used only for duplicate-create detection under a repeated
 * `idempotencyKey`. Covers every immutable field of the proposal except
 * `idempotencyKey` itself.
 */
export function createContributionProposalFingerprint(
  input: CreateContributionRequestInput,
): Sha256Digest {
  return fingerprintContributionRecord(
    proposalFingerprintPayload(normalizeCreateContributionRequestInput(input)),
  );
}

function routeFingerprintPayload(route: VerifiedDisclosurePolicyDecision): unknown {
  const base = {
    decision: { ...route.decision },
    source: { ...route.source },
    issuedAt: route.issuedAt,
    expiresAt: route.expiresAt ?? null,
    kind: route.kind,
  };
  switch (route.kind) {
    case "derive-execution":
      return {
        ...base,
        policyInput: route.policyInput.digest,
        implementationDescriptor: route.implementationDescriptor.digest,
        policyDigest: route.policyDigest,
        implementationDigest: route.implementationDigest,
        configurationDigest: route.configurationDigest ?? null,
        sourceArtifacts: [...route.sourceArtifacts]
          .map((artifact) => ({
            entityId: artifact.entityId,
            digest: artifact.reference.digest,
          }))
          .sort((left, right) =>
            compareCodeUnitStrings(left.entityId, right.entityId)),
        completedAt: route.completedAt,
      };
    case "disclose-signed-unchanged":
      return {
        ...base,
        allowedCompanionArtifacts: [...route.allowedCompanionArtifacts]
          .map((artifact) => artifact.digest)
          .sort(compareCodeUnitStrings),
      };
    case "reuse-prepared":
      return {
        ...base,
        priorManifest: route.priorManifest.digest,
        expectedPriorPreviewFingerprint: route.expectedPriorPreviewFingerprint,
        preparedRecord: { ...route.preparedRecord },
        preparedArtifacts: [...route.preparedArtifacts]
          .map((artifact) => artifact.digest)
          .sort(compareCodeUnitStrings),
        policyDigest: route.policyDigest,
        implementationDigest: route.implementationDigest,
      };
    case "withhold":
      return {
        ...base,
        reasons: [...route.reasons]
          .map((reason) => reason.code)
          .sort(compareCodeUnitStrings),
      };
  }
}

export interface SealedContributionIntent {
  readonly request: CreateContributionRequestInput;
  readonly disclosureIntent: VerifiedDisclosurePolicyDecision;
  readonly intentBytes: Uint8Array;
  readonly intentFingerprint: Sha256Digest;
}

/**
 * Seal a normalized proposal together with its verified source-bound
 * disclosure-policy route into one immutable intent, and fingerprint the
 * pair. Two logically identical (request, route) pairs -- regardless of key
 * insertion order or supplied object identity -- always seal to the same
 * `intentFingerprint`.
 */
export function sealContributionIntent(
  input: {
    readonly request: CreateContributionRequestInput;
    readonly disclosureIntent: VerifiedDisclosurePolicyDecision;
  },
): SealedContributionIntent {
  const request = normalizeCreateContributionRequestInput(input.request);
  const disclosureIntent = JSON.parse(
    JSON.stringify(input.disclosureIntent),
  ) as VerifiedDisclosurePolicyDecision;
  const sealedPayload = {
    proposal: proposalFingerprintPayload(request),
    route: routeFingerprintPayload(disclosureIntent),
  };
  const intentBytes = canonicalJsonBytes(sealedPayload, MAX_SEALED_INTENT_BYTES);
  const intentFingerprint = fingerprintContributionRecord(sealedPayload);
  return { request, disclosureIntent, intentBytes, intentFingerprint };
}
