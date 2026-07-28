// SPDX-License-Identifier: Apache-2.0
import { hashExactBytes } from "@jinn-network/evidence-publication";
import type {
  AnnouncementSink,
  PublicationDependencies,
  PublicationJournalStore,
} from "@jinn-network/evidence-publication";
import {
  InMemoryAnnouncementSink,
  InMemoryPublicationJournalStore,
} from "@jinn-network/evidence-publication/testing";
import {
  createBuiltinDerivationDetectors,
  createEvidenceDeriver,
} from "@jinn-network/evidence-derivation";
import type { EvidenceDeriver } from "@jinn-network/evidence-derivation";
import { createSyntheticPrivateDetectorConfiguration } from "@jinn-network/evidence-derivation/testing";
import type { EvidenceRepository, Sha256Digest } from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";

import {
  authorizeContribution,
  createStandingAuthorizationGrant,
  revokeStandingAuthorizationGrant,
  applyStandingAuthorization,
  type AuthorizationAuthority,
} from "./authorization.js";
import {
  createContributionRequest,
  inspectContribution,
  prepareContribution,
  type ContributionClock,
  type ContributionIdentifierSource,
} from "./commands.js";
import {
  declineContribution,
  deactivateContribution,
  deactivateContributionDestination,
} from "./deactivation.js";
import { EvidenceContributionError } from "./errors.js";
import type { DerivationResolver, DisclosurePolicyAuthority, ReviewReferenceStore } from
  "./policy.js";
import {
  publishContributionDestination,
  resumeContribution,
  retryContributionDestination,
  type AvailabilityWithdrawal,
  type AvailabilityWithdrawalResult,
  type PublicationResolver,
  type ResolvedPublicationDestination,
} from "./publication.js";
import { readContributionReceipt } from "./receipt.js";
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
  DisclosurePolicyDecisionReference,
  SafePublishedLocation,
  VerifiedDisclosurePolicyDecision,
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

// ---------------------------------------------------------------------------
// Deterministic clock / identifier sources
// ---------------------------------------------------------------------------

/** A manually-advanced deterministic clock for reproducible tests. */
export interface DeterministicContributionClock extends ContributionClock {
  advance(milliseconds: number): void;
}

export function createDeterministicContributionClock(
  startIso: string,
): DeterministicContributionClock {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current).toISOString(),
    advance(milliseconds: number) {
      current += milliseconds;
    },
  };
}

export function createSequentialContributionIdentifiers(
  prefix: string,
): ContributionIdentifierSource {
  let requestCounter = 0;
  let decisionCounter = 0;
  let grantCounter = 0;
  let workerCounter = 0;
  return {
    nextRequestId: () => `${prefix}-request-${(requestCounter += 1)}`,
    nextDecisionId: () => `${prefix}-decision-${(decisionCounter += 1)}`,
    nextGrantId: () => `${prefix}-grant-${(grantCounter += 1)}`,
    nextWorkerId: () => `${prefix}-worker-${(workerCounter += 1)}`,
  };
}

// ---------------------------------------------------------------------------
// Disclosure-policy authority double
// ---------------------------------------------------------------------------

/**
 * A `DisclosurePolicyAuthority` double driven by a caller-registered map
 * from `decisionId` to a verified route. Deliberately strict: an
 * unregistered decision ID is `POLICY_DENIED`, matching a real authority
 * that never invents a decision it was not configured with.
 */
export class RegisteredDisclosurePolicyAuthority implements DisclosurePolicyAuthority {
  readonly #routes = new Map<string, VerifiedDisclosurePolicyDecision>();

  register(route: VerifiedDisclosurePolicyDecision): void {
    this.#routes.set(route.decision.decisionId, route);
  }

  async verify(
    reference: DisclosurePolicyDecisionReference,
  ): Promise<VerifiedDisclosurePolicyDecision> {
    const route = this.#routes.get(reference.decisionId);
    if (route === undefined) {
      throw new EvidenceContributionError("POLICY_DENIED");
    }
    return route;
  }
}

// ---------------------------------------------------------------------------
// Derivation resolver over the real Derivation package
// ---------------------------------------------------------------------------

export function createRealDerivationResolver(
  deriver: EvidenceDeriver,
): DerivationResolver {
  return { resolve: async () => deriver };
}

// ---------------------------------------------------------------------------
// Review reference store double
// ---------------------------------------------------------------------------

/**
 * Retains Derivation findings behind an opaque reference and never echoes
 * them back through any Contribution-facing surface. `peek` exists only
 * for test assertions against the fixture itself (never called by
 * Contribution core).
 */
export class RetainingReviewReferenceStore implements ReviewReferenceStore {
  #counter = 0;
  readonly #retained = new Map<string, unknown>();

  async retain(
    input: Parameters<ReviewReferenceStore["retain"]>[0],
  ): Promise<{ readonly reviewReference: string }> {
    this.#counter += 1;
    const reviewReference = `review-ref-${this.#counter}`;
    this.#retained.set(reviewReference, input.findings);
    return { reviewReference };
  }

  peek(reviewReference: string): unknown {
    return this.#retained.get(reviewReference);
  }
}

// ---------------------------------------------------------------------------
// Authorization authority double
// ---------------------------------------------------------------------------

/**
 * A permissive `AuthorizationAuthority` double: exact submissions are
 * granted for every destination ID the caller listed (unless the ID is in
 * a caller-configured denial set), standing grants and revocations are
 * verified as submitted, and host-scope evaluation always matches.
 * Sufficient for contract scenarios that exercise Contribution's own
 * re-derivation logic rather than authority business rules.
 */
export class GrantingAuthorizationAuthority implements AuthorizationAuthority {
  readonly deniedDestinationIds = new Set<string>();
  hostScopeMatches = true;

  async verifyExact(
    submission: Parameters<AuthorizationAuthority["verifyExact"]>[0],
  ) {
    const denied = submission.allowedDestinationIds.filter((id) =>
      this.deniedDestinationIds.has(id));
    const allowed = submission.allowedDestinationIds.filter((id) =>
      !this.deniedDestinationIds.has(id));
    return {
      mode: submission.mode,
      authorityId: submission.authorityId,
      actorId: submission.actorId,
      previewFingerprint: submission.previewFingerprint,
      allowedDestinationIds: allowed,
      decidedAt: submission.decidedAt,
      ...(submission.expiresAt !== undefined ? { expiresAt: submission.expiresAt } : {}),
      proofDigest: submission.proofDigest,
      exactPreviewPresented: submission.exactPreviewPresented,
      deniedDestinations: denied.map((destination) => ({
        destination,
        reasonCode: "DESTINATION_DENIED" as const,
      })),
    };
  }

  async verifyStandingGrant(
    submission: Parameters<AuthorizationAuthority["verifyStandingGrant"]>[0],
  ) {
    return {
      authorityId: submission.authorityId,
      actorId: submission.actorId,
      sourceScope: submission.sourceScope,
      allowedFamilies: submission.allowedFamilies,
      policyAuthorityIds: submission.policyAuthorityIds,
      policyProfiles: submission.policyProfiles,
      policyDigests: submission.policyDigests,
      implementationDigests: submission.implementationDigests,
      derivationConfigurationDigests: submission.derivationConfigurationDigests,
      destinationConfigurationDigests: submission.destinationConfigurationDigests,
      limits: submission.limits,
      issuedAt: submission.issuedAt,
      ...(submission.expiresAt !== undefined ? { expiresAt: submission.expiresAt } : {}),
      proofDigest: submission.proofDigest,
    };
  }

  async verifyStandingGrantRevocation(
    submission: Parameters<AuthorizationAuthority["verifyStandingGrantRevocation"]>[0],
  ) {
    return {
      authorityId: submission.authorityId,
      actorId: submission.actorId,
      grantId: submission.grantId,
      expectedGrantVersion: submission.expectedGrantVersion,
      revokedAt: submission.revokedAt,
      reasonCode: submission.reasonCode,
      proofDigest: submission.proofDigest,
    };
  }

  async evaluateHostScope() {
    return {
      matches: this.hostScopeMatches,
      decisionDigest: `sha256:${"7".repeat(64)}` as Sha256Digest,
    };
  }
}

export function proofBytesFor(secret: string): {
  readonly proofBytes: Uint8Array;
  readonly proofDigest: Sha256Digest;
} {
  const proofBytes = new TextEncoder().encode(secret);
  return { proofBytes, proofDigest: hashExactBytes(proofBytes) };
}

// ---------------------------------------------------------------------------
// Publication resolver double
// ---------------------------------------------------------------------------

export interface InMemoryPublicationResolverOptions {
  readonly repository: EvidenceRepository;
  readonly sink: AnnouncementSink;
  readonly journal: PublicationJournalStore;
  readonly withdrawal?: AvailabilityWithdrawal;
  readonly projectLocations?: (
    receipt: Parameters<
      NonNullable<ResolvedPublicationDestination["projectLocations"]>
    >[0],
  ) => readonly SafePublishedLocation[];
}

export function createInMemoryPublicationResolver(
  options: InMemoryPublicationResolverOptions,
): PublicationResolver {
  const dependencies: PublicationDependencies = {
    repository: options.repository,
    sink: options.sink,
    journal: options.journal,
  };
  return {
    resolve: async (descriptor) => ({
      descriptor,
      dependencies,
      ...(options.withdrawal !== undefined ? { withdrawal: options.withdrawal } : {}),
      ...(options.projectLocations !== undefined
        ? { projectLocations: options.projectLocations }
        : {}),
    }),
  };
}

// ---------------------------------------------------------------------------
// Availability-withdrawal doubles
// ---------------------------------------------------------------------------

export function createSupportedAvailabilityWithdrawal(
  externalId: string,
): AvailabilityWithdrawal {
  return {
    deactivate: async (): Promise<AvailabilityWithdrawalResult> => ({
      status: "withdrawn",
      externalId,
    }),
  };
}

export function createUnsupportedAvailabilityWithdrawal(): AvailabilityWithdrawal {
  return {
    deactivate: async (): Promise<AvailabilityWithdrawalResult> => ({
      status: "unsupported",
      reasonCode: "WITHDRAWAL_UNSUPPORTED",
    }),
  };
}

// ---------------------------------------------------------------------------
// Assembled in-memory host driver
//
// `./testing.ts` composes this into the frozen
// `EvidenceContributionContractDriver` shape. It is kept here (not
// exported at the package root) because it depends on Vitest-adjacent
// in-memory doubles from sibling packages' `/testing` subpaths.
// ---------------------------------------------------------------------------

const SOURCE_BINDING_ID = "contract-source";
const STAGING_BINDING_ID = "contract-staging";

interface DestinationPublicationBackend {
  readonly repository: EvidenceRepository;
  readonly sink: InMemoryAnnouncementSink;
  readonly journal: InMemoryPublicationJournalStore;
  withdrawalEffectCount: number;
}

/**
 * A fully assembled, deterministic in-memory host for the Contribution
 * contract kit. Every dependency aggregate a command needs
 * (`store`/`clock`/`identifiers`/`policies`/`derivations`/`reviews`/
 * `authorization`/`repositories`/`publications`) is pre-built from the
 * same underlying doubles, so a scenario can freely mix commands without
 * re-wiring dependencies. A destination's optional availability-withdrawal
 * capability is driven by the `deactivation` field on the
 * `ContributionDestination` descriptor the scenario itself constructs --
 * `"supported"` resolves a working withdrawal, `"unsupported"` resolves
 * none -- so no extra configuration call is required.
 */
export class InMemoryEvidenceContributionDriver {
  readonly store = new InMemoryContributionStore();
  readonly clock = createDeterministicContributionClock("2026-07-28T00:00:00Z");
  readonly identifiers = createSequentialContributionIdentifiers("contract");
  readonly policies = new RegisteredDisclosurePolicyAuthority();
  readonly authorization = new GrantingAuthorizationAuthority();
  readonly reviews = new RetainingReviewReferenceStore();
  /**
   * Mutable: Derivation behavior (unchanged / derived / review-required /
   * withheld) is scenario-specific, so each scenario assigns the resolver
   * it needs rather than the driver guessing from state. Defaults to a
   * silent deriver (no detector ever fires) matching the most common
   * `publishable-unchanged` path.
   */
  derivations: DerivationResolver = createRealDerivationResolver(
    createEvidenceDeriver({
      detectors: createBuiltinDerivationDetectors({
        privateConfiguration: createSyntheticPrivateDetectorConfiguration(),
      }).map((detector) => ({
        descriptor: detector.descriptor,
        async detect() {
          return [];
        },
      })),
    }),
  );

  #sourceRepository: EvidenceRepository = new InMemoryEvidenceRepository();
  #stagingRepository: EvidenceRepository = new InMemoryEvidenceRepository();
  readonly #destinationBackends = new Map<string, DestinationPublicationBackend>();

  get sourceBindingId(): string {
    return SOURCE_BINDING_ID;
  }

  get stagingBindingId(): string {
    return STAGING_BINDING_ID;
  }

  get sourceRepository(): EvidenceRepository {
    return this.#sourceRepository;
  }

  get stagingRepository(): EvidenceRepository {
    return this.#stagingRepository;
  }

  readonly repositories = {
    resolve: async (bindingId: string): Promise<EvidenceRepository> => {
      if (bindingId === SOURCE_BINDING_ID) return this.#sourceRepository;
      if (bindingId === STAGING_BINDING_ID) return this.#stagingRepository;
      throw new EvidenceContributionError("INVALID_INPUT");
    },
  };

  readonly publications: PublicationResolver = {
    resolve: async (descriptor) => {
      const backend = this.#backendFor(descriptor.destination);
      return {
        descriptor,
        dependencies: {
          repository: backend.repository,
          sink: backend.sink,
          journal: backend.journal,
        } satisfies PublicationDependencies,
        ...(descriptor.deactivation === "supported"
          ? {
            withdrawal: {
              deactivate: async (): Promise<AvailabilityWithdrawalResult> => {
                backend.withdrawalEffectCount += 1;
                return {
                  status: "withdrawn",
                  externalId: `urn:contract:${descriptor.destination}`,
                };
              },
            } satisfies AvailabilityWithdrawal,
          }
          : {}),
      };
    },
  };

  /**
   * Reset the source/staging Repository pair for a fresh scenario, keeping
   * the store/clock/identifiers/policy/authorization/publication doubles
   * (and every existing request they hold) untouched. Independent
   * scenarios exercised against the same driver instance still get
   * isolated Evidence bytes.
   */
  resetRepositories(): void {
    this.#sourceRepository = new InMemoryEvidenceRepository();
    this.#stagingRepository = new InMemoryEvidenceRepository();
  }

  publicationEffectCount(destination: string): number {
    return this.#destinationBackends.get(destination)?.sink.placementEffectCount ?? 0;
  }

  withdrawalEffectCount(destination: string): number {
    return this.#destinationBackends.get(destination)?.withdrawalEffectCount ?? 0;
  }

  async stateSnapshot(): Promise<unknown> {
    return { requests: [], grants: [] };
  }

  /**
   * Reset the source/staging Repository pair for a fresh named scenario
   * and return its observation handles. `scenario` only selects a fresh
   * isolated Repository pair here -- it seeds nothing; each scenario's
   * test body writes its own exact source bytes into `sourceRepository`.
   */
  async createObservation(
    scenario: string,
  ): Promise<{
    readonly sourceRepository: EvidenceRepository;
    readonly stagingRepository: EvidenceRepository;
    readonly publicationEffectCount: (destination: string) => number;
    readonly withdrawalEffectCount: (destination: string) => number;
    readonly stateSnapshot: () => Promise<unknown>;
    readonly cleanup?: () => Promise<void> | void;
  }> {
    void scenario;
    this.resetRepositories();
    return {
      sourceRepository: this.sourceRepository,
      stagingRepository: this.stagingRepository,
      publicationEffectCount: (destination: string) => this.publicationEffectCount(destination),
      withdrawalEffectCount: (destination: string) => this.withdrawalEffectCount(destination),
      stateSnapshot: () => this.stateSnapshot(),
    };
  }

  #base() {
    return { store: this.store, clock: this.clock, identifiers: this.identifiers };
  }

  #preparation() {
    return {
      ...this.#base(),
      repositories: this.repositories,
      policies: this.policies,
      derivations: this.derivations,
      reviews: this.reviews,
    };
  }

  #authorizationDeps() {
    return { ...this.#base(), authorization: this.authorization };
  }

  #publicationDeps() {
    return { ...this.#base(), repositories: this.repositories, publications: this.publications };
  }

  /**
   * The command surface, typed exactly like the real exported functions
   * (`typeof createContributionRequest`, etc.) so a host driver could
   * legitimately forward a caller-supplied `dependencies` argument. This
   * in-memory driver instead binds its own pre-assembled dependency
   * aggregates and ignores whatever is passed for that positional
   * argument -- the contract kit passes a placeholder there and relies on
   * `options` (the trailing argument) still reaching the real command.
   */
  readonly commands = {
    create: (
      input: Parameters<typeof createContributionRequest>[0],
      _dependencies: Parameters<typeof createContributionRequest>[1],
      options?: Parameters<typeof createContributionRequest>[2],
    ) => createContributionRequest(input, this.#base(), options),
    prepare: (
      requestId: Parameters<typeof prepareContribution>[0],
      _dependencies: Parameters<typeof prepareContribution>[1],
      options?: Parameters<typeof prepareContribution>[2],
    ) => prepareContribution(requestId, this.#preparation(), options),
    authorize: (
      requestId: Parameters<typeof authorizeContribution>[0],
      submission: Parameters<typeof authorizeContribution>[1],
      _dependencies: Parameters<typeof authorizeContribution>[2],
      options?: Parameters<typeof authorizeContribution>[3],
    ) => authorizeContribution(requestId, submission, this.#authorizationDeps(), options),
    createGrant: (
      submission: Parameters<typeof createStandingAuthorizationGrant>[0],
      _dependencies: Parameters<typeof createStandingAuthorizationGrant>[1],
      options?: Parameters<typeof createStandingAuthorizationGrant>[2],
    ) => createStandingAuthorizationGrant(submission, this.#authorizationDeps(), options),
    revokeGrant: (
      grantId: Parameters<typeof revokeStandingAuthorizationGrant>[0],
      submission: Parameters<typeof revokeStandingAuthorizationGrant>[1],
      _dependencies: Parameters<typeof revokeStandingAuthorizationGrant>[2],
      options?: Parameters<typeof revokeStandingAuthorizationGrant>[3],
    ) => revokeStandingAuthorizationGrant(grantId, submission, this.#authorizationDeps(), options),
    applyGrant: (
      requestId: Parameters<typeof applyStandingAuthorization>[0],
      grantId: Parameters<typeof applyStandingAuthorization>[1],
      _dependencies: Parameters<typeof applyStandingAuthorization>[2],
      options?: Parameters<typeof applyStandingAuthorization>[3],
    ) => applyStandingAuthorization(requestId, grantId, this.#authorizationDeps(), options),
    resume: (
      requestId: Parameters<typeof resumeContribution>[0],
      _dependencies: Parameters<typeof resumeContribution>[1],
      options?: Parameters<typeof resumeContribution>[2],
    ) => resumeContribution(requestId, this.#publicationDeps(), options),
    retryDestination: (
      requestId: Parameters<typeof retryContributionDestination>[0],
      destination: Parameters<typeof retryContributionDestination>[1],
      _dependencies: Parameters<typeof retryContributionDestination>[2],
      options?: Parameters<typeof retryContributionDestination>[3],
    ) => retryContributionDestination(requestId, destination, this.#publicationDeps(), options),
    decline: (
      requestId: Parameters<typeof declineContribution>[0],
      input: Parameters<typeof declineContribution>[1],
      _dependencies: Parameters<typeof declineContribution>[2],
      options?: Parameters<typeof declineContribution>[3],
    ) => declineContribution(requestId, input, this.#publicationDeps(), options),
    deactivate: (
      requestId: Parameters<typeof deactivateContribution>[0],
      _dependencies: Parameters<typeof deactivateContribution>[1],
      options?: Parameters<typeof deactivateContribution>[2],
    ) => deactivateContribution(requestId, this.#publicationDeps(), options),
    deactivateDestination: (
      requestId: Parameters<typeof deactivateContributionDestination>[0],
      destination: Parameters<typeof deactivateContributionDestination>[1],
      _dependencies: Parameters<typeof deactivateContributionDestination>[2],
      options?: Parameters<typeof deactivateContributionDestination>[3],
    ) => deactivateContributionDestination(requestId, destination, this.#publicationDeps(), options),
    inspect: (
      requestId: Parameters<typeof inspectContribution>[0],
      _dependencies: Parameters<typeof inspectContribution>[1],
      options?: Parameters<typeof inspectContribution>[2],
    ) => inspectContribution(requestId, this.#base(), options),
    readReceipt: (
      requestId: Parameters<typeof readContributionReceipt>[0],
      _dependencies: Parameters<typeof readContributionReceipt>[1],
      options?: Parameters<typeof readContributionReceipt>[2],
    ) => readContributionReceipt(requestId, this.#base(), options),
  };

  /** Directly publish one destination for scenarios that need to reach a
   * `publishing`/`published` state before exercising decline/deactivate/
   * receipt behavior; not part of the frozen `commands` surface (Publish
   * is reached only through `resume`/`retryDestination` in the frozen
   * driver, but those are the exact same underlying function). */
  publishDestination(
    requestId: string,
    destination: string,
    options?: ContributionOperationOptions,
  ) {
    return publishContributionDestination(requestId, destination, this.#publicationDeps(), options);
  }

  #backendFor(destination: string): DestinationPublicationBackend {
    const existing = this.#destinationBackends.get(destination);
    if (existing !== undefined) return existing;
    const backend: DestinationPublicationBackend = {
      repository: new InMemoryEvidenceRepository(),
      sink: new InMemoryAnnouncementSink({
        medium: "https://media.example/contract",
        profile: "https://profiles.example/contract/v1",
      }),
      journal: new InMemoryPublicationJournalStore(),
      withdrawalEffectCount: 0,
    };
    this.#destinationBackends.set(destination, backend);
    return backend;
  }
}
