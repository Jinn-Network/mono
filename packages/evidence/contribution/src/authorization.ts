// SPDX-License-Identifier: Apache-2.0
import { hashExactBytes } from "@jinn-network/evidence-publication";
import type { Sha256Digest } from "@jinn-network/evidence-repository";

import {
  toContributionReadModel,
  type ContributionAuthorizationDependencies,
  type ContributionGrantDependencies,
} from "./commands.js";
import {
  EvidenceContributionError,
  type EvidenceContributionErrorCode,
} from "./errors.js";
import { appendCurrentContributionReceipt } from "./receipt.js";
import {
  updateContributionDestinationState,
  type ContributionRequestState,
  type StandingAuthorizationGrantState,
} from "./state.js";
import type { VersionedStandingGrant } from "./store.js";
import {
  CONTRIBUTION_SAFE_REASON_CODES,
  toContributionCallOptions,
  type ContributionCallOptions,
  type ContributionGrantId,
  type ContributionOperationOptions,
  type ContributionReadModel,
  type ContributionRequestId,
  type ContributionResourceLimits,
  type ContributionSafeReasonCode,
  type ExactAuthorizationSubmission,
  type PreparedDisclosureManifest,
  type StandingAuthorizationGrantReadModel,
  type StandingGrantRevocationSubmission,
  type StandingGrantSourceScope,
  type StandingGrantSubmission,
  type VerifiedExactAuthorization,
  type VerifiedStandingGrant,
  type VerifiedStandingGrantRevocation,
} from "./types.js";
import {
  parseAbsoluteIri,
  parseBoundedCount,
  parseContributionDigest,
  parseContributionTimestamp,
  snapshotInertJsonValue,
} from "./validation.js";

export interface AuthorizationAuthority {
  verifyExact(
    submission: ExactAuthorizationSubmission,
    manifest: PreparedDisclosureManifest,
    options?: ContributionCallOptions,
  ): Promise<VerifiedExactAuthorization>;
  verifyStandingGrant(
    submission: StandingGrantSubmission,
    options?: ContributionCallOptions,
  ): Promise<VerifiedStandingGrant>;
  verifyStandingGrantRevocation(
    submission: StandingGrantRevocationSubmission,
    grant: StandingAuthorizationGrantState,
    options?: ContributionCallOptions,
  ): Promise<VerifiedStandingGrantRevocation>;
  evaluateHostScope(
    grant: StandingAuthorizationGrantState,
    context: Readonly<Record<string, string>>,
    options?: ContributionCallOptions,
  ): Promise<{ readonly matches: boolean; readonly decisionDigest: Sha256Digest }>;
}

function fail(code: EvidenceContributionErrorCode): never {
  throw new EvidenceContributionError(code);
}

function requireProofDigestMatch(
  proofBytes: Uint8Array,
  proofDigest: Sha256Digest,
): void {
  const snapshot = Uint8Array.from(proofBytes);
  if (hashExactBytes(snapshot) !== proofDigest) fail("POLICY_INVALID");
}

// ---------------------------------------------------------------------------
// Exact authorization submission / verified-result parsing
//
// The authority port's return value is never trusted at face value: core
// re-derives a fully validated result from its raw JSON-compatible shape,
// exactly like `resolveDisclosureRoute` in policy.ts.
// ---------------------------------------------------------------------------

function parseSafeReasonCode(value: unknown): ContributionSafeReasonCode {
  if (
    typeof value !== "string" ||
    !(CONTRIBUTION_SAFE_REASON_CODES as readonly string[]).includes(value)
  ) {
    fail("POLICY_INVALID");
  }
  return value as ContributionSafeReasonCode;
}

function parseDigestArray(value: unknown, field: string): readonly Sha256Digest[] {
  if (!Array.isArray(value)) fail("POLICY_INVALID");
  return value.map((entry) => parseContributionDigest(entry, field));
}

function parseAbsoluteIriArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) fail("POLICY_INVALID");
  return value.map((entry) => parseAbsoluteIri(entry, field));
}

function parseVerifiedExactAuthorization(
  raw: unknown,
  submission: ExactAuthorizationSubmission,
): VerifiedExactAuthorization {
  const snapshot = snapshotInertJsonValue(raw) as Record<string, unknown>;
  if (typeof snapshot !== "object" || snapshot === null) fail("POLICY_INVALID");
  if (snapshot.mode !== "interactive-exact" && snapshot.mode !== "organization-exact") {
    fail("POLICY_INVALID");
  }
  if (snapshot.mode !== submission.mode) fail("AUTHORIZATION_DENIED");
  const previewFingerprint = parseContributionDigest(
    snapshot.previewFingerprint,
    "previewFingerprint",
  );
  if (previewFingerprint !== submission.previewFingerprint) {
    fail("AUTHORIZATION_STALE");
  }
  const allowedDestinationIds = parseAbsoluteIriArray(
    snapshot.allowedDestinationIds,
    "allowedDestinationIds",
  );
  const decidedAt = parseContributionTimestamp(snapshot.decidedAt, "decidedAt");
  const expiresAt = snapshot.expiresAt === undefined
    ? undefined
    : parseContributionTimestamp(snapshot.expiresAt, "expiresAt");
  const deniedDestinationsValue = snapshot.deniedDestinations;
  if (!Array.isArray(deniedDestinationsValue)) fail("POLICY_INVALID");
  const deniedDestinations = deniedDestinationsValue.map((entry) => {
    if (typeof entry !== "object" || entry === null) fail("POLICY_INVALID");
    const candidate = entry as Record<string, unknown>;
    return {
      destination: parseAbsoluteIri(
        candidate.destination,
        "deniedDestinations[].destination",
      ),
      reasonCode: parseSafeReasonCode(candidate.reasonCode),
    };
  });
  if (typeof snapshot.exactPreviewPresented !== "boolean") fail("POLICY_INVALID");
  if (
    snapshot.mode === "organization-exact" &&
    snapshot.exactPreviewPresented === true
  ) {
    // Organization mode never claims a human preview occurred.
    fail("POLICY_INVALID");
  }
  return {
    mode: snapshot.mode,
    authorityId: parseAbsoluteIri(snapshot.authorityId, "authorityId"),
    actorId: (() => {
      if (typeof snapshot.actorId !== "string" || snapshot.actorId.length === 0) {
        fail("POLICY_INVALID");
      }
      return snapshot.actorId;
    })(),
    previewFingerprint,
    allowedDestinationIds,
    decidedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    proofDigest: parseContributionDigest(snapshot.proofDigest, "proofDigest"),
    exactPreviewPresented: snapshot.exactPreviewPresented,
    deniedDestinations,
  };
}

/**
 * Verify and record an interactive or organization-controlled exact
 * authorization decision for a request's prepared disclosure. The decision
 * may authorize a subset of destinations; unmentioned destinations remain
 * `awaiting-authorization`, explicitly denied destinations are recorded
 * with a safe reason code.
 */
export async function authorizeContribution(
  requestId: ContributionRequestId,
  submission: ExactAuthorizationSubmission,
  dependencies: ContributionAuthorizationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel> {
  let versioned = await dependencies.store.loadRequest(requestId, options);
  if (versioned === null) fail("INVALID_INPUT");
  if (
    options?.expectedRequestRevision !== undefined &&
    options.expectedRequestRevision !== versioned.revision
  ) {
    fail("STORE_CONFLICT");
  }
  if (versioned.value.preparation.status !== "preview-ready") {
    fail("AUTHORIZATION_REQUIRED");
  }
  const disclosure = versioned.value.preparation.disclosure;
  const manifest = disclosure.manifest;
  if (submission.previewFingerprint !== disclosure.previewFingerprint) {
    fail("AUTHORIZATION_STALE");
  }

  requireProofDigestMatch(submission.proofBytes, submission.proofDigest);
  const forAuthority: ExactAuthorizationSubmission = {
    ...submission,
    proofBytes: Uint8Array.from(submission.proofBytes),
  };
  const raw = await dependencies.authorization.verifyExact(
    forAuthority,
    manifest,
    toContributionCallOptions(options),
  );
  const verified = parseVerifiedExactAuthorization(raw, submission);

  const now = dependencies.clock.now();
  if (verified.expiresAt !== undefined && verified.expiresAt <= now) {
    fail("AUTHORIZATION_EXPIRED");
  }

  const decisionId = dependencies.identifiers.nextDecisionId();
  // Selection is keyed by destination ID, not `configurationDigest` (design
  // §9.3: "allowed destination IDs"; §11.3: approval of one destination
  // never implies approval of another). Two distinct destinations may share
  // a `configurationDigest`; keying by digest would authorize or deny both
  // together even when the decision named only one.
  const allowedIds = new Set(verified.allowedDestinationIds);
  const deniedByDestination = new Map(
    verified.deniedDestinations.map((entry) => [entry.destination, entry.reasonCode]),
  );

  const events: {
    readonly schemaVersion: 1;
    readonly kind: "authorized" | "authorization-denied";
    readonly at: string;
    readonly destination: string;
    readonly reasonCode?: ContributionSafeReasonCode;
  }[] = [];

  let nextDestinations = versioned.value.destinations;
  for (const prepared of manifest.destinations) {
    const destination = prepared.descriptor.destination;
    if (allowedIds.has(destination)) {
      nextDestinations = updateContributionDestinationState(
        nextDestinations,
        destination,
        (current) => ({
          ...current,
          authorization: { status: "authorized", decisionId },
        }),
      );
      events.push({ schemaVersion: 1, kind: "authorized", at: now, destination });
    } else if (deniedByDestination.has(destination)) {
      const reasonCode = deniedByDestination.get(destination)!;
      nextDestinations = updateContributionDestinationState(
        nextDestinations,
        destination,
        (current) => ({
          ...current,
          authorization: { status: "denied", reasonCode },
        }),
      );
      events.push({
        schemaVersion: 1,
        kind: "authorization-denied",
        at: now,
        destination,
        reasonCode,
      });
    }
  }

  const nextState: ContributionRequestState = appendCurrentContributionReceipt({
    ...versioned.value,
    destinations: nextDestinations,
    authorizationDecisions: [
      ...versioned.value.authorizationDecisions,
      { decisionId, decision: verified },
    ],
    auditEvents: [...versioned.value.auditEvents, ...events],
    updatedAt: now,
  });
  versioned = await dependencies.store.compareAndSwapRequest(versioned, nextState, options);
  return toContributionReadModel(versioned);
}

// ---------------------------------------------------------------------------
// Standing grant creation / revocation / application
// ---------------------------------------------------------------------------

function parseSourceScope(value: unknown): StandingGrantSourceScope {
  if (typeof value !== "object" || value === null) fail("POLICY_INVALID");
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "exact-source") {
    const source = candidate.source;
    if (typeof source !== "object" || source === null) fail("POLICY_INVALID");
    const sourceCandidate = source as Record<string, unknown>;
    if (
      sourceCandidate.family !== "execution-evidence" &&
      sourceCandidate.family !== "result-evaluation" &&
      sourceCandidate.family !== "execution-verification"
    ) {
      fail("POLICY_INVALID");
    }
    return {
      kind: "exact-source",
      source: {
        family: sourceCandidate.family,
        digest: parseContributionDigest(sourceCandidate.digest, "sourceScope.source.digest"),
      },
    };
  }
  if (candidate.kind === "host-scope") {
    return {
      kind: "host-scope",
      scopeDigest: parseContributionDigest(candidate.scopeDigest, "sourceScope.scopeDigest"),
    };
  }
  fail("POLICY_INVALID");
}

function parseLimits(value: unknown): ContributionResourceLimits {
  if (typeof value !== "object" || value === null) fail("POLICY_INVALID");
  const candidate = value as Record<string, unknown>;
  return {
    maxDestinations: parseBoundedCount(candidate.maxDestinations, "limits.maxDestinations", { min: 1 }),
    maxArtifacts: parseBoundedCount(candidate.maxArtifacts, "limits.maxArtifacts", { min: 0 }),
    maxArtifactBytes: parseBoundedCount(candidate.maxArtifactBytes, "limits.maxArtifactBytes", { min: 0 }),
    maxTotalArtifactBytes: parseBoundedCount(
      candidate.maxTotalArtifactBytes,
      "limits.maxTotalArtifactBytes",
      { min: 0 },
    ),
    maxManifestBytes: parseBoundedCount(candidate.maxManifestBytes, "limits.maxManifestBytes", { min: 0 }),
    maxConcurrentDestinations: parseBoundedCount(
      candidate.maxConcurrentDestinations,
      "limits.maxConcurrentDestinations",
      { min: 1 },
    ),
  };
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) fail("POLICY_INVALID");
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) fail("POLICY_INVALID");
    return entry;
  });
}

function parseFamilyArray(
  value: unknown,
): readonly ("execution-evidence" | "result-evaluation" | "execution-verification")[] {
  if (!Array.isArray(value)) fail("POLICY_INVALID");
  return value.map((entry) => {
    if (
      entry !== "execution-evidence" &&
      entry !== "result-evaluation" &&
      entry !== "execution-verification"
    ) {
      fail("POLICY_INVALID");
    }
    return entry;
  });
}

function parseVerifiedStandingGrant(
  raw: unknown,
  submission: StandingGrantSubmission,
): VerifiedStandingGrant {
  const snapshot = snapshotInertJsonValue(raw) as Record<string, unknown>;
  if (typeof snapshot !== "object" || snapshot === null) fail("POLICY_INVALID");
  const expiresAt = snapshot.expiresAt === undefined
    ? undefined
    : parseContributionTimestamp(snapshot.expiresAt, "expiresAt");
  const verified: VerifiedStandingGrant = {
    authorityId: parseAbsoluteIri(snapshot.authorityId, "authorityId"),
    actorId: (() => {
      if (typeof snapshot.actorId !== "string" || snapshot.actorId.length === 0) {
        fail("POLICY_INVALID");
      }
      return snapshot.actorId;
    })(),
    sourceScope: parseSourceScope(snapshot.sourceScope),
    allowedFamilies: parseFamilyArray(snapshot.allowedFamilies),
    policyAuthorityIds: parseStringArray(snapshot.policyAuthorityIds, "policyAuthorityIds"),
    policyProfiles: parseStringArray(snapshot.policyProfiles, "policyProfiles"),
    policyDigests: parseDigestArray(snapshot.policyDigests, "policyDigests"),
    implementationDigests: parseDigestArray(snapshot.implementationDigests, "implementationDigests"),
    derivationConfigurationDigests: parseDigestArray(
      snapshot.derivationConfigurationDigests,
      "derivationConfigurationDigests",
    ),
    destinationConfigurationDigests: parseDigestArray(
      snapshot.destinationConfigurationDigests,
      "destinationConfigurationDigests",
    ),
    limits: parseLimits(snapshot.limits),
    issuedAt: parseContributionTimestamp(snapshot.issuedAt, "issuedAt"),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    proofDigest: parseContributionDigest(snapshot.proofDigest, "proofDigest"),
  };
  if (verified.proofDigest !== submission.proofDigest) fail("POLICY_INVALID");
  return verified;
}

function parseVerifiedStandingGrantRevocation(
  raw: unknown,
  submission: StandingGrantRevocationSubmission,
): VerifiedStandingGrantRevocation {
  const snapshot = snapshotInertJsonValue(raw) as Record<string, unknown>;
  if (typeof snapshot !== "object" || snapshot === null) fail("POLICY_INVALID");
  const verified: VerifiedStandingGrantRevocation = {
    authorityId: parseAbsoluteIri(snapshot.authorityId, "authorityId"),
    actorId: (() => {
      if (typeof snapshot.actorId !== "string" || snapshot.actorId.length === 0) {
        fail("POLICY_INVALID");
      }
      return snapshot.actorId;
    })(),
    grantId: (() => {
      if (typeof snapshot.grantId !== "string" || snapshot.grantId.length === 0) {
        fail("POLICY_INVALID");
      }
      return snapshot.grantId;
    })(),
    expectedGrantVersion: parseBoundedCount(
      snapshot.expectedGrantVersion,
      "expectedGrantVersion",
      { min: 0 },
    ),
    revokedAt: parseContributionTimestamp(snapshot.revokedAt, "revokedAt"),
    reasonCode: parseSafeReasonCode(snapshot.reasonCode),
    proofDigest: parseContributionDigest(snapshot.proofDigest, "proofDigest"),
  };
  if (
    verified.grantId !== submission.grantId ||
    verified.proofDigest !== submission.proofDigest
  ) {
    fail("POLICY_INVALID");
  }
  return verified;
}

function toStandingAuthorizationGrantReadModel(
  versioned: VersionedStandingGrant,
): StandingAuthorizationGrantReadModel {
  const grant = versioned.value;
  return {
    schemaVersion: 1,
    grantId: grant.grantId,
    revision: versioned.revision,
    authorityId: grant.authorityId,
    sourceScope: grant.sourceScope,
    allowedFamilies: grant.allowedFamilies,
    destinationConfigurationDigests: grant.destinationConfigurationDigests,
    ...(grant.limits !== undefined ? { limits: grant.limits } : {}),
    issuedAt: grant.issuedAt,
    ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
    revoked: grant.revocations.length > 0,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}

/**
 * Verify and persist an explicit, scoped prospective standing-authorization
 * grant. The caller (user) deliberately chooses scope breadth; no scope is
 * ever inferred.
 */
export async function createStandingAuthorizationGrant(
  submission: StandingGrantSubmission,
  dependencies: ContributionGrantDependencies,
  options?: ContributionOperationOptions,
): Promise<StandingAuthorizationGrantReadModel> {
  requireProofDigestMatch(submission.proofBytes, submission.proofDigest);
  const forAuthority: StandingGrantSubmission = {
    ...submission,
    proofBytes: Uint8Array.from(submission.proofBytes),
  };
  const raw = await dependencies.authorization.verifyStandingGrant(
    forAuthority,
    toContributionCallOptions(options),
  );
  const verified = parseVerifiedStandingGrant(raw, submission);

  const now = dependencies.clock.now();
  const grantId = dependencies.identifiers.nextGrantId();
  const state: StandingAuthorizationGrantState = {
    schemaVersion: 1,
    grantId,
    authorityId: verified.authorityId,
    actorId: verified.actorId,
    sourceScope: verified.sourceScope,
    allowedFamilies: verified.allowedFamilies,
    policyAuthorityIds: verified.policyAuthorityIds,
    policyProfiles: verified.policyProfiles,
    policyDigests: verified.policyDigests,
    implementationDigests: verified.implementationDigests,
    derivationConfigurationDigests: verified.derivationConfigurationDigests,
    destinationConfigurationDigests: verified.destinationConfigurationDigests,
    limits: verified.limits,
    issuedAt: verified.issuedAt,
    ...(verified.expiresAt !== undefined ? { expiresAt: verified.expiresAt } : {}),
    revocations: [],
    createdAt: now,
    updatedAt: now,
  };
  const created = await dependencies.store.createGrant(state, options);
  return toStandingAuthorizationGrantReadModel(created);
}

/**
 * Append-only revocation of a standing grant. Revocation prevents any
 * not-yet-started match from applying; it never rewrites earlier history.
 */
export async function revokeStandingAuthorizationGrant(
  grantId: ContributionGrantId,
  submission: StandingGrantRevocationSubmission,
  dependencies: ContributionGrantDependencies,
  options?: ContributionOperationOptions,
): Promise<StandingAuthorizationGrantReadModel> {
  if (submission.grantId !== grantId) fail("INVALID_INPUT");
  requireProofDigestMatch(submission.proofBytes, submission.proofDigest);

  let versioned = await dependencies.store.loadGrant(grantId, options);
  if (versioned === null) fail("INVALID_INPUT");
  if (
    options?.expectedGrantRevision !== undefined &&
    options.expectedGrantRevision !== versioned.revision
  ) {
    fail("STORE_CONFLICT");
  }
  if (submission.expectedGrantVersion !== versioned.revision) {
    fail("STORE_CONFLICT");
  }

  const forAuthority: StandingGrantRevocationSubmission = {
    ...submission,
    proofBytes: Uint8Array.from(submission.proofBytes),
  };
  const raw = await dependencies.authorization.verifyStandingGrantRevocation(
    forAuthority,
    versioned.value,
    toContributionCallOptions(options),
  );
  const verified = parseVerifiedStandingGrantRevocation(raw, submission);

  const now = dependencies.clock.now();
  const nextState: StandingAuthorizationGrantState = {
    ...versioned.value,
    revocations: [
      ...versioned.value.revocations,
      { at: verified.revokedAt, reasonCode: verified.reasonCode },
    ],
    updatedAt: now,
  };
  versioned = await dependencies.store.compareAndSwapGrant(versioned, nextState, options);
  return toStandingAuthorizationGrantReadModel(versioned);
}

/**
 * Match a previously created, unrevoked, unexpired standing grant against a
 * request's prepared disclosure and authorize every destination it scopes.
 * Never matches `review-required` or `withheld` preparation (there is no
 * prepared manifest to match against). Host-scoped grants are checked by
 * `AuthorizationAuthority.evaluateHostScope`; every other check (family,
 * policy/implementation identity, destination configuration) is enforced by
 * core and never trusted to the port alone.
 */
export async function applyStandingAuthorization(
  requestId: ContributionRequestId,
  grantId: ContributionGrantId,
  dependencies: ContributionAuthorizationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel> {
  let versioned = await dependencies.store.loadRequest(requestId, options);
  if (versioned === null) fail("INVALID_INPUT");
  if (
    options?.expectedRequestRevision !== undefined &&
    options.expectedRequestRevision !== versioned.revision
  ) {
    fail("STORE_CONFLICT");
  }
  if (versioned.value.preparation.status !== "preview-ready") {
    fail("AUTHORIZATION_REQUIRED");
  }
  const manifest = versioned.value.preparation.disclosure.manifest;

  const grantVersioned = await dependencies.store.loadGrant(grantId, options);
  if (grantVersioned === null) fail("INVALID_INPUT");
  const grant = grantVersioned.value;

  const now = dependencies.clock.now();
  if (grant.expiresAt !== undefined && grant.expiresAt <= now) {
    fail("AUTHORIZATION_EXPIRED");
  }
  if (grant.revocations.length > 0) {
    fail("AUTHORIZATION_REVOKED");
  }

  if (grant.sourceScope.kind === "exact-source") {
    if (
      grant.sourceScope.source.family !== manifest.source.family ||
      grant.sourceScope.source.digest !== manifest.source.digest
    ) {
      fail("AUTHORIZATION_DENIED");
    }
  } else {
    const evaluation = await dependencies.authorization.evaluateHostScope(
      grant,
      versioned.value.proposal.hostContext ?? {},
      toContributionCallOptions(options),
    );
    if (!evaluation.matches) fail("AUTHORIZATION_DENIED");
  }

  if (!grant.allowedFamilies.includes(manifest.preparedRecord.family)) {
    fail("AUTHORIZATION_DENIED");
  }
  const preparation = manifest.preparation;
  if (preparation.kind === "derived" || preparation.kind === "publishable-unchanged") {
    if (
      !grant.policyDigests.includes(preparation.policyDigest) ||
      !grant.implementationDigests.includes(preparation.implementationDigest)
    ) {
      fail("AUTHORIZATION_DENIED");
    }
  }

  const decisionId = dependencies.identifiers.nextDecisionId();
  const events: {
    readonly schemaVersion: 1;
    readonly kind: "authorized";
    readonly at: string;
    readonly destination: string;
  }[] = [];
  let matchedAny = false;
  let nextDestinations = versioned.value.destinations;
  for (const prepared of manifest.destinations) {
    const destination = prepared.descriptor.destination;
    if (!grant.destinationConfigurationDigests.includes(prepared.descriptor.configurationDigest)) {
      continue;
    }
    matchedAny = true;
    nextDestinations = updateContributionDestinationState(
      nextDestinations,
      destination,
      (current) => ({
        ...current,
        authorization: { status: "authorized", decisionId, grantId },
      }),
    );
    events.push({ schemaVersion: 1, kind: "authorized", at: now, destination });
  }
  if (!matchedAny) fail("AUTHORIZATION_DENIED");

  const nextState: ContributionRequestState = appendCurrentContributionReceipt({
    ...versioned.value,
    destinations: nextDestinations,
    auditEvents: [...versioned.value.auditEvents, ...events],
    updatedAt: now,
  });
  versioned = await dependencies.store.compareAndSwapRequest(versioned, nextState, options);
  return toContributionReadModel(versioned);
}
