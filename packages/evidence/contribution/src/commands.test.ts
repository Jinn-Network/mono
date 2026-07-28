// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  createBuiltinDerivationDetectors,
  createEvidenceDeriver,
} from "@jinn-network/evidence-derivation";
import { createSyntheticDerivationInput } from "@jinn-network/evidence-derivation/testing";
import type { EvidenceDeriver } from "@jinn-network/evidence-derivation";
import { createArtifactReference } from "@jinn-network/evidence-repository";
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

import {
  authorizeContribution,
  type AuthorizationAuthority,
} from "./authorization.js";
import {
  createContributionRequest,
  inspectContribution,
  prepareContribution,
  type ContributionAuthorizationDependencies,
  type ContributionClock,
  type ContributionCommandBaseDependencies,
  type ContributionIdentifierSource,
  type ContributionPreparationDependencies,
} from "./commands.js";
import { EvidenceContributionError } from "./errors.js";
import type { DisclosurePolicyAuthority } from "./policy.js";
import type { RepositoryResolver } from "./source.js";
import { InMemoryContributionStore } from "./testing-fixtures.js";
import type {
  CreateContributionRequestInput,
  VerifiedDeriveExecutionDecision,
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

function dependencies(): ContributionCommandBaseDependencies {
  return {
    store: new InMemoryContributionStore(),
    clock: fixedClock("2026-07-28T00:00:00Z"),
    identifiers: sequentialIdentifiers("test"),
  };
}

function proposal(
  overrides: Partial<CreateContributionRequestInput> = {},
): CreateContributionRequestInput {
  return {
    idempotencyKey: "plugin:attempt-1",
    source: {
      repositoryBindingId: "private-local",
      record: { family: "execution-evidence", digest: `sha256:${"b".repeat(64)}` },
    },
    stagingRepositoryBindingId: "private-staging",
    policyDecision: {
      authorityId: "https://authority.example/policy",
      decisionId: "decision-1",
      digest: `sha256:${"a".repeat(64)}`,
    },
    destinations: [{
      destination: "https://destinations.example/ipfs",
      medium: "https://media.example/ipfs",
      profile: "https://profiles.example/evidence/v1",
      configurationDigest: `sha256:${"c".repeat(64)}`,
      label: "Public IPFS",
      irreversible: true,
      deactivation: "unsupported",
    }],
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

describe("createContributionRequest", () => {
  test("creates a proposed request with a fresh identifier", async () => {
    const deps = dependencies();
    const readModel = await createContributionRequest(proposal(), deps);
    expect(readModel.status).toBe("proposed");
    expect(readModel.requestId).toBe("test-request-1");
    expect(readModel.revision).toBe(1);
  });

  test("returns the existing request for a repeated idempotency key with the same content", async () => {
    const deps = dependencies();
    const first = await createContributionRequest(proposal(), deps);
    const second = await createContributionRequest(proposal(), deps);
    expect(second.requestId).toBe(first.requestId);
    expect(deps.store).toBeInstanceOf(InMemoryContributionStore);
    expect((deps.store as InMemoryContributionStore).counters.createRequest).toBe(1);
  });

  test("rejects a repeated idempotency key with a different proposal", async () => {
    const deps = dependencies();
    await createContributionRequest(proposal(), deps);
    await expect(
      createContributionRequest(
        proposal({ stagingRepositoryBindingId: "different-staging" }),
        deps,
      ),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("a supersedes link creates a distinct request that starts proposed", async () => {
    const deps = dependencies();
    const original = await createContributionRequest(
      proposal({ idempotencyKey: "plugin:attempt-1" }),
      deps,
    );
    const superseding = await createContributionRequest(
      proposal({
        idempotencyKey: "plugin:attempt-2",
        supersedes: original.requestId,
      }),
      deps,
    );
    expect(superseding.requestId).not.toBe(original.requestId);
    expect(superseding.status).toBe("proposed");
    expect(superseding.destinations).toEqual([]);
  });
});

describe("inspectContribution", () => {
  test("returns the current read model for a known request", async () => {
    const deps = dependencies();
    const created = await createContributionRequest(proposal(), deps);
    const inspected = await inspectContribution(created.requestId, deps);
    expect(inspected).toEqual(created);
  });

  test("rejects an unknown request id", async () => {
    const deps = dependencies();
    await expect(inspectContribution("missing", deps))
      .rejects.toThrow(EvidenceContributionError);
  });
});

const SOURCE_BINDING = "private-local";
const STAGING_BINDING = "private-staging";

const privateConfiguration = {
  schemaVersion: "jinn.private-detector-configuration.v1" as const,
  nonce: "private-test-nonce-0123456789abcdef",
  knownIdentities: ["Ada Example"],
  privateAllowlist: ["operator.internal.example"],
};

function silentDeriver(): EvidenceDeriver {
  const detectors = createBuiltinDerivationDetectors({ privateConfiguration })
    .map((detector) => ({
      descriptor: detector.descriptor,
      async detect() {
        return [];
      },
    }));
  return createEvidenceDeriver({ detectors });
}

async function seededExecutionEvidenceFixture(): Promise<{
  readonly repository: EvidenceRepository;
  readonly proposalInput: CreateContributionRequestInput;
  readonly route: VerifiedDeriveExecutionDecision;
}> {
  const repository = new InMemoryEvidenceRepository();
  const input = createSyntheticDerivationInput();
  await repository.putRecord("execution-evidence", input.sourceRecord.bytes);
  await repository.putArtifact(input.policyBytes);
  await repository.putArtifact(input.scrubber.implementationDescriptorBytes);
  for (const artifact of input.sourceArtifacts) {
    await repository.putArtifact(artifact.bytes);
  }
  const policyDecision = {
    authorityId: "https://authority.example/policy",
    decisionId: "decision-1",
    digest: `sha256:${"a".repeat(64)}` as Sha256Digest,
  };
  const route: VerifiedDeriveExecutionDecision = {
    kind: "derive-execution",
    decision: policyDecision,
    source: input.sourceRecord.reference,
    issuedAt: "2026-07-27T00:00:00Z",
    policyInput: createArtifactReference(input.policyBytes),
    implementationDescriptor: createArtifactReference(
      input.scrubber.implementationDescriptorBytes,
    ),
    sourceArtifacts: input.sourceArtifacts.map((artifact) => ({
      entityId: artifact.entityId,
      reference: createArtifactReference(artifact.bytes),
    })),
    policyDigest: createArtifactReference(input.policyBytes).digest,
    implementationDigest: createArtifactReference(
      input.scrubber.implementationDescriptorBytes,
    ).digest,
    scrubberAgentId: input.scrubber.agentId,
    completedAt: input.completedAt,
    risk: {
      irreversibility: "immutable-or-replicable",
      sourceCommitmentCorrelation: "none-declared",
    },
  };
  const proposalInput = proposal({
    idempotencyKey: "plugin:attempt-execution",
    source: { repositoryBindingId: SOURCE_BINDING, record: input.sourceRecord.reference },
    policyDecision,
  });
  return { repository, proposalInput, route };
}

function preparationDependencies(
  base: ContributionCommandBaseDependencies,
  repository: EvidenceRepository,
  route: VerifiedDisclosurePolicyDecision,
  staging: EvidenceRepository = new InMemoryEvidenceRepository(),
): ContributionPreparationDependencies {
  const repositories: RepositoryResolver = {
    resolve: async (bindingId) => {
      if (bindingId === SOURCE_BINDING) return repository;
      if (bindingId === STAGING_BINDING) return staging;
      throw new Error(`unknown binding ${bindingId}`);
    },
  };
  const policies: DisclosurePolicyAuthority = { verify: async () => route };
  return {
    ...base,
    repositories,
    policies,
    derivations: { resolve: async () => silentDeriver() },
    reviews: {
      retain: async () => {
        throw new Error("unexpected review retain call");
      },
    },
  };
}

describe("prepareContribution", () => {
  test("prepares a derive-execution route to preview-ready", async () => {
    const base = dependencies();
    const { repository, proposalInput, route } = await seededExecutionEvidenceFixture();
    const created = await createContributionRequest(proposalInput, base);
    const deps = preparationDependencies(base, repository, route);
    const prepared = await prepareContribution(created.requestId, deps);
    expect(prepared.status).toBe("awaiting-authorization");
    expect(prepared.previewFingerprint).toBeDefined();
    expect(prepared.destinations).toHaveLength(1);
    expect(prepared.destinations[0]).toMatchObject({ status: "awaiting-authorization" });
  });

  test("is idempotent for a request already resolved", async () => {
    const base = dependencies();
    const { repository, proposalInput, route } = await seededExecutionEvidenceFixture();
    const created = await createContributionRequest(proposalInput, base);
    const deps = preparationDependencies(base, repository, route);
    const first = await prepareContribution(created.requestId, deps);
    const second = await prepareContribution(created.requestId, deps);
    expect(second).toEqual(first);
  });

  test("rejects preparing an unknown request", async () => {
    const base = dependencies();
    const { repository, route } = await seededExecutionEvidenceFixture();
    const deps = preparationDependencies(base, repository, route);
    await expect(prepareContribution("missing", deps))
      .rejects.toThrow(EvidenceContributionError);
  });

  test("dispatches a disclose-signed-unchanged route end to end", async () => {
    const base = dependencies();
    const repository = new InMemoryEvidenceRepository();
    const bytes = await loadGoldenFixture(
      "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
    );
    const receipt = await repository.putRecord("result-evaluation", bytes);
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
      idempotencyKey: "plugin:attempt-signed",
      source: { repositoryBindingId: SOURCE_BINDING, record: receipt.reference },
      policyDecision,
    });
    const created = await createContributionRequest(proposalInput, base);
    const deps = preparationDependencies(base, repository, route);
    const prepared = await prepareContribution(created.requestId, deps);
    expect(prepared.status).toBe("awaiting-authorization");
    expect(prepared.previewFingerprint).toBeDefined();
  });

  test("an authorized derive-execution destination reaches publishing end to end", async () => {
    const base = dependencies();
    const { repository, proposalInput, route } = await seededExecutionEvidenceFixture();
    const created = await createContributionRequest(proposalInput, base);
    const deps = preparationDependencies(base, repository, route);
    const prepared = await prepareContribution(created.requestId, deps);
    const targetDestination = proposalInput.destinations[0]!;
    const proofBytes = new Uint8Array([1, 2, 3]);
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
      verifyStandingGrant: async () => {
        throw new Error("unexpected standing grant call");
      },
      verifyStandingGrantRevocation: async () => {
        throw new Error("unexpected revocation call");
      },
      evaluateHostScope: async () => {
        throw new Error("unexpected host-scope call");
      },
    };
    const authDeps: ContributionAuthorizationDependencies = { ...base, authorization: authority };
    const { hashExactBytes } = await import("@jinn-network/evidence-publication");
    const authorized = await authorizeContribution(
      prepared.requestId,
      {
        mode: "interactive-exact",
        authorityId: "https://authority.example/host",
        actorId: "user-1",
        previewFingerprint: prepared.previewFingerprint!,
        allowedDestinationConfigurationDigests: [targetDestination.configurationDigest],
        decidedAt: "2026-07-28T00:00:00Z",
        proofDigest: hashExactBytes(proofBytes),
        proofBytes,
        exactPreviewPresented: true,
      },
      authDeps,
    );
    expect(authorized.status).toBe("publishing");
    expect(authorized.destinations).toEqual([
      expect.objectContaining({ destination: targetDestination.destination, status: "authorized" }),
    ]);
  });

  test("dispatches a withhold route to the withheld aggregate status", async () => {
    const base = dependencies();
    const { repository, proposalInput, route: deriveRoute } = await seededExecutionEvidenceFixture();
    const withholdRoute: VerifiedDisclosurePolicyDecision = {
      kind: "withhold",
      decision: deriveRoute.decision,
      source: deriveRoute.source,
      issuedAt: deriveRoute.issuedAt,
      reasons: [{ code: "POLICY_WITHHELD" }],
    };
    const created = await createContributionRequest(proposalInput, base);
    const deps = preparationDependencies(base, repository, withholdRoute);
    const prepared = await prepareContribution(created.requestId, deps);
    expect(prepared.status).toBe("withheld");
    expect(prepared.withheldReasons).toEqual([{ code: "POLICY_WITHHELD" }]);

    const { readContributionReceipt } = await import("./receipt.js");
    const receipt = await readContributionReceipt(created.requestId, base);
    expect(receipt.status).toBe("withheld");
    expect(receipt.withheldReasons).toEqual([{ code: "POLICY_WITHHELD" }]);
  });
});
