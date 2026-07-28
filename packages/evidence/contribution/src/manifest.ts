// SPDX-License-Identifier: Apache-2.0
import {
  derivePublicationIdentities,
  hashExactBytes,
} from "@jinn-network/evidence-publication";
import {
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import type { DerivationBindingImpact } from "@jinn-network/evidence-derivation";

import { canonicalJsonBytes } from "./canonical-json.js";
import { EvidenceContributionError } from "./errors.js";
import { compareCodeUnitStrings } from "./identities.js";
import type {
  ContributionDestination,
  ContributionRequestId,
  DisclosurePolicyDecisionReference,
  PreparedContributionDestination,
  PreparedDisclosure,
  PreparedDisclosureManifest,
  PreparedDisclosurePreparation,
  PreparedDisclosureRisk,
  PreparedUnavailableArtifact,
} from "./types.js";
import {
  parseAbsoluteIri,
  parseContributionDigest,
} from "./validation.js";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

function fail(): never {
  throw new EvidenceContributionError("INVALID_INPUT");
}

function sortArtifacts(
  artifacts: readonly EvidenceArtifactReference[],
): readonly EvidenceArtifactReference[] {
  return [...artifacts]
    .map((artifact) => ({ digest: artifact.digest }))
    .sort((left, right) => compareCodeUnitStrings(left.digest, right.digest));
}

export interface CreatePreparedDisclosureManifestInput {
  readonly requestId: ContributionRequestId;
  readonly intentFingerprint: PreparedDisclosureManifest["intentFingerprint"];
  readonly source: EvidenceRecordReference;
  readonly preparedRecord: EvidenceRecordReference;
  readonly artifacts: readonly EvidenceArtifactReference[];
  readonly preparation: PreparedDisclosurePreparation;
  readonly policyDecision: DisclosurePolicyDecisionReference;
  readonly destinations: readonly ContributionDestination[];
  readonly bindingImpact?: DerivationBindingImpact;
  readonly unavailableArtifacts: readonly PreparedUnavailableArtifact[];
  readonly risk: PreparedDisclosureRisk;
}

/**
 * Build the exact, private, immutable disclosure manifest for one prepared
 * Contribution outcome, deriving Publication's `bundleKey` and
 * `payloadFingerprint` for every destination from the one prepared record
 * and the sorted artifact set -- never recomputing Publication's identity
 * algorithm independently.
 */
export function createPreparedDisclosureManifest(
  input: CreatePreparedDisclosureManifestInput,
): PreparedDisclosure {
  if (!Array.isArray(input.destinations) || input.destinations.length === 0) {
    fail();
  }
  const preparedRecord = parseEvidenceRecordReference(input.preparedRecord);
  const artifacts = sortArtifacts(input.artifacts);
  const destinations: PreparedContributionDestination[] = input.destinations
    .map((descriptor) => {
      const { bundleKey, payloadFingerprint } = derivePublicationIdentities(
        [preparedRecord],
        artifacts,
        descriptor.destination,
      );
      return {
        descriptor: { ...descriptor },
        bundleKey,
        payloadFingerprint,
      };
    })
    .sort((left, right) =>
      compareCodeUnitStrings(
        left.descriptor.destination,
        right.descriptor.destination,
      ));

  const manifest: PreparedDisclosureManifest = {
    schemaVersion: 1,
    requestId: input.requestId,
    intentFingerprint: parseContributionDigest(
      input.intentFingerprint,
      "intentFingerprint",
    ),
    source: parseEvidenceRecordReference(input.source),
    preparedRecord,
    artifacts,
    preparation: { ...input.preparation },
    policyDecision: { ...input.policyDecision },
    ...(input.bindingImpact !== undefined
      ? { bindingImpact: { ...input.bindingImpact } }
      : {}),
    unavailableArtifacts: [...input.unavailableArtifacts]
      .map((artifact) => ({ ...artifact }))
      .sort((left, right) =>
        compareCodeUnitStrings(left.entityId, right.entityId)),
    risk: { ...input.risk },
    destinations,
  };

  const manifestBytes = canonicalJsonBytes(manifest, MAX_MANIFEST_BYTES);
  const previewFingerprint = hashExactBytes(manifestBytes);
  return { manifest, manifestBytes, previewFingerprint };
}

function parsePreparation(value: unknown): PreparedDisclosurePreparation {
  if (typeof value !== "object" || value === null) fail();
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "publishable-unchanged":
    case "derived": {
      const policyDigest = parseContributionDigest(
        candidate.policyDigest,
        "preparation.policyDigest",
      );
      const implementationDigest = parseContributionDigest(
        candidate.implementationDigest,
        "preparation.implementationDigest",
      );
      const configurationDigest = candidate.configurationDigest === undefined
        ? undefined
        : parseContributionDigest(
          candidate.configurationDigest,
          "preparation.configurationDigest",
        );
      const policyInput = parseEvidenceArtifactReference(candidate.policyInput);
      const implementationDescriptor = parseEvidenceArtifactReference(
        candidate.implementationDescriptor,
      );
      if (candidate.kind === "publishable-unchanged") {
        return {
          kind: "publishable-unchanged",
          policyInput,
          implementationDescriptor,
          policyDigest,
          implementationDigest,
          ...(configurationDigest !== undefined ? { configurationDigest } : {}),
        };
      }
      return {
        kind: "derived",
        derivationReceipt: parseEvidenceArtifactReference(
          candidate.derivationReceipt,
        ),
        policyInput,
        implementationDescriptor,
        policyDigest,
        implementationDigest,
        ...(configurationDigest !== undefined ? { configurationDigest } : {}),
      };
    }
    case "signed-unchanged":
      return { kind: "signed-unchanged" };
    case "verified-reuse":
      return {
        kind: "verified-reuse",
        priorPreviewFingerprint: parseContributionDigest(
          candidate.priorPreviewFingerprint,
          "preparation.priorPreviewFingerprint",
        ),
      };
    default:
      fail();
  }
}

function parsePolicyDecisionReference(
  value: unknown,
): DisclosurePolicyDecisionReference {
  if (typeof value !== "object" || value === null) fail();
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.decisionId !== "string" || candidate.decisionId.length === 0) {
    fail();
  }
  return {
    authorityId: parseAbsoluteIri(candidate.authorityId, "policyDecision.authorityId"),
    decisionId: candidate.decisionId,
    digest: parseContributionDigest(candidate.digest, "policyDecision.digest"),
  };
}

function parseDestinationDescriptor(value: unknown): ContributionDestination {
  if (typeof value !== "object" || value === null) fail();
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.label !== "string" || candidate.label.length === 0) fail();
  if (candidate.irreversible !== true && candidate.irreversible !== false) fail();
  if (candidate.deactivation !== "supported" && candidate.deactivation !== "unsupported") {
    fail();
  }
  return {
    destination: parseAbsoluteIri(candidate.destination, "destination.destination"),
    medium: parseAbsoluteIri(candidate.medium, "destination.medium"),
    profile: parseAbsoluteIri(candidate.profile, "destination.profile"),
    configurationDigest: parseContributionDigest(
      candidate.configurationDigest,
      "destination.configurationDigest",
    ),
    label: candidate.label,
    irreversible: candidate.irreversible,
    deactivation: candidate.deactivation,
  };
}

function parsePreparedDestination(
  value: unknown,
): PreparedContributionDestination {
  if (typeof value !== "object" || value === null) fail();
  const candidate = value as Record<string, unknown>;
  return {
    descriptor: parseDestinationDescriptor(candidate.descriptor),
    bundleKey: parseContributionDigest(candidate.bundleKey, "destination.bundleKey"),
    payloadFingerprint: parseContributionDigest(
      candidate.payloadFingerprint,
      "destination.payloadFingerprint",
    ),
  };
}

function parseUnavailableArtifact(value: unknown): PreparedUnavailableArtifact {
  if (typeof value !== "object" || value === null) fail();
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.entityId !== "string" || candidate.entityId.length === 0) fail();
  if (typeof candidate.reasonCode !== "string" || candidate.reasonCode.length === 0) fail();
  return {
    entityId: candidate.entityId,
    reasonCode: candidate.reasonCode,
    ...(candidate.sourceCommitment !== undefined
      ? {
        sourceCommitment: parseContributionDigest(
          candidate.sourceCommitment,
          "unavailableArtifacts[].sourceCommitment",
        ),
      }
      : {}),
  };
}

function parseRisk(value: unknown): PreparedDisclosureRisk {
  if (typeof value !== "object" || value === null) fail();
  const candidate = value as Record<string, unknown>;
  if (
    candidate.irreversibility !== "mutable-location" &&
    candidate.irreversibility !== "immutable-or-replicable"
  ) {
    fail();
  }
  if (
    candidate.sourceCommitmentCorrelation !== "none-declared" &&
    candidate.sourceCommitmentCorrelation !== "low" &&
    candidate.sourceCommitmentCorrelation !== "elevated" &&
    candidate.sourceCommitmentCorrelation !== "unknown"
  ) {
    fail();
  }
  return {
    irreversibility: candidate.irreversibility,
    sourceCommitmentCorrelation: candidate.sourceCommitmentCorrelation,
  };
}

/**
 * Parse and structurally validate previously-serialized exact manifest
 * bytes. Fails closed on any unsupported major `schemaVersion`.
 */
export function parsePreparedDisclosureManifest(
  bytes: Uint8Array,
): PreparedDisclosureManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail();
  }
  if (typeof parsed !== "object" || parsed === null) fail();
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) fail();
  if (typeof candidate.requestId !== "string" || candidate.requestId.length === 0) {
    fail();
  }
  if (!Array.isArray(candidate.artifacts)) fail();
  if (!Array.isArray(candidate.unavailableArtifacts)) fail();
  if (!Array.isArray(candidate.destinations) || candidate.destinations.length === 0) {
    fail();
  }
  return {
    schemaVersion: 1,
    requestId: candidate.requestId,
    intentFingerprint: parseContributionDigest(
      candidate.intentFingerprint,
      "intentFingerprint",
    ),
    source: parseEvidenceRecordReference(candidate.source),
    preparedRecord: parseEvidenceRecordReference(candidate.preparedRecord),
    artifacts: sortArtifacts(
      candidate.artifacts.map((artifact) =>
        parseEvidenceArtifactReference(artifact)),
    ),
    preparation: parsePreparation(candidate.preparation),
    policyDecision: parsePolicyDecisionReference(candidate.policyDecision),
    ...(candidate.bindingImpact !== undefined
      ? { bindingImpact: candidate.bindingImpact as DerivationBindingImpact }
      : {}),
    unavailableArtifacts: candidate.unavailableArtifacts
      .map((artifact) => parseUnavailableArtifact(artifact))
      .sort((left, right) =>
        compareCodeUnitStrings(left.entityId, right.entityId)),
    risk: parseRisk(candidate.risk),
    destinations: candidate.destinations
      .map((destination) => parsePreparedDestination(destination))
      .sort((left, right) =>
        compareCodeUnitStrings(
          left.descriptor.destination,
          right.descriptor.destination,
        )),
  };
}
