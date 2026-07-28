// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { hashExactBytes } from "@jinn-network/evidence-publication";
import {
  InMemoryAnnouncementSink,
  InMemoryPublicationJournalStore,
} from "@jinn-network/evidence-publication/testing";
import type { EvidenceRepository, Sha256Digest } from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);

async function loadGoldenFixture(path: string): Promise<Uint8Array> {
  const fixturePath = require.resolve(
    `@jinn-network/evidence-protocol/fixtures/${path}`,
  );
  return new Uint8Array(await readFile(fixturePath));
}

import type { AuthorizationAuthority } from "./authorization.js";
import { authorizeContribution } from "./authorization.js";
import {
  createContributionRequest,
  prepareContribution,
  type ContributionClock,
  type ContributionCloseoutDependencies,
  type ContributionCommandBaseDependencies,
  type ContributionIdentifierSource,
  type ContributionPreparationDependencies,
} from "./commands.js";
import {
  declineContribution,
  deactivateContribution,
  deactivateContributionDestination,
} from "./deactivation.js";
import { EvidenceContributionError } from "./errors.js";
import type { DisclosurePolicyAuthority } from "./policy.js";
import type {
  AvailabilityWithdrawal,
  AvailabilityWithdrawalResult,
  PublicationResolver,
} from "./publication.js";
import type { RepositoryResolver } from "./source.js";
import { InMemoryContributionStore } from "./testing-fixtures.js";
import type {
  ContributionDestination,
  ContributionReadModel,
  CreateContributionRequestInput,
  VerifiedDisclosurePolicyDecision,
} from "./types.js";

function fixedClock(at: string): ContributionClock {
  return { now: () => at };
}

function sequentialIdentifiers(prefix: string): ContributionIdentifierSource {
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

function base(): ContributionCommandBaseDependencies {
  return {
    store: new InMemoryContributionStore(),
    clock: fixedClock("2026-07-28T00:00:00Z"),
    identifiers: sequentialIdentifiers("test"),
  };
}

const SOURCE_BINDING = "private-local";
const STAGING_BINDING = "private-staging";

function destination(
  overrides: Partial<ContributionDestination> = {},
): ContributionDestination {
  return {
    destination: "https://destinations.example/ipfs",
    medium: "https://media.example/ipfs",
    profile: "https://profiles.example/evidence/v1",
    configurationDigest: `sha256:${"c".repeat(64)}` as Sha256Digest,
    label: "Public IPFS",
    irreversible: true,
    deactivation: "supported",
    ...overrides,
  };
}

function proposal(
  overrides: Partial<CreateContributionRequestInput> = {},
): CreateContributionRequestInput {
  return {
    idempotencyKey: "plugin:attempt-1",
    source: {
      repositoryBindingId: SOURCE_BINDING,
      record: { family: "result-evaluation", digest: `sha256:${"b".repeat(64)}` },
    },
    stagingRepositoryBindingId: STAGING_BINDING,
    policyDecision: {
      authorityId: "https://authority.example/policy",
      decisionId: "decision-1",
      digest: `sha256:${"a".repeat(64)}`,
    },
    destinations: [destination()],
    limits: {
      maxDestinations: 4,
      maxArtifacts: 128,
      maxArtifactBytes: 16_777_216,
      maxTotalArtifactBytes: 67_108_864,
      maxManifestBytes: 1_048_576,
      maxConcurrentDestinations: 2,
    },
    ...overrides,
  };
}

async function preparedRequest(
  destinations: readonly ContributionDestination[] = [destination()],
): Promise<{
  readonly deps: ContributionCommandBaseDependencies;
  readonly prepared: ContributionReadModel;
  readonly stagingRepository: EvidenceRepository;
}> {
  const deps = base();
  const sourceRepository: EvidenceRepository = new InMemoryEvidenceRepository();
  const stagingRepository: EvidenceRepository = new InMemoryEvidenceRepository();
  const golden = await loadGoldenFixture(
    "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
  );
  const receipt = await sourceRepository.putRecord("result-evaluation", golden);
  const policyDecision = {
    authorityId: "https://authority.example/policy",
    decisionId: "signed-decision",
    digest: `sha256:${"a".repeat(64)}` as Sha256Digest,
  };
  const route: VerifiedDisclosurePolicyDecision = {
    kind: "disclose-signed-unchanged",
    decision: policyDecision,
    source: receipt.reference,
    issuedAt: "2026-07-27T00:00:00Z",
    allowedCompanionArtifacts: [],
  };
  const created = await createContributionRequest(
    proposal({
      source: { repositoryBindingId: SOURCE_BINDING, record: receipt.reference },
      policyDecision,
      destinations,
    }),
    deps,
  );
  const preparationDeps: ContributionPreparationDependencies = {
    ...deps,
    repositories: {
      resolve: async (bindingId) => {
        if (bindingId === SOURCE_BINDING) return sourceRepository;
        if (bindingId === STAGING_BINDING) return stagingRepository;
        throw new Error(`unknown binding ${bindingId}`);
      },
    },
    policies: { verify: async () => route },
    derivations: { resolve: async () => { throw new Error("unexpected"); } },
    reviews: { retain: async () => { throw new Error("unexpected"); } },
  };
  const prepared = await prepareContribution(created.requestId, preparationDeps);
  return { deps, prepared, stagingRepository };
}

async function authorize(
  deps: ContributionCommandBaseDependencies,
  prepared: ContributionReadModel,
  destinations: readonly ContributionDestination[] = [destination()],
): Promise<void> {
  const authority: AuthorizationAuthority = {
    verifyExact: async (submission) => ({
      mode: submission.mode,
      authorityId: submission.authorityId,
      actorId: submission.actorId,
      previewFingerprint: submission.previewFingerprint,
      allowedDestinationIds: submission.allowedDestinationIds,
      decidedAt: submission.decidedAt,
      proofDigest: submission.proofDigest,
      exactPreviewPresented: submission.exactPreviewPresented,
      deniedDestinations: [],
    }),
    verifyStandingGrant: async () => { throw new Error("unexpected"); },
    verifyStandingGrantRevocation: async () => { throw new Error("unexpected"); },
    evaluateHostScope: async () => { throw new Error("unexpected"); },
  };
  const proofBytes = new Uint8Array([1, 2, 3]);
  await authorizeContribution(
    prepared.requestId,
    {
      mode: "interactive-exact",
      authorityId: "https://authority.example/host",
      actorId: "user-1",
      previewFingerprint: prepared.previewFingerprint!,
      allowedDestinationIds: destinations.map((d) => d.destination),
      decidedAt: "2026-07-28T00:00:00Z",
      proofDigest: hashExactBytes(proofBytes),
      proofBytes,
      exactPreviewPresented: true,
    },
    { ...deps, authorization: authority },
  );
}

function publicationResolverFor(
  stagingRepository: EvidenceRepository,
  withdrawal?: AvailabilityWithdrawal,
): { readonly resolver: PublicationResolver; readonly sink: InMemoryAnnouncementSink } {
  const sink = new InMemoryAnnouncementSink({
    medium: "https://media.example/ipfs",
    profile: "https://profiles.example/evidence/v1",
  });
  const journal = new InMemoryPublicationJournalStore();
  const repository = new InMemoryEvidenceRepository();
  const resolver: PublicationResolver = {
    resolve: async (descriptor) => ({
      descriptor,
      dependencies: { repository, sink, journal },
      ...(withdrawal !== undefined ? { withdrawal } : {}),
    }),
  };
  void stagingRepository;
  return { resolver, sink };
}

describe("declineContribution", () => {
  test("declines a proposed request with no external effect", async () => {
    const deps = base();
    const created = await createContributionRequest(proposal(), deps);
    const closeoutDeps: ContributionCloseoutDependencies = {
      ...deps,
      repositories: { resolve: async () => { throw new Error("unexpected"); } },
      publications: { resolve: async () => { throw new Error("unexpected"); } },
    };
    const declined = await declineContribution(
      created.requestId,
      { actorId: "user-1", reasonCode: "OPERATOR_ATTENTION_REQUIRED" },
      closeoutDeps,
    );
    expect(declined.status).toBe("declined");
  });

  test("declines a preview-ready request before Publication starts, leaving staged bytes untouched", async () => {
    const { deps, prepared, stagingRepository } = await preparedRequest();
    const closeoutDeps: ContributionCloseoutDependencies = {
      ...deps,
      repositories: { resolve: async () => stagingRepository },
      publications: { resolve: async () => { throw new Error("unexpected"); } },
    };
    const declined = await declineContribution(
      prepared.requestId,
      { actorId: "user-1", reasonCode: "OPERATOR_ATTENTION_REQUIRED" },
      closeoutDeps,
    );
    expect(declined.status).toBe("declined");
  });

  test("rejects decline once a destination has begun Publication, in favor of deactivation", async () => {
    const { deps, prepared, stagingRepository } = await preparedRequest();
    await authorize(deps, prepared);
    const { resolver } = publicationResolverFor(stagingRepository);
    const pubDeps: ContributionCloseoutDependencies = {
      ...deps,
      repositories: { resolve: async () => stagingRepository },
      publications: resolver,
    };
    const { publishContributionDestination } = await import("./publication.js");
    await publishContributionDestination(prepared.requestId, destination().destination, pubDeps);
    await expect(
      declineContribution(
        prepared.requestId,
        { actorId: "user-1", reasonCode: "OPERATOR_ATTENTION_REQUIRED" },
        pubDeps,
      ),
    ).rejects.toThrow(EvidenceContributionError);
  });
});

describe("deactivateContributionDestination", () => {
  test("checkpoints deactivation before a not-started destination can publish", async () => {
    const { deps, prepared, stagingRepository } = await preparedRequest();
    await authorize(deps, prepared);
    const { resolver, sink } = publicationResolverFor(stagingRepository);
    const closeoutDeps: ContributionCloseoutDependencies = {
      ...deps,
      repositories: { resolve: async () => stagingRepository },
      publications: resolver,
    };
    const deactivated = await deactivateContributionDestination(
      prepared.requestId,
      destination().destination,
      closeoutDeps,
    );
    expect(deactivated.destinations[0]?.deactivated).toBe(true);

    const { publishContributionDestination } = await import("./publication.js");
    await expect(
      publishContributionDestination(prepared.requestId, destination().destination, closeoutDeps),
    ).rejects.toThrow(EvidenceContributionError);
    expect(sink.placementEffectCount).toBe(0);
  });

  test("supported withdrawal records deactivated with the external ID", async () => {
    const { deps, prepared, stagingRepository } = await preparedRequest();
    await authorize(deps, prepared);
    const withdrawal: AvailabilityWithdrawal = {
      deactivate: async (): Promise<AvailabilityWithdrawalResult> => ({
        status: "withdrawn",
        externalId: "urn:test:withdrawn-1",
      }),
    };
    const { resolver } = publicationResolverFor(stagingRepository, withdrawal);
    const pubDeps: ContributionCloseoutDependencies = {
      ...deps,
      repositories: { resolve: async () => stagingRepository },
      publications: resolver,
    };
    const { publishContributionDestination } = await import("./publication.js");
    await publishContributionDestination(prepared.requestId, destination().destination, pubDeps);
    const deactivated = await deactivateContributionDestination(
      prepared.requestId,
      destination().destination,
      pubDeps,
    );
    expect(deactivated.destinations[0]).toMatchObject({ deactivated: true, status: "published" });
    const stored = await deps.store.loadRequest(prepared.requestId);
    expect(stored?.value.destinations[0]?.deactivation.outcome).toEqual({
      status: "withdrawn",
      externalId: "urn:test:withdrawn-1",
    });
  });

  test("reconciles an interrupted publishing destination without a stale expectedRequestRevision spuriously conflicting", async () => {
    const { deps, prepared, stagingRepository } = await preparedRequest();
    await authorize(deps, prepared);

    const sink = new InMemoryAnnouncementSink({
      medium: "https://media.example/ipfs",
      profile: "https://profiles.example/evidence/v1",
    });
    const journal = new InMemoryPublicationJournalStore();
    const workingRepository = new InMemoryEvidenceRepository();
    let interrupt = true;
    const interruptingRepository: EvidenceRepository = {
      ...workingRepository,
      putRecord: async (...args: Parameters<EvidenceRepository["putRecord"]>) => {
        if (interrupt) throw new Error("synthetic interruption");
        return workingRepository.putRecord(...args);
      },
    } as EvidenceRepository;
    const resolver: PublicationResolver = {
      resolve: async (descriptor) => ({
        descriptor,
        dependencies: { repository: interruptingRepository, sink, journal },
      }),
    };
    const pubDeps: ContributionCloseoutDependencies = {
      ...deps,
      repositories: { resolve: async () => stagingRepository },
      publications: resolver,
    };
    const { publishContributionDestination } = await import("./publication.js");
    // Checkpoints to `publishing`, then an unclassified failure interrupts
    // before a terminal state is recorded -- the destination is left
    // `publishing` in the store.
    await expect(
      publishContributionDestination(prepared.requestId, destination().destination, pubDeps),
    ).rejects.toThrow();
    const midway = await deps.store.loadRequest(prepared.requestId);
    expect(midway?.value.destinations[0]?.publication.status).toBe("publishing");

    interrupt = false;
    // `deactivateContributionDestination` checkpoints its own
    // deactivation-requested transition first (advancing the store
    // revision), then reconciles the interrupted `publishing` destination
    // through a nested `publishContributionDestination` call. A caller's
    // `expectedRequestRevision`, read before this call, must not be
    // forwarded into that nested call -- it would compare against a
    // revision this call itself already advanced and fail spuriously.
    const deactivated = await deactivateContributionDestination(
      prepared.requestId,
      destination().destination,
      pubDeps,
      { expectedRequestRevision: midway!.revision },
    );
    expect(deactivated.destinations[0]).toMatchObject({
      status: "published",
      deactivated: true,
    });
  });

  test("unsupported withdrawal records unsupported without claiming deletion", async () => {
    const { deps, prepared, stagingRepository } = await preparedRequest();
    await authorize(deps, prepared);
    const { resolver } = publicationResolverFor(stagingRepository);
    const pubDeps: ContributionCloseoutDependencies = {
      ...deps,
      repositories: { resolve: async () => stagingRepository },
      publications: resolver,
    };
    const { publishContributionDestination } = await import("./publication.js");
    await publishContributionDestination(prepared.requestId, destination().destination, pubDeps);
    const deactivated = await deactivateContributionDestination(
      prepared.requestId,
      destination().destination,
      pubDeps,
    );
    const stored = await deps.store.loadRequest(prepared.requestId);
    expect(stored?.value.destinations[0]?.deactivation.outcome).toEqual({
      status: "unsupported",
      reasonCode: "WITHDRAWAL_UNSUPPORTED",
    });
    expect(deactivated.status).toBe("completed");
  });
});

describe("deactivateContribution", () => {
  test("deactivates every destination on the request", async () => {
    const { deps, prepared, stagingRepository } = await preparedRequest();
    await authorize(deps, prepared);
    const { resolver } = publicationResolverFor(stagingRepository);
    const closeoutDeps: ContributionCloseoutDependencies = {
      ...deps,
      repositories: { resolve: async () => stagingRepository },
      publications: resolver,
    };
    const result = await deactivateContribution(prepared.requestId, closeoutDeps);
    expect(result.destinations.every((entry) => entry.deactivated)).toBe(true);
  });

  test("with expectedRequestRevision deactivates every destination, not just the first", async () => {
    const a = destination({
      destination: "https://a.example",
      configurationDigest: `sha256:${"1".repeat(64)}` as Sha256Digest,
    });
    const b = destination({
      destination: "https://b.example",
      configurationDigest: `sha256:${"2".repeat(64)}` as Sha256Digest,
    });
    const { deps, prepared, stagingRepository } = await preparedRequest([a, b]);
    await authorize(deps, prepared, [a, b]);
    const { resolver } = publicationResolverFor(stagingRepository);
    const closeoutDeps: ContributionCloseoutDependencies = {
      ...deps,
      repositories: { resolve: async () => stagingRepository },
      publications: resolver,
    };
    const current = await deps.store.loadRequest(prepared.requestId);
    // Deactivating the first destination checkpoints a state change and
    // advances the store revision; that must not cause the second
    // destination's deactivation to spuriously see a stale expectation and
    // throw STORE_CONFLICT.
    const result = await deactivateContribution(prepared.requestId, closeoutDeps, {
      expectedRequestRevision: current!.revision,
    });
    expect(result.destinations.every((entry) => entry.deactivated)).toBe(true);
  });
});
