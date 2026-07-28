// SPDX-License-Identifier: Apache-2.0
import type { PublicationReceipt } from "@jinn-network/evidence-publication";

import {
  toContributionReadModel,
  type ContributionCloseoutDependencies,
} from "./commands.js";
import { EvidenceContributionError, type EvidenceContributionErrorCode } from "./errors.js";
import { compareCodeUnitStrings } from "./identities.js";
import { publishContributionDestination } from "./publication.js";
import { appendCurrentContributionReceipt } from "./receipt.js";
import {
  updateContributionDestinationState,
  type ContributionRequestState,
} from "./state.js";
import type {
  ContributionOperationOptions,
  ContributionReadModel,
  ContributionRequestId,
  ContributionSafeReasonCode,
} from "./types.js";
import { toContributionCallOptions } from "./types.js";

// The optional availability-withdrawal capability
// (`AvailabilityWithdrawal` / `AvailabilityWithdrawalResult`) is owned by
// `publication.ts` -- `ResolvedPublicationDestination` resolves it per
// destination alongside Publication dependencies, so closeout uses the
// exact same resolved binding, never an independent resolver that could
// target a different destination. Both types are already exported at the
// package root via `publication.js`.

function fail(code: EvidenceContributionErrorCode): never {
  throw new EvidenceContributionError(code);
}

/**
 * Decline before any external Publication effect exists. Valid only from
 * `proposed`, or from `preview-ready` while every destination remains
 * `not-started`; once any destination has begun Publication, decline is
 * rejected in favor of deactivation (design §16/§18.2).
 */
export async function declineContribution(
  requestId: ContributionRequestId,
  input: {
    readonly actorId: string;
    readonly reasonCode: ContributionSafeReasonCode;
  },
  dependencies: ContributionCloseoutDependencies,
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
  const preparation = versioned.value.preparation;
  if (preparation.status === "declined") {
    return toContributionReadModel(versioned);
  }
  if (preparation.status !== "proposed" && preparation.status !== "preview-ready") {
    fail("INVALID_INPUT");
  }
  if (
    preparation.status === "preview-ready" &&
    versioned.value.destinations.some((destination) =>
      destination.publication.status !== "not-started")
  ) {
    fail("DESTINATION_CONFLICT");
  }

  const now = dependencies.clock.now();
  const nextState: ContributionRequestState = appendCurrentContributionReceipt({
    ...versioned.value,
    preparation: { status: "declined", declinedAt: now, reasonCode: input.reasonCode },
    auditEvents: [
      ...versioned.value.auditEvents,
      { schemaVersion: 1, kind: "declined" as const, at: now, reasonCode: input.reasonCode },
    ],
    updatedAt: now,
  });
  versioned = await dependencies.store.compareAndSwapRequest(versioned, nextState, options);
  return toContributionReadModel(versioned);
}

/**
 * Deactivate one destination: record that no new external effect may
 * begin, finish reconciling an already-started Publication through the
 * same already-checkpointed operation, then attempt the optional
 * availability-withdrawal capability where the resolved binding supports
 * it. Never claims deletion; a source can never retract another source's
 * availability observation, and local staging deletion is never attempted.
 */
export async function deactivateContributionDestination(
  requestId: ContributionRequestId,
  destination: string,
  dependencies: ContributionCloseoutDependencies,
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
  const existing = versioned.value.destinations.find(
    (candidate) => candidate.destination === destination,
  );
  if (existing === undefined) fail("DESTINATION_UNSUPPORTED");

  if (!existing.deactivation.requested) {
    const now = dependencies.clock.now();
    const requestedState: ContributionRequestState = appendCurrentContributionReceipt({
      ...versioned.value,
      destinations: updateContributionDestinationState(
        versioned.value.destinations,
        destination,
        (current) => ({
          ...current,
          deactivation: { requested: true, requestedAt: now },
        }),
      ),
      auditEvents: [
        ...versioned.value.auditEvents,
        { schemaVersion: 1, kind: "deactivated" as const, at: now, destination },
      ],
      updatedAt: now,
    });
    versioned = await dependencies.store.compareAndSwapRequest(versioned, requestedState, options);
  }

  // Reconcile an already-started Publication through the very same
  // operation before attempting withdrawal -- an interrupted `publishing`
  // destination may already have an external effect. Only `signal` crosses
  // into this nested call: the checkpoint above may have already advanced
  // the store revision past whatever `expectedRequestRevision` the caller
  // supplied (already gated once, above), so forwarding it here would
  // spuriously fail the reconciliation.
  if (versioned.value.destinations.find((c) => c.destination === destination)?.publication.status
      === "publishing") {
    await publishContributionDestination(
      requestId,
      destination,
      dependencies,
      toContributionCallOptions(options),
    );
    const reloaded = await dependencies.store.loadRequest(requestId, options);
    if (reloaded !== null) versioned = reloaded;
  }

  const prepared = manifest.destinations.find(
    (candidate) => candidate.descriptor.destination === destination,
  );
  const current = versioned.value.destinations.find((c) => c.destination === destination);
  if (prepared === undefined || current === undefined) fail("DESTINATION_UNSUPPORTED");
  if (current.deactivation.outcome !== undefined) {
    return toContributionReadModel(versioned);
  }
  if (current.publication.status !== "published") {
    // No confirmed external effect yet to withdraw; deactivation is
    // already fully recorded by the not-started checkpoint above.
    return toContributionReadModel(versioned);
  }

  const resolved = await dependencies.publications.resolve(
    prepared.descriptor,
    toContributionCallOptions(options),
  );
  const now = dependencies.clock.now();
  if (resolved.withdrawal === undefined) {
    const unsupportedState: ContributionRequestState = appendCurrentContributionReceipt({
      ...versioned.value,
      destinations: updateContributionDestinationState(
        versioned.value.destinations,
        destination,
        (c) => ({
          ...c,
          deactivation: {
            ...c.deactivation,
            outcome: { status: "unsupported", reasonCode: "WITHDRAWAL_UNSUPPORTED" },
          },
        }),
      ),
      updatedAt: now,
    });
    versioned = await dependencies.store.compareAndSwapRequest(versioned, unsupportedState, options);
    return toContributionReadModel(versioned);
  }

  const publicationReceipt: PublicationReceipt = {
    bundleKey: current.publication.bundleKey,
    payloadFingerprint: current.publication.payloadFingerprint,
    destination,
    artifacts: manifest.artifacts,
    records: [manifest.preparedRecord],
    placements: [],
    completed: true,
  };
  const result = await resolved.withdrawal.deactivate(
    { destination: prepared.descriptor, publicationReceipt },
    toContributionCallOptions(options),
  );
  const finalState: ContributionRequestState = appendCurrentContributionReceipt({
    ...versioned.value,
    destinations: updateContributionDestinationState(
      versioned.value.destinations,
      destination,
      (c) => ({ ...c, deactivation: { ...c.deactivation, outcome: result } }),
    ),
    updatedAt: now,
  });
  versioned = await dependencies.store.compareAndSwapRequest(versioned, finalState, options);
  return toContributionReadModel(versioned);
}

/**
 * Deactivate every destination on a request.
 */
export async function deactivateContribution(
  requestId: ContributionRequestId,
  dependencies: ContributionCloseoutDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel> {
  const initial = await dependencies.store.loadRequest(requestId, options);
  if (initial === null) fail("INVALID_INPUT");
  if (
    options?.expectedRequestRevision !== undefined &&
    options.expectedRequestRevision !== initial.revision
  ) {
    fail("STORE_CONFLICT");
  }
  if (initial.value.preparation.status !== "preview-ready") fail("INVALID_INPUT");
  let latest = toContributionReadModel(initial);
  const destinations = [...initial.value.destinations]
    .map((d) => d.destination)
    .sort(compareCodeUnitStrings);
  // Only `signal` crosses into each per-destination call -- the caller's
  // `expectedRequestRevision` is gated exactly once, above; see
  // `resumeContribution` in publication.ts for the identical reasoning.
  const nestedOptions = toContributionCallOptions(options);
  for (const destination of destinations) {
    latest = await deactivateContributionDestination(requestId, destination, dependencies, nestedOptions);
  }
  return latest;
}
