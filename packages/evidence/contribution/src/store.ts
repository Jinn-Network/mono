// SPDX-License-Identifier: Apache-2.0
import { EvidenceContributionError } from "./errors.js";
import {
  assertValidPreparationTransition,
  type ContributionRequestState,
  type StandingAuthorizationGrantState,
} from "./state.js";
import type {
  ContributionGrantId,
  ContributionOperationOptions,
  ContributionRequestId,
} from "./types.js";

export interface VersionedContributionRequest {
  readonly revision: number;
  readonly value: ContributionRequestState;
}

export interface VersionedStandingGrant {
  readonly revision: number;
  readonly value: StandingAuthorizationGrantState;
}

export interface ContributionStore {
  loadRequest(
    requestId: ContributionRequestId,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest | null>;
  findRequestByIdempotencyKey(
    idempotencyKey: string,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest | null>;
  createRequest(
    state: ContributionRequestState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest>;
  compareAndSwapRequest(
    expected: VersionedContributionRequest,
    next: ContributionRequestState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest>;
  loadGrant(
    grantId: ContributionGrantId,
    options?: ContributionOperationOptions,
  ): Promise<VersionedStandingGrant | null>;
  createGrant(
    state: StandingAuthorizationGrantState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedStandingGrant>;
  compareAndSwapGrant(
    expected: VersionedStandingGrant,
    next: StandingAuthorizationGrantState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedStandingGrant>;
}

function fail(code: "STORE_CORRUPT" | "STORE_CONFLICT"): never {
  throw new EvidenceContributionError(code);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validate that `next` is a safe compare-and-swap successor to `previous`
 * for the same request: immutable fields are unchanged, append-only
 * histories are only ever extended (never rewritten or truncated), and the
 * preparation-facet transition is one of the fixed allowed edges.
 *
 * Any backing `ContributionStore` implementation should call this (or
 * equivalent logic) before accepting a write.
 */
export function assertSafeContributionRequestTransition(
  previous: ContributionRequestState,
  next: ContributionRequestState,
): void {
  if (next.schemaVersion !== 1) fail("STORE_CORRUPT");
  if (next.requestId !== previous.requestId) fail("STORE_CORRUPT");
  if (!deepEqual(next.proposal, previous.proposal)) fail("STORE_CORRUPT");
  if (next.proposalFingerprint !== previous.proposalFingerprint) fail("STORE_CORRUPT");
  if (next.idempotencyKey !== previous.idempotencyKey) fail("STORE_CORRUPT");
  if (next.createdAt !== previous.createdAt) fail("STORE_CORRUPT");
  if (
    previous.sealedIntent !== undefined &&
    !deepEqual(next.sealedIntent, previous.sealedIntent)
  ) {
    fail("STORE_CORRUPT");
  }
  if (previous.preparation.status !== next.preparation.status) {
    assertValidPreparationTransition(
      previous.preparation.status,
      next.preparation.status,
    );
  }
  if (
    previous.destinations.length > 0 &&
    (
      next.destinations.length !== previous.destinations.length ||
      previous.destinations.some((destination, index) =>
        destination.destination !== next.destinations[index]?.destination)
    )
  ) {
    fail("STORE_CORRUPT");
  }
  if (
    next.auditEvents.length < previous.auditEvents.length ||
    previous.auditEvents.some((event, index) =>
      !deepEqual(event, next.auditEvents[index]))
  ) {
    fail("STORE_CORRUPT");
  }
  if (
    next.receipts.length < previous.receipts.length ||
    previous.receipts.some((entry, index) =>
      !deepEqual(entry, next.receipts[index]))
  ) {
    fail("STORE_CORRUPT");
  }
  if (next.updatedAt < previous.updatedAt) fail("STORE_CORRUPT");
}

/**
 * Validate that `next` is a safe compare-and-swap successor to `previous`
 * for the same standing grant: immutable fields are unchanged and the
 * revocation history is append-only.
 */
export function assertSafeStandingGrantTransition(
  previous: StandingAuthorizationGrantState,
  next: StandingAuthorizationGrantState,
): void {
  if (next.schemaVersion !== 1) fail("STORE_CORRUPT");
  if (next.grantId !== previous.grantId) fail("STORE_CORRUPT");
  if (!deepEqual(next.sourceScope, previous.sourceScope)) fail("STORE_CORRUPT");
  if (next.authorityId !== previous.authorityId) fail("STORE_CORRUPT");
  if (next.actorId !== previous.actorId) fail("STORE_CORRUPT");
  if (next.createdAt !== previous.createdAt) fail("STORE_CORRUPT");
  if (
    next.revocations.length < previous.revocations.length ||
    previous.revocations.some((entry, index) =>
      !deepEqual(entry, next.revocations[index]))
  ) {
    fail("STORE_CORRUPT");
  }
  if (next.updatedAt < previous.updatedAt) fail("STORE_CORRUPT");
}
