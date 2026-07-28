// SPDX-License-Identifier: Apache-2.0
import { EvidenceContributionError } from "./errors.js";
import {
  assertSafeContributionRequestTransition,
  assertSafeStandingGrantTransition,
  type ContributionStore,
  type VersionedContributionRequest,
  type VersionedStandingGrant,
} from "./store.js";
import type {
  ContributionRequestState,
  StandingAuthorizationGrantState,
} from "./state.js";
import type {
  ContributionGrantId,
  ContributionOperationOptions,
  ContributionRequestId,
} from "./types.js";

function assertOperationActive(options?: ContributionOperationOptions): void {
  if (options?.signal?.aborted) {
    throw new EvidenceContributionError("OPERATION_ABORTED");
  }
}

function cloneRequestState(
  state: ContributionRequestState,
): ContributionRequestState {
  return structuredClone(state);
}

function cloneGrantState(
  state: StandingAuthorizationGrantState,
): StandingAuthorizationGrantState {
  return structuredClone(state);
}

function cloneVersionedRequest(
  versioned: VersionedContributionRequest,
): VersionedContributionRequest {
  return { revision: versioned.revision, value: cloneRequestState(versioned.value) };
}

function cloneVersionedGrant(
  versioned: VersionedStandingGrant,
): VersionedStandingGrant {
  return { revision: versioned.revision, value: cloneGrantState(versioned.value) };
}

export interface InMemoryContributionStoreCounters {
  readonly loadRequest: number;
  readonly findRequestByIdempotencyKey: number;
  readonly createRequest: number;
  readonly compareAndSwapRequest: number;
  readonly loadGrant: number;
  readonly createGrant: number;
  readonly compareAndSwapGrant: number;
}

/**
 * Effect-free in-memory `ContributionStore` for contract and unit tests.
 * Clones every value crossing its boundary (in both directions) so callers
 * can never mutate durable state by holding a reference, enforces exact
 * compare-and-swap revisions, and exposes read-only operation counters.
 */
export class InMemoryContributionStore implements ContributionStore {
  readonly #requests = new Map<ContributionRequestId, VersionedContributionRequest>();
  readonly #byIdempotencyKey = new Map<string, ContributionRequestId>();
  readonly #grants = new Map<ContributionGrantId, VersionedStandingGrant>();
  readonly #counters = {
    loadRequest: 0,
    findRequestByIdempotencyKey: 0,
    createRequest: 0,
    compareAndSwapRequest: 0,
    loadGrant: 0,
    createGrant: 0,
    compareAndSwapGrant: 0,
  };

  get counters(): InMemoryContributionStoreCounters {
    return { ...this.#counters };
  }

  async loadRequest(
    requestId: ContributionRequestId,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest | null> {
    assertOperationActive(options);
    this.#counters.loadRequest += 1;
    const entry = this.#requests.get(requestId);
    return entry === undefined ? null : cloneVersionedRequest(entry);
  }

  async findRequestByIdempotencyKey(
    idempotencyKey: string,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest | null> {
    assertOperationActive(options);
    this.#counters.findRequestByIdempotencyKey += 1;
    const requestId = this.#byIdempotencyKey.get(idempotencyKey);
    if (requestId === undefined) return null;
    const entry = this.#requests.get(requestId);
    return entry === undefined ? null : cloneVersionedRequest(entry);
  }

  async createRequest(
    state: ContributionRequestState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest> {
    assertOperationActive(options);
    this.#counters.createRequest += 1;
    if (this.#requests.has(state.requestId)) {
      throw new EvidenceContributionError("STORE_CONFLICT");
    }
    const versioned: VersionedContributionRequest = {
      revision: 1,
      value: cloneRequestState(state),
    };
    this.#requests.set(state.requestId, versioned);
    if (state.idempotencyKey !== undefined) {
      this.#byIdempotencyKey.set(state.idempotencyKey, state.requestId);
    }
    return cloneVersionedRequest(versioned);
  }

  async compareAndSwapRequest(
    expected: VersionedContributionRequest,
    next: ContributionRequestState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest> {
    assertOperationActive(options);
    this.#counters.compareAndSwapRequest += 1;
    const current = this.#requests.get(expected.value.requestId);
    if (current === undefined || current.revision !== expected.revision) {
      throw new EvidenceContributionError("STORE_CONFLICT");
    }
    assertSafeContributionRequestTransition(current.value, next);
    const versioned: VersionedContributionRequest = {
      revision: current.revision + 1,
      value: cloneRequestState(next),
    };
    this.#requests.set(next.requestId, versioned);
    if (next.idempotencyKey !== undefined) {
      this.#byIdempotencyKey.set(next.idempotencyKey, next.requestId);
    }
    return cloneVersionedRequest(versioned);
  }

  async loadGrant(
    grantId: ContributionGrantId,
    options?: ContributionOperationOptions,
  ): Promise<VersionedStandingGrant | null> {
    assertOperationActive(options);
    this.#counters.loadGrant += 1;
    const entry = this.#grants.get(grantId);
    return entry === undefined ? null : cloneVersionedGrant(entry);
  }

  async createGrant(
    state: StandingAuthorizationGrantState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedStandingGrant> {
    assertOperationActive(options);
    this.#counters.createGrant += 1;
    if (this.#grants.has(state.grantId)) {
      throw new EvidenceContributionError("STORE_CONFLICT");
    }
    const versioned: VersionedStandingGrant = {
      revision: 1,
      value: cloneGrantState(state),
    };
    this.#grants.set(state.grantId, versioned);
    return cloneVersionedGrant(versioned);
  }

  async compareAndSwapGrant(
    expected: VersionedStandingGrant,
    next: StandingAuthorizationGrantState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedStandingGrant> {
    assertOperationActive(options);
    this.#counters.compareAndSwapGrant += 1;
    const current = this.#grants.get(expected.value.grantId);
    if (current === undefined || current.revision !== expected.revision) {
      throw new EvidenceContributionError("STORE_CONFLICT");
    }
    assertSafeStandingGrantTransition(current.value, next);
    const versioned: VersionedStandingGrant = {
      revision: current.revision + 1,
      value: cloneGrantState(next),
    };
    this.#grants.set(next.grantId, versioned);
    return cloneVersionedGrant(versioned);
  }
}
