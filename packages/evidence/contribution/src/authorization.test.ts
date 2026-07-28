// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { hashExactBytes } from "@jinn-network/evidence-publication";
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
  applyStandingAuthorization,
  authorizeContribution,
  createStandingAuthorizationGrant,
  revokeStandingAuthorizationGrant,
  type AuthorizationAuthority,
} from "./authorization.js";
import {
  createContributionRequest,
  prepareContribution,
  type ContributionAuthorizationDependencies,
  type ContributionClock,
  type ContributionCommandBaseDependencies,
  type ContributionGrantDependencies,
  type ContributionIdentifierSource,
  type ContributionPreparationDependencies,
} from "./commands.js";
import { EvidenceContributionError } from "./errors.js";
import type { DisclosurePolicyAuthority } from "./policy.js";
import type { RepositoryResolver } from "./source.js";
import { InMemoryContributionStore } from "./testing-fixtures.js";
import type {
  ContributionDestination,
  ContributionReadModel,
  CreateContributionRequestInput,
  ExactAuthorizationSubmission,
  StandingGrantRevocationSubmission,
  StandingGrantSubmission,
  VerifiedDisclosurePolicyDecision,
  VerifiedExactAuthorization,
  VerifiedStandingGrant,
  VerifiedStandingGrantRevocation,
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

/**
 * Prepare one signed-unchanged Result Evaluation request to `preview-ready`
 * so authorization can be exercised against a real manifest. Signed
 * preparation is used (rather than derive-execution) because it needs no
 * `EvidenceDeriver` or review store.
 */
async function preparedRequest(
  destinations: readonly ContributionDestination[] = [destination()],
): Promise<{
  readonly deps: ContributionCommandBaseDependencies;
  readonly prepared: ContributionReadModel;
}> {
  const deps = base();
  const repository: EvidenceRepository = new InMemoryEvidenceRepository();
  const golden = await loadGoldenFixture(
    "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
  );
  const receipt = await repository.putRecord("result-evaluation", golden);
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
      if (bindingId === SOURCE_BINDING) return repository;
      if (bindingId === STAGING_BINDING) return new InMemoryEvidenceRepository();
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
  return { deps, prepared };
}

function exactSubmission(
  overrides: Partial<ExactAuthorizationSubmission> = {},
): ExactAuthorizationSubmission {
  const proofBytes = new TextEncoder().encode("proof");
  return {
    mode: "interactive-exact",
    authorityId: "https://authority.example/host",
    actorId: "user-1",
    previewFingerprint: `sha256:${"0".repeat(64)}` as Sha256Digest,
    allowedDestinationConfigurationDigests: [],
    decidedAt: "2026-07-28T00:00:00Z",
    proofDigest: hashExactBytes(proofBytes),
    proofBytes,
    exactPreviewPresented: true,
    ...overrides,
  };
}

function grantingAuthority(
  overrides: Partial<AuthorizationAuthority> = {},
): AuthorizationAuthority {
  return {
    verifyExact: async (submission) => ({
      mode: submission.mode,
      authorityId: submission.authorityId,
      actorId: submission.actorId,
      previewFingerprint: submission.previewFingerprint,
      allowedDestinationConfigurationDigests: submission.allowedDestinationConfigurationDigests,
      decidedAt: submission.decidedAt,
      ...(submission.expiresAt !== undefined ? { expiresAt: submission.expiresAt } : {}),
      proofDigest: submission.proofDigest,
      exactPreviewPresented: submission.exactPreviewPresented,
      deniedDestinations: [],
    } satisfies VerifiedExactAuthorization),
    verifyStandingGrant: async (submission) => ({
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
    } satisfies VerifiedStandingGrant),
    verifyStandingGrantRevocation: async (submission) => ({
      authorityId: submission.authorityId,
      actorId: submission.actorId,
      grantId: submission.grantId,
      expectedGrantVersion: submission.expectedGrantVersion,
      revokedAt: submission.revokedAt,
      reasonCode: submission.reasonCode,
      proofDigest: submission.proofDigest,
    } satisfies VerifiedStandingGrantRevocation),
    evaluateHostScope: async () => ({
      matches: true,
      decisionDigest: `sha256:${"1".repeat(64)}` as Sha256Digest,
    }),
    ...overrides,
  };
}

describe("authorizeContribution", () => {
  test("requires a prepared manifest before authorization", async () => {
    const deps = base();
    const created = await createContributionRequest(proposal(), deps);
    const authDeps: ContributionAuthorizationDependencies = {
      ...deps,
      authorization: grantingAuthority(),
    };
    await expect(
      authorizeContribution(created.requestId, exactSubmission(), authDeps),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("interactive-exact authorizes the manifest's destination and records the decision", async () => {
    const { deps, prepared } = await preparedRequest();
    const authDeps: ContributionAuthorizationDependencies = {
      ...deps,
      authorization: grantingAuthority(),
    };
    const target = destination();
    const result = await authorizeContribution(
      prepared.requestId,
      exactSubmission({
        previewFingerprint: prepared.previewFingerprint!,
        allowedDestinationConfigurationDigests: [target.configurationDigest],
      }),
      authDeps,
    );
    expect(result.destinations).toEqual([
      expect.objectContaining({ destination: target.destination, status: "authorized" }),
    ]);
    expect(result.status).toBe("publishing");
  });

  test("organization-exact never claims a human preview", async () => {
    const { deps, prepared } = await preparedRequest();
    const target = destination();
    const authDeps: ContributionAuthorizationDependencies = {
      ...deps,
      authorization: grantingAuthority({
        verifyExact: async (submission) => ({
          mode: "organization-exact",
          authorityId: submission.authorityId,
          actorId: submission.actorId,
          previewFingerprint: submission.previewFingerprint,
          allowedDestinationConfigurationDigests: [target.configurationDigest],
          decidedAt: submission.decidedAt,
          proofDigest: submission.proofDigest,
          exactPreviewPresented: false,
          deniedDestinations: [],
        }),
      }),
    };
    const result = await authorizeContribution(
      prepared.requestId,
      exactSubmission({
        mode: "organization-exact",
        previewFingerprint: prepared.previewFingerprint!,
        exactPreviewPresented: false,
        allowedDestinationConfigurationDigests: [target.configurationDigest],
      }),
      authDeps,
    );
    expect(result.destinations[0]?.status).toBe("authorized");
  });

  test("a stale preview fingerprint is rejected", async () => {
    const { deps, prepared } = await preparedRequest();
    const authDeps: ContributionAuthorizationDependencies = {
      ...deps,
      authorization: grantingAuthority(),
    };
    await expect(
      authorizeContribution(
        prepared.requestId,
        exactSubmission({ previewFingerprint: `sha256:${"9".repeat(64)}` as Sha256Digest }),
        authDeps,
      ),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("an exact decision may authorize a destination subset and deny the rest", async () => {
    const authorized = destination({ destination: "https://a.example", configurationDigest: `sha256:${"1".repeat(64)}` as Sha256Digest });
    const denied = destination({ destination: "https://b.example", configurationDigest: `sha256:${"2".repeat(64)}` as Sha256Digest });
    const { deps, prepared } = await preparedRequest([authorized, denied]);
    const authDeps: ContributionAuthorizationDependencies = {
      ...deps,
      authorization: grantingAuthority({
        verifyExact: async (submission) => ({
          mode: submission.mode,
          authorityId: submission.authorityId,
          actorId: submission.actorId,
          previewFingerprint: submission.previewFingerprint,
          allowedDestinationConfigurationDigests: [authorized.configurationDigest],
          decidedAt: submission.decidedAt,
          proofDigest: submission.proofDigest,
          exactPreviewPresented: true,
          deniedDestinations: [
            { configurationDigest: denied.configurationDigest, reasonCode: "DESTINATION_DENIED" },
          ],
        }),
      }),
    };
    const result = await authorizeContribution(
      prepared.requestId,
      exactSubmission({ previewFingerprint: prepared.previewFingerprint! }),
      authDeps,
    );
    expect(result.destinations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ destination: "https://a.example", status: "authorized" }),
        expect.objectContaining({
          destination: "https://b.example",
          status: "denied",
          reasonCode: "DESTINATION_DENIED",
        }),
      ]),
    );
  });

  test("an already-expired decision is rejected", async () => {
    const { deps, prepared } = await preparedRequest();
    const target = destination();
    const authDeps: ContributionAuthorizationDependencies = {
      ...deps,
      authorization: grantingAuthority({
        verifyExact: async (submission) => ({
          mode: submission.mode,
          authorityId: submission.authorityId,
          actorId: submission.actorId,
          previewFingerprint: submission.previewFingerprint,
          allowedDestinationConfigurationDigests: [target.configurationDigest],
          decidedAt: submission.decidedAt,
          expiresAt: "2026-07-27T23:59:59Z",
          proofDigest: submission.proofDigest,
          exactPreviewPresented: true,
          deniedDestinations: [],
        }),
      }),
    };
    await expect(
      authorizeContribution(
        prepared.requestId,
        exactSubmission({
          previewFingerprint: prepared.previewFingerprint!,
          expiresAt: "2026-07-27T23:59:59Z",
        }),
        authDeps,
      ),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("authority proof bytes never enter the stored decision", async () => {
    const { deps, prepared } = await preparedRequest();
    const target = destination();
    const authDeps: ContributionAuthorizationDependencies = {
      ...deps,
      authorization: grantingAuthority(),
    };
    await authorizeContribution(
      prepared.requestId,
      exactSubmission({
        previewFingerprint: prepared.previewFingerprint!,
        allowedDestinationConfigurationDigests: [target.configurationDigest],
      }),
      authDeps,
    );
    const stored = await deps.store.loadRequest(prepared.requestId);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("proofBytes");
    expect(serialized).not.toMatch(/"proof"/);
  });
});

describe("standing authorization grants", () => {
  function grantSubmission(
    overrides: Partial<StandingGrantSubmission> = {},
  ): StandingGrantSubmission {
    const proofBytes = new TextEncoder().encode("grant-proof");
    return {
      authorityId: "https://authority.example/host",
      actorId: "user-1",
      sourceScope: { kind: "host-scope", scopeDigest: `sha256:${"7".repeat(64)}` as Sha256Digest },
      allowedFamilies: ["result-evaluation"],
      policyAuthorityIds: ["https://authority.example/policy"],
      policyProfiles: [],
      policyDigests: [],
      implementationDigests: [],
      derivationConfigurationDigests: [],
      destinationConfigurationDigests: [destination().configurationDigest],
      limits: {
        maxDestinations: 4,
        maxArtifacts: 128,
        maxArtifactBytes: 16_777_216,
        maxTotalArtifactBytes: 67_108_864,
        maxManifestBytes: 1_048_576,
        maxConcurrentDestinations: 2,
      },
      issuedAt: "2026-07-28T00:00:00Z",
      proofDigest: hashExactBytes(proofBytes),
      proofBytes,
      ...overrides,
    };
  }

  test("creates a grant and matches a prepared request under host scope", async () => {
    const { deps, prepared } = await preparedRequest();
    const grantDeps: ContributionGrantDependencies = {
      ...deps,
      authorization: grantingAuthority(),
    };
    const grant = await createStandingAuthorizationGrant(grantSubmission(), grantDeps);
    expect(grant.revoked).toBe(false);

    const authDeps: ContributionAuthorizationDependencies = grantDeps;
    const result = await applyStandingAuthorization(prepared.requestId, grant.grantId, authDeps);
    expect(result.destinations[0]?.status).toBe("authorized");
  });

  test("review-required and withheld requests never match a standing grant", async () => {
    const deps = base();
    const created = await createContributionRequest(proposal(), deps);
    const grantDeps: ContributionGrantDependencies = {
      ...deps,
      authorization: grantingAuthority(),
    };
    const grant = await createStandingAuthorizationGrant(grantSubmission(), grantDeps);
    await expect(
      applyStandingAuthorization(created.requestId, grant.grantId, grantDeps),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("revocation is append-only and blocks not-yet-started application", async () => {
    const { deps, prepared } = await preparedRequest();
    const grantDeps: ContributionGrantDependencies = {
      ...deps,
      authorization: grantingAuthority(),
    };
    const grant = await createStandingAuthorizationGrant(grantSubmission(), grantDeps);
    const proofBytes = new TextEncoder().encode("revoke-proof");
    const revocation: StandingGrantRevocationSubmission = {
      authorityId: "https://authority.example/host",
      actorId: "user-1",
      grantId: grant.grantId,
      expectedGrantVersion: grant.revision,
      revokedAt: "2026-07-28T00:05:00Z",
      reasonCode: "OPERATOR_ATTENTION_REQUIRED",
      proofDigest: hashExactBytes(proofBytes),
      proofBytes,
    };
    const revoked = await revokeStandingAuthorizationGrant(grant.grantId, revocation, grantDeps);
    expect(revoked.revoked).toBe(true);

    await expect(
      applyStandingAuthorization(prepared.requestId, grant.grantId, grantDeps),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("a stale expected grant version is rejected", async () => {
    const deps = base();
    const grantDeps: ContributionGrantDependencies = {
      ...deps,
      authorization: grantingAuthority(),
    };
    const grant = await createStandingAuthorizationGrant(grantSubmission(), grantDeps);
    const proofBytes = new TextEncoder().encode("revoke-proof");
    const revocation: StandingGrantRevocationSubmission = {
      authorityId: "https://authority.example/host",
      actorId: "user-1",
      grantId: grant.grantId,
      expectedGrantVersion: grant.revision + 1,
      revokedAt: "2026-07-28T00:05:00Z",
      reasonCode: "OPERATOR_ATTENTION_REQUIRED",
      proofDigest: hashExactBytes(proofBytes),
      proofBytes,
    };
    await expect(
      revokeStandingAuthorizationGrant(grant.grantId, revocation, grantDeps),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("a request records the exact grant ID and match decision", async () => {
    const { deps, prepared } = await preparedRequest();
    const grantDeps: ContributionGrantDependencies = {
      ...deps,
      authorization: grantingAuthority(),
    };
    const grant = await createStandingAuthorizationGrant(grantSubmission(), grantDeps);
    await applyStandingAuthorization(prepared.requestId, grant.grantId, grantDeps);
    const stored = await deps.store.loadRequest(prepared.requestId);
    expect(stored?.value.destinations[0]?.authorization).toMatchObject({
      status: "authorized",
      grantId: grant.grantId,
    });
  });
});
