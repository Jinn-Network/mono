// SPDX-License-Identifier: Apache-2.0
import type { EvidenceDeriver } from "@jinn-network/evidence-derivation";
import {
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import type {
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import { EvidenceContributionError } from "./errors.js";
import type {
  ContributionOperationOptions,
  ContributionRequestId,
  DisclosurePolicyDecisionReference,
  VerifiedDeriveExecutionDecision,
  VerifiedDisclosurePolicyDecision,
  VerifiedReuseDecision,
  VerifiedSignedUnchangedDecision,
  VerifiedWithholdDecision,
} from "./types.js";
import { CONTRIBUTION_SAFE_REASON_CODES } from "./types.js";
import type { DerivationFinding } from "@jinn-network/evidence-derivation";
import {
  parseAbsoluteIri,
  parseContributionDigest,
  parseContributionTimestamp,
  snapshotInertJsonValue,
} from "./validation.js";

export interface DisclosurePolicyAuthority {
  verify(
    reference: DisclosurePolicyDecisionReference,
    source: EvidenceRecordReference,
    options?: ContributionOperationOptions,
  ): Promise<VerifiedDisclosurePolicyDecision>;
}

export interface DerivationResolver {
  resolve(
    input: {
      readonly implementationDigest: Sha256Digest;
      readonly configurationDigest?: Sha256Digest;
    },
    options?: ContributionOperationOptions,
  ): Promise<EvidenceDeriver>;
}

export interface ReviewReferenceStore {
  retain(
    input: {
      readonly requestId: ContributionRequestId;
      readonly findings: readonly DerivationFinding[];
    },
    options?: ContributionOperationOptions,
  ): Promise<{ readonly reviewReference: string }>;
}

function fail(code: "POLICY_INVALID" | "POLICY_DENIED"): never {
  throw new EvidenceContributionError(code);
}

function parsePolicyDecisionReferenceField(
  value: unknown,
): DisclosurePolicyDecisionReference {
  if (typeof value !== "object" || value === null) fail("POLICY_INVALID");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.decisionId !== "string" || candidate.decisionId.length === 0) {
    fail("POLICY_INVALID");
  }
  return {
    authorityId: parseAbsoluteIri(candidate.authorityId, "decision.authorityId"),
    decisionId: candidate.decisionId,
    digest: parseContributionDigest(candidate.digest, "decision.digest"),
  };
}

function parseSourceField(value: unknown): EvidenceRecordReference {
  try {
    return parseEvidenceRecordReference(value);
  } catch {
    fail("POLICY_INVALID");
  }
}

function referencesEqual(
  left: DisclosurePolicyDecisionReference,
  right: DisclosurePolicyDecisionReference,
): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.decisionId === right.decisionId &&
    left.digest === right.digest
  );
}

function sourcesEqual(
  left: EvidenceRecordReference,
  right: EvidenceRecordReference,
): boolean {
  return left.family === right.family && left.digest === right.digest;
}

function parseDeriveExecutionDecision(
  candidate: Record<string, unknown>,
  base: Pick<
    VerifiedDeriveExecutionDecision,
    "decision" | "source" | "issuedAt" | "expiresAt"
  >,
): VerifiedDeriveExecutionDecision {
  if (base.source.family !== "execution-evidence") fail("POLICY_INVALID");
  const sourceArtifactsValue = candidate.sourceArtifacts;
  if (!Array.isArray(sourceArtifactsValue)) fail("POLICY_INVALID");
  const sourceArtifacts = sourceArtifactsValue.map((entry) => {
    if (typeof entry !== "object" || entry === null) fail("POLICY_INVALID");
    const item = entry as Record<string, unknown>;
    if (typeof item.entityId !== "string" || item.entityId.length === 0) {
      fail("POLICY_INVALID");
    }
    try {
      return {
        entityId: item.entityId,
        reference: parseEvidenceArtifactReference(item.reference),
      };
    } catch {
      fail("POLICY_INVALID");
    }
  });
  const risk = candidate.risk;
  if (typeof risk !== "object" || risk === null) fail("POLICY_INVALID");
  const riskCandidate = risk as Record<string, unknown>;
  if (
    riskCandidate.irreversibility !== "mutable-location" &&
    riskCandidate.irreversibility !== "immutable-or-replicable"
  ) {
    fail("POLICY_INVALID");
  }
  if (
    riskCandidate.sourceCommitmentCorrelation !== "none-declared" &&
    riskCandidate.sourceCommitmentCorrelation !== "low" &&
    riskCandidate.sourceCommitmentCorrelation !== "elevated" &&
    riskCandidate.sourceCommitmentCorrelation !== "unknown"
  ) {
    fail("POLICY_INVALID");
  }
  return {
    ...base,
    kind: "derive-execution",
    policyInput: (() => {
      try {
        return parseEvidenceArtifactReference(candidate.policyInput);
      } catch {
        fail("POLICY_INVALID");
      }
    })(),
    implementationDescriptor: (() => {
      try {
        return parseEvidenceArtifactReference(candidate.implementationDescriptor);
      } catch {
        fail("POLICY_INVALID");
      }
    })(),
    sourceArtifacts,
    policyDigest: parseContributionDigest(candidate.policyDigest, "policyDigest"),
    implementationDigest: parseContributionDigest(
      candidate.implementationDigest,
      "implementationDigest",
    ),
    ...(candidate.configurationDigest !== undefined
      ? {
        configurationDigest: parseContributionDigest(
          candidate.configurationDigest,
          "configurationDigest",
        ),
      }
      : {}),
    completedAt: parseContributionTimestamp(candidate.completedAt, "completedAt"),
    risk: {
      irreversibility: riskCandidate.irreversibility,
      sourceCommitmentCorrelation: riskCandidate.sourceCommitmentCorrelation,
    },
  };
}

function parseSignedUnchangedDecision(
  candidate: Record<string, unknown>,
  base: Pick<
    VerifiedSignedUnchangedDecision,
    "decision" | "source" | "issuedAt" | "expiresAt"
  >,
): VerifiedSignedUnchangedDecision {
  if (base.source.family !== "result-evaluation" && base.source.family !== "execution-verification") {
    fail("POLICY_INVALID");
  }
  const artifactsValue = candidate.allowedCompanionArtifacts;
  if (!Array.isArray(artifactsValue)) fail("POLICY_INVALID");
  const allowedCompanionArtifacts = artifactsValue.map((entry) => {
    try {
      return parseEvidenceArtifactReference(entry);
    } catch {
      fail("POLICY_INVALID");
    }
  });
  return { ...base, kind: "disclose-signed-unchanged", allowedCompanionArtifacts };
}

function parseReuseDecision(
  candidate: Record<string, unknown>,
  base: Pick<
    VerifiedReuseDecision,
    "decision" | "source" | "issuedAt" | "expiresAt"
  >,
): VerifiedReuseDecision {
  const preparedArtifactsValue = candidate.preparedArtifacts;
  if (!Array.isArray(preparedArtifactsValue)) fail("POLICY_INVALID");
  return {
    ...base,
    kind: "reuse-prepared",
    priorManifest: (() => {
      try {
        return parseEvidenceArtifactReference(candidate.priorManifest);
      } catch {
        fail("POLICY_INVALID");
      }
    })(),
    expectedPriorPreviewFingerprint: parseContributionDigest(
      candidate.expectedPriorPreviewFingerprint,
      "expectedPriorPreviewFingerprint",
    ),
    preparedRecord: parseSourceField(candidate.preparedRecord),
    preparedArtifacts: preparedArtifactsValue.map((entry) => {
      try {
        return parseEvidenceArtifactReference(entry);
      } catch {
        fail("POLICY_INVALID");
      }
    }),
    policyDigest: parseContributionDigest(candidate.policyDigest, "policyDigest"),
    implementationDigest: parseContributionDigest(
      candidate.implementationDigest,
      "implementationDigest",
    ),
  };
}

function parseWithholdDecision(
  candidate: Record<string, unknown>,
  base: Pick<
    VerifiedWithholdDecision,
    "decision" | "source" | "issuedAt" | "expiresAt"
  >,
): VerifiedWithholdDecision {
  const reasonsValue = candidate.reasons;
  if (!Array.isArray(reasonsValue) || reasonsValue.length === 0) fail("POLICY_INVALID");
  const reasons = reasonsValue.map((entry) => {
    if (typeof entry !== "object" || entry === null) fail("POLICY_INVALID");
    const code = (entry as Record<string, unknown>).code;
    if (
      typeof code !== "string" ||
      !(CONTRIBUTION_SAFE_REASON_CODES as readonly string[]).includes(code)
    ) {
      fail("POLICY_INVALID");
    }
    return { code: code as (typeof CONTRIBUTION_SAFE_REASON_CODES)[number] };
  });
  return { ...base, kind: "withhold", reasons };
}

/**
 * Verify a source-bound disclosure-policy decision, then re-derive a fully
 * validated `VerifiedDisclosurePolicyDecision` from the authority's raw
 * response -- never trusting it at face value. Rechecks the exact source
 * family/digest, the policy-decision digest, issue/expiry times,
 * route-family compatibility, artifact references, and
 * implementation/configuration identities after the authority returns.
 */
export async function resolveDisclosureRoute(
  reference: DisclosurePolicyDecisionReference,
  source: EvidenceRecordReference,
  authority: DisclosurePolicyAuthority,
  now: string,
  options?: ContributionOperationOptions,
): Promise<VerifiedDisclosurePolicyDecision> {
  const raw = await authority.verify(reference, source, options);
  const snapshot = snapshotInertJsonValue(raw) as Record<string, unknown>;
  if (typeof snapshot !== "object" || snapshot === null) fail("POLICY_INVALID");

  const decision = parsePolicyDecisionReferenceField(snapshot.decision);
  if (!referencesEqual(decision, reference)) fail("POLICY_DENIED");

  const decisionSource = parseSourceField(snapshot.source);
  if (!sourcesEqual(decisionSource, source)) fail("POLICY_DENIED");

  const issuedAt = parseContributionTimestamp(snapshot.issuedAt, "issuedAt");
  const expiresAt = snapshot.expiresAt === undefined
    ? undefined
    : parseContributionTimestamp(snapshot.expiresAt, "expiresAt");
  if (expiresAt !== undefined && expiresAt <= now) fail("POLICY_INVALID");

  const base = {
    decision,
    source: decisionSource,
    issuedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };

  switch (snapshot.kind) {
    case "derive-execution":
      return parseDeriveExecutionDecision(snapshot, base);
    case "disclose-signed-unchanged":
      return parseSignedUnchangedDecision(snapshot, base);
    case "reuse-prepared":
      return parseReuseDecision(snapshot, base);
    case "withhold":
      return parseWithholdDecision(snapshot, base);
    default:
      fail("POLICY_INVALID");
  }
}
