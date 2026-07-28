// SPDX-License-Identifier: Apache-2.0
import {
  EvidencePublicationError,
  hashExactBytes,
  normalizePublishInput,
  publish,
  type PublicationDependencies,
  type PublicationReceipt,
  type PublishArtifact,
  type PublishInput,
} from "@jinn-network/evidence-publication";
import { EvidenceRepositoryError } from "@jinn-network/evidence-repository";

import {
  toContributionReadModel,
  type ContributionCommandBaseDependencies,
  type ContributionPublicationDependencies,
} from "./commands.js";
import { EvidenceContributionError, type EvidenceContributionErrorCode } from "./errors.js";
import { compareCodeUnitStrings } from "./identities.js";
import { appendCurrentContributionReceipt } from "./receipt.js";
import type { RepositoryResolver } from "./source.js";
import {
  updateContributionDestinationState,
  type ContributionRequestState,
} from "./state.js";
import type {
  ContributionDestination,
  ContributionOperationOptions,
  ContributionReadModel,
  ContributionRequestId,
  ContributionSafeReasonCode,
  SafePublishedLocation,
} from "./types.js";
import { snapshotInertJsonValue } from "./validation.js";

function fail(code: EvidenceContributionErrorCode): never {
  throw new EvidenceContributionError(code);
}

// ---------------------------------------------------------------------------
// Destination resolution and optional availability withdrawal
// ---------------------------------------------------------------------------

export type AvailabilityWithdrawalResult =
  | {
      readonly status: "withdrawn";
      readonly externalId: string;
    }
  | {
      readonly status: "unsupported";
      readonly reasonCode: ContributionSafeReasonCode;
    }
  | {
      readonly status: "retryable-failure";
      readonly reasonCode: ContributionSafeReasonCode;
    };

/**
 * Optional, per-destination availability-withdrawal capability (design
 * §16). May retract only the current destination binding's availability
 * observation; it has no Repository delete method and never claims
 * deletion.
 */
export interface AvailabilityWithdrawal {
  deactivate(
    input: {
      readonly destination: ContributionDestination;
      readonly publicationReceipt: PublicationReceipt;
    },
    options?: ContributionOperationOptions,
  ): Promise<AvailabilityWithdrawalResult>;
}

export interface ResolvedPublicationDestination {
  readonly descriptor: ContributionDestination;
  readonly dependencies: PublicationDependencies;
  readonly projectLocations?: (
    receipt: PublicationReceipt,
  ) => readonly SafePublishedLocation[];
  readonly withdrawal?: AvailabilityWithdrawal;
}

export interface PublicationResolver {
  resolve(
    destination: ContributionDestination,
    options?: ContributionOperationOptions,
  ): Promise<ResolvedPublicationDestination>;
}

// ---------------------------------------------------------------------------
// Exact Publication input loading
// ---------------------------------------------------------------------------

/**
 * Load exact Publication input for one already-prepared, already-authorized
 * destination: the one prepared record and every manifest-listed artifact,
 * from the request's staging Repository only. Normalizes through
 * Publication and rejects if the derived `bundleKey`/`payloadFingerprint`
 * disagree with the manifest's precomputed identities for this destination
 * -- Publication's identity algorithm is never re-derived independently.
 */
export async function loadAuthorizedPublishInput(
  state: ContributionRequestState,
  destination: ContributionDestination,
  repositories: RepositoryResolver,
  options?: ContributionOperationOptions,
): Promise<PublishInput> {
  if (state.preparation.status !== "preview-ready") fail("INVALID_INPUT");
  const manifest = state.preparation.disclosure.manifest;
  const prepared = manifest.destinations.find(
    (candidate) => candidate.descriptor.destination === destination.destination,
  );
  if (prepared === undefined) fail("DESTINATION_UNSUPPORTED");
  if (prepared.descriptor.configurationDigest !== destination.configurationDigest) {
    fail("DESTINATION_CONFLICT");
  }

  const staging = await repositories.resolve(
    state.proposal.stagingRepositoryBindingId,
    options,
  );
  const recordBytes = await staging.getRecord(manifest.preparedRecord, options);
  if (recordBytes === null) fail("SOURCE_NOT_FOUND");
  const recordSnapshot = Uint8Array.from(recordBytes);
  if (hashExactBytes(recordSnapshot) !== manifest.preparedRecord.digest) {
    fail("SOURCE_DIGEST_MISMATCH");
  }

  const artifacts: PublishArtifact[] = [];
  for (const reference of manifest.artifacts) {
    const bytes = await staging.getArtifact(reference, options);
    if (bytes === null) fail("SOURCE_NOT_FOUND");
    const snapshot = Uint8Array.from(bytes);
    if (hashExactBytes(snapshot) !== reference.digest) fail("SOURCE_DIGEST_MISMATCH");
    artifacts.push({ reference, bytes: snapshot });
  }

  const input: PublishInput = {
    records: [{ reference: manifest.preparedRecord, bytes: recordSnapshot }],
    artifacts,
    destination: destination.destination,
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  };
  const normalized = normalizePublishInput(input);
  if (
    normalized.bundleKey !== prepared.bundleKey ||
    normalized.payloadFingerprint !== prepared.payloadFingerprint
  ) {
    fail("PORT_PROTOCOL_VIOLATION");
  }
  return input;
}

// ---------------------------------------------------------------------------
// Authorization currency check
// ---------------------------------------------------------------------------

async function assertDestinationCurrentlyAuthorized(
  state: ContributionRequestState,
  destination: string,
  dependencies: Pick<ContributionCommandBaseDependencies, "store" | "clock">,
  options?: ContributionOperationOptions,
): Promise<void> {
  const destinationState = state.destinations.find(
    (candidate) => candidate.destination === destination,
  );
  if (destinationState === undefined) fail("DESTINATION_UNSUPPORTED");
  if (destinationState.authorization.status !== "authorized") {
    fail("AUTHORIZATION_REQUIRED");
  }
  const now = dependencies.clock.now();
  const { decisionId, grantId } = destinationState.authorization;
  if (decisionId !== undefined) {
    const entry = state.authorizationDecisions.find((candidate) =>
      candidate.decisionId === decisionId);
    if (entry?.decision.expiresAt !== undefined && entry.decision.expiresAt <= now) {
      fail("AUTHORIZATION_EXPIRED");
    }
  }
  if (grantId !== undefined) {
    const grantVersioned = await dependencies.store.loadGrant(grantId, options);
    if (grantVersioned === null) fail("AUTHORIZATION_REVOKED");
    if (grantVersioned.value.revocations.length > 0) fail("AUTHORIZATION_REVOKED");
    if (grantVersioned.value.expiresAt !== undefined && grantVersioned.value.expiresAt <= now) {
      fail("AUTHORIZATION_EXPIRED");
    }
  }
}

// ---------------------------------------------------------------------------
// Failure classification
//
// Upstream Publication/Repository errors are never forwarded to stored or
// returned state -- only a safe reason code selected from the closed
// vocabulary. Aborts and state-integrity-shaped codes (a corrupt journal,
// an invalid port response) are rethrown rather than silently recorded as a
// per-destination outcome, matching the design's failure table: those are
// "fail closed for operator attention", not a retryable/terminal
// destination result.
// ---------------------------------------------------------------------------

interface ClassifiedPublicationFailure {
  readonly status: "retryable-failure" | "terminal-failure";
  readonly reasonCode: ContributionSafeReasonCode;
}

function classifyPublicationFailure(
  cause: unknown,
): ClassifiedPublicationFailure | undefined {
  if (cause instanceof EvidencePublicationError) {
    switch (cause.code) {
      case "JOURNAL_CONFLICT":
      case "IDEMPOTENCY_CONFLICT":
      case "PLACEMENT_UNCERTAIN":
      case "IO_FAILURE":
        return { status: "retryable-failure", reasonCode: "ACCESS_DENIED" };
      case "CONTENT_DIGEST_MISMATCH":
      case "BUNDLE_CONFLICT":
      case "FRAME_TOO_LARGE":
      case "REPOSITORY_CAPABILITY_EXCEEDED":
      case "PLACEMENT_REVERTED":
        return { status: "terminal-failure", reasonCode: "BINDING_LIMIT_EXCEEDED" };
      default:
        return undefined;
    }
  }
  if (cause instanceof EvidenceRepositoryError) {
    switch (cause.code) {
      case "ACCESS_DENIED":
      case "DEPENDENCY_UNAVAILABLE":
      case "IO_FAILURE":
        return { status: "retryable-failure", reasonCode: "ACCESS_DENIED" };
      case "CONTENT_TOO_LARGE":
        return { status: "terminal-failure", reasonCode: "BINDING_LIMIT_EXCEEDED" };
      default:
        return undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Destination projection safety
// ---------------------------------------------------------------------------

function safeLocations(
  resolved: ResolvedPublicationDestination,
  receipt: PublicationReceipt,
): readonly SafePublishedLocation[] {
  if (resolved.projectLocations === undefined) return [];
  const projected = resolved.projectLocations(receipt);
  if (!Array.isArray(projected)) fail("PORT_PROTOCOL_VIOLATION");
  return projected.map((location) => {
    const snapshot = snapshotInertJsonValue(location) as { profile?: unknown; value?: unknown };
    if (typeof snapshot.profile !== "string" || snapshot.profile.length === 0) {
      fail("PORT_PROTOCOL_VIOLATION");
    }
    if (typeof snapshot.value !== "string") fail("PORT_PROTOCOL_VIOLATION");
    return { profile: snapshot.profile, value: snapshot.value };
  });
}

// ---------------------------------------------------------------------------
// Single-destination Publication operation
// ---------------------------------------------------------------------------

/**
 * Publish one already-authorized destination through the existing
 * Publication package. Idempotent and interruption-safe: a not-started
 * destination is checkpointed to `publishing` (with the destination's exact
 * `bundleKey`/`payloadFingerprint`) before any Publication I/O, and an
 * already-`publishing` destination resumes the same operation identity
 * rather than checkpointing again. A classified Publication/Repository
 * failure updates the destination to `retryable-failure` or
 * `terminal-failure` and returns normally (it does not throw) so a caller
 * driving several destinations can continue past one failure.
 */
export async function publishContributionDestination(
  requestId: ContributionRequestId,
  destination: string,
  dependencies: ContributionPublicationDependencies,
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
  if (versioned.value.preparation.status !== "preview-ready") fail("INVALID_INPUT");

  const manifest = versioned.value.preparation.disclosure.manifest;
  const prepared = manifest.destinations.find(
    (candidate) => candidate.descriptor.destination === destination,
  );
  if (prepared === undefined) fail("DESTINATION_UNSUPPORTED");

  const existing = versioned.value.destinations.find(
    (candidate) => candidate.destination === destination,
  );
  if (existing === undefined) fail("DESTINATION_UNSUPPORTED");
  if (existing.publication.status === "published") {
    return toContributionReadModel(versioned);
  }
  if (existing.deactivation.requested && existing.publication.status === "not-started") {
    fail("DEACTIVATION_UNSUPPORTED");
  }

  await assertDestinationCurrentlyAuthorized(versioned.value, destination, dependencies, options);

  const resolved = await dependencies.publications.resolve(prepared.descriptor, options);
  if (
    resolved.descriptor.destination !== prepared.descriptor.destination ||
    resolved.descriptor.configurationDigest !== prepared.descriptor.configurationDigest
  ) {
    fail("PORT_PROTOCOL_VIOLATION");
  }

  const input = await loadAuthorizedPublishInput(
    versioned.value,
    prepared.descriptor,
    dependencies.repositories,
    options,
  );

  if (existing.publication.status === "not-started" || existing.publication.status === "retryable-failure") {
    const now = dependencies.clock.now();
    const checkpointed: ContributionRequestState = {
      ...versioned.value,
      destinations: updateContributionDestinationState(
        versioned.value.destinations,
        destination,
        () => ({
          destination,
          authorization: existing.authorization,
          publication: {
            status: "publishing",
            bundleKey: prepared.bundleKey,
            payloadFingerprint: prepared.payloadFingerprint,
          },
          deactivation: existing.deactivation,
        }),
      ),
      auditEvents: [
        ...versioned.value.auditEvents,
        { schemaVersion: 1, kind: "publication-started" as const, at: now, destination },
      ],
      updatedAt: now,
    };
    versioned = await dependencies.store.compareAndSwapRequest(versioned, checkpointed, options);
  }

  let receipt: PublicationReceipt;
  try {
    receipt = await publish(input, resolved.dependencies);
  } catch (cause) {
    const classified = classifyPublicationFailure(cause);
    if (classified === undefined) throw cause;
    const now = dependencies.clock.now();
    const failedState: ContributionRequestState = appendCurrentContributionReceipt({
      ...versioned.value,
      destinations: updateContributionDestinationState(
        versioned.value.destinations,
        destination,
        (current) => ({
          ...current,
          publication: classified,
        }),
      ),
      auditEvents: [
        ...versioned.value.auditEvents,
        {
          schemaVersion: 1,
          kind: "publication-failed" as const,
          at: now,
          destination,
          reasonCode: classified.reasonCode,
        },
      ],
      updatedAt: now,
    });
    versioned = await dependencies.store.compareAndSwapRequest(versioned, failedState, options);
    return toContributionReadModel(versioned);
  }

  if (
    receipt.bundleKey !== prepared.bundleKey ||
    receipt.payloadFingerprint !== prepared.payloadFingerprint ||
    receipt.completed !== true
  ) {
    fail("PORT_PROTOCOL_VIOLATION");
  }

  const locations = safeLocations(resolved, receipt);
  const publishedAt = dependencies.clock.now();
  const publishedState: ContributionRequestState = appendCurrentContributionReceipt({
    ...versioned.value,
    destinations: updateContributionDestinationState(
      versioned.value.destinations,
      destination,
      (current) => ({
        ...current,
        publication: {
          status: "published",
          publishedAt,
          bundleKey: receipt.bundleKey,
          payloadFingerprint: receipt.payloadFingerprint,
          locations,
        },
      }),
    ),
    auditEvents: [
      ...versioned.value.auditEvents,
      { schemaVersion: 1, kind: "published" as const, at: publishedAt, destination },
    ],
    updatedAt: publishedAt,
  });
  versioned = await dependencies.store.compareAndSwapRequest(versioned, publishedState, options);
  return toContributionReadModel(versioned);
}

// ---------------------------------------------------------------------------
// Multi-destination resume / retry
// ---------------------------------------------------------------------------

/**
 * Advance every currently-eligible destination (authorized and not yet
 * settled) in deterministic destination-IRI order, continuing past a
 * classified per-destination failure. Safe to call repeatedly: it never
 * re-derives a different Publication operation identity for an
 * already-checkpointed destination.
 */
export async function resumeContribution(
  requestId: ContributionRequestId,
  dependencies: ContributionPublicationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel> {
  const initial = await dependencies.store.loadRequest(requestId, options);
  if (initial === null) fail("INVALID_INPUT");
  if (initial.value.preparation.status !== "preview-ready") {
    return toContributionReadModel(initial);
  }

  const eligible = initial.value.destinations
    .filter((candidate) =>
      !candidate.deactivation.requested &&
      candidate.authorization.status === "authorized" &&
      (
        candidate.publication.status === "not-started" ||
        candidate.publication.status === "publishing" ||
        candidate.publication.status === "retryable-failure"
      ))
    .map((candidate) => candidate.destination)
    .slice()
    .sort(compareCodeUnitStrings);

  let latest = toContributionReadModel(initial);
  for (const destination of eligible) {
    latest = await publishContributionDestination(requestId, destination, dependencies, options);
  }
  return latest;
}

/**
 * Re-enter the same exact Publication operation for a destination currently
 * `retryable-failure` or interrupted mid-`publishing`. Rejects any other
 * destination status with `DESTINATION_CONFLICT`.
 */
export async function retryContributionDestination(
  requestId: ContributionRequestId,
  destination: string,
  dependencies: ContributionPublicationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel> {
  const versioned = await dependencies.store.loadRequest(requestId, options);
  if (versioned === null) fail("INVALID_INPUT");
  const destinationState = versioned.value.destinations.find(
    (candidate) => candidate.destination === destination,
  );
  if (destinationState === undefined) fail("DESTINATION_UNSUPPORTED");
  if (
    destinationState.publication.status !== "retryable-failure" &&
    destinationState.publication.status !== "publishing"
  ) {
    fail("DESTINATION_CONFLICT");
  }
  return publishContributionDestination(requestId, destination, dependencies, options);
}
