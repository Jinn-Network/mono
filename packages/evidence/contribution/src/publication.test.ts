// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { hashExactBytes, type PublicationDependencies } from "@jinn-network/evidence-publication";
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
  type ContributionCommandBaseDependencies,
  type ContributionIdentifierSource,
  type ContributionPreparationDependencies,
  type ContributionPublicationDependencies,
} from "./commands.js";
import { EvidenceContributionError } from "./errors.js";
import type { DisclosurePolicyAuthority } from "./policy.js";
import {
  publishContributionDestination,
  resumeContribution,
  retryContributionDestination,
  type PublicationResolver,
  type ResolvedPublicationDestination,
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
    deactivation: "unsupported",
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

/** Prepare and authorize a signed-unchanged Result Evaluation request. */
async function authorizedRequest(
  destinations: readonly ContributionDestination[] = [destination()],
): Promise<{
  readonly deps: ContributionCommandBaseDependencies;
  readonly authorized: ContributionReadModel;
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
  const proposalInput = proposal({
    source: { repositoryBindingId: SOURCE_BINDING, record: receipt.reference },
    policyDecision,
    destinations,
  });
  const created = await createContributionRequest(proposalInput, deps);
  const repositories: RepositoryResolver = {
    resolve: async (bindingId) => {
      if (bindingId === SOURCE_BINDING) return sourceRepository;
      if (bindingId === STAGING_BINDING) return stagingRepository;
      throw new Error(`unknown binding ${bindingId}`);
    },
  };
  const policies: DisclosurePolicyAuthority = { verify: async () => route };
  const preparationDeps: ContributionPreparationDependencies = {
    ...deps,
    repositories,
    policies,
    derivations: { resolve: async () => { throw new Error("unexpected derivation resolve"); } },
    reviews: { retain: async () => { throw new Error("unexpected review retain"); } },
  };
  const prepared = await prepareContribution(created.requestId, preparationDeps);

  const authority: AuthorizationAuthority = {
    verifyExact: async (submission) => ({
      mode: submission.mode,
      authorityId: submission.authorityId,
      actorId: submission.actorId,
      previewFingerprint: submission.previewFingerprint,
      allowedDestinationConfigurationDigests: submission.allowedDestinationConfigurationDigests,
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
  const authorized = await authorizeContribution(
    prepared.requestId,
    {
      mode: "interactive-exact",
      authorityId: "https://authority.example/host",
      actorId: "user-1",
      previewFingerprint: prepared.previewFingerprint!,
      allowedDestinationConfigurationDigests: destinations.map((d) => d.configurationDigest),
      decidedAt: "2026-07-28T00:00:00Z",
      proofDigest: hashExactBytes(proofBytes),
      proofBytes,
      exactPreviewPresented: true,
    },
    { ...deps, authorization: authority },
  );
  return { deps, authorized, stagingRepository };
}

interface RecordingSink {
  readonly sink: InMemoryAnnouncementSink;
  readonly journal: InMemoryPublicationJournalStore;
  readonly repository: EvidenceRepository;
}

function freshPublicationBackend(): RecordingSink {
  return {
    sink: new InMemoryAnnouncementSink({
      medium: "https://media.example/ipfs",
      profile: "https://profiles.example/evidence/v1",
    }),
    journal: new InMemoryPublicationJournalStore(),
    repository: new InMemoryEvidenceRepository(),
  };
}

function resolverFor(
  backend: RecordingSink,
  overrides: Partial<ResolvedPublicationDestination> = {},
): PublicationResolver {
  return {
    resolve: async (descriptor) => ({
      descriptor,
      dependencies: {
        repository: backend.repository,
        sink: backend.sink,
        journal: backend.journal,
      } satisfies PublicationDependencies,
      ...overrides,
    }),
  };
}

describe("publishContributionDestination", () => {
  test("rejects publication for a destination that has not been authorized", async () => {
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
    const backend = freshPublicationBackend();
    const pubDeps: ContributionPublicationDependencies = {
      ...deps,
      repositories: preparationDeps.repositories,
      publications: resolverFor(backend),
    };
    await expect(
      publishContributionDestination(prepared.requestId, destination().destination, pubDeps),
    ).rejects.toThrow(EvidenceContributionError);
    expect(backend.sink.placementEffectCount).toBe(0);
  });

  test("publishes an authorized destination exactly once", async () => {
    const { deps, authorized, stagingRepository } = await authorizedRequest();
    const backend = freshPublicationBackend();
    const pubDeps: ContributionPublicationDependencies = {
      ...deps,
      repositories: {
        resolve: async (bindingId) => {
          if (bindingId === STAGING_BINDING) return stagingRepository;
          throw new Error(`unknown binding ${bindingId}`);
        },
      },
      publications: resolverFor(backend),
    };
    const published = await publishContributionDestination(
      authorized.requestId,
      destination().destination,
      pubDeps,
    );
    expect(published.destinations[0]).toMatchObject({ status: "published" });
    expect(published.status).toBe("completed");
    expect(backend.sink.placementEffectCount).toBe(1);

    const again = await publishContributionDestination(
      authorized.requestId,
      destination().destination,
      pubDeps,
    );
    expect(again.destinations[0]?.status).toBe("published");
    // A completed receipt is not published twice.
    expect(backend.sink.placementEffectCount).toBe(1);
  });

  test("a failed first destination does not block a later authorized destination", async () => {
    const first = destination({
      destination: "https://a.example",
      configurationDigest: `sha256:${"1".repeat(64)}` as Sha256Digest,
    });
    const second = destination({
      destination: "https://b.example",
      configurationDigest: `sha256:${"2".repeat(64)}` as Sha256Digest,
    });
    const { deps, authorized, stagingRepository } = await authorizedRequest([first, second]);
    const failingBackend = freshPublicationBackend();
    const workingBackend = freshPublicationBackend();
    const pubDeps: ContributionPublicationDependencies = {
      ...deps,
      repositories: {
        resolve: async (bindingId) => {
          if (bindingId === STAGING_BINDING) return stagingRepository;
          throw new Error(`unknown binding ${bindingId}`);
        },
      },
      publications: {
        resolve: async (descriptor) => {
          if (descriptor.destination === first.destination) {
            return {
              descriptor,
              dependencies: {
                repository: {
                  ...failingBackend.repository,
                  putRecord: async () => {
                    const { EvidenceRepositoryError } = await import(
                      "@jinn-network/evidence-repository"
                    );
                    throw new EvidenceRepositoryError("IO_FAILURE", "synthetic failure");
                  },
                } as EvidenceRepository,
                sink: failingBackend.sink,
                journal: failingBackend.journal,
              },
            };
          }
          return {
            descriptor,
            dependencies: {
              repository: workingBackend.repository,
              sink: workingBackend.sink,
              journal: workingBackend.journal,
            },
          };
        },
      },
    };
    const result = await resumeContribution(authorized.requestId, pubDeps);
    const outcomes = new Map(result.destinations.map((entry) => [entry.destination, entry.status]));
    expect(outcomes.get(first.destination)).toBe("retryable-failure");
    expect(outcomes.get(second.destination)).toBe("published");
    expect(result.status).toBe("attention-required");
  });

  test("retryContributionDestination re-enters only a retryable or interrupted destination", async () => {
    const { deps, authorized, stagingRepository } = await authorizedRequest();
    const backend = freshPublicationBackend();
    const pubDeps: ContributionPublicationDependencies = {
      ...deps,
      repositories: {
        resolve: async (bindingId) => {
          if (bindingId === STAGING_BINDING) return stagingRepository;
          throw new Error(`unknown binding ${bindingId}`);
        },
      },
      publications: resolverFor(backend),
    };
    await expect(
      retryContributionDestination(authorized.requestId, destination().destination, pubDeps),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("resumeContribution advances every eligible destination in deterministic order", async () => {
    const a = destination({
      destination: "https://a.example",
      configurationDigest: `sha256:${"1".repeat(64)}` as Sha256Digest,
    });
    const b = destination({
      destination: "https://b.example",
      configurationDigest: `sha256:${"2".repeat(64)}` as Sha256Digest,
    });
    const { deps, authorized, stagingRepository } = await authorizedRequest([b, a]);
    const backend = freshPublicationBackend();
    const pubDeps: ContributionPublicationDependencies = {
      ...deps,
      repositories: {
        resolve: async (bindingId) => {
          if (bindingId === STAGING_BINDING) return stagingRepository;
          throw new Error(`unknown binding ${bindingId}`);
        },
      },
      publications: resolverFor(backend),
    };
    const result = await resumeContribution(authorized.requestId, pubDeps);
    expect(result.status).toBe("completed");
    expect(result.destinations.every((entry) => entry.status === "published")).toBe(true);
  });

  test("no Publication effect occurs without current authorization", async () => {
    const deps = base();
    const created = await createContributionRequest(proposal(), deps);
    const backend = freshPublicationBackend();
    const pubDeps: ContributionPublicationDependencies = {
      ...deps,
      repositories: { resolve: async () => { throw new Error("unexpected"); } },
      publications: resolverFor(backend),
    };
    await expect(
      publishContributionDestination(created.requestId, destination().destination, pubDeps),
    ).rejects.toThrow(EvidenceContributionError);
    expect(backend.sink.placementEffectCount).toBe(0);
    expect(backend.journal.entryCount).toBe(0);
  });
});
