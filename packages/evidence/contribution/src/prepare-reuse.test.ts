// SPDX-License-Identifier: Apache-2.0
import {
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import type { EvidenceRepository, Sha256Digest } from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test } from "vitest";

import { createPreparedDisclosureManifest } from "./manifest.js";
import { prepareReusableDisclosure } from "./prepare-reuse.js";
import type { RepositoryResolver } from "./source.js";
import type { ContributionDestination, VerifiedReuseDecision } from "./types.js";

const SOURCE_BINDING = "private-local";
const STAGING_BINDING = "private-staging";

function destination(
  overrides: Partial<ContributionDestination> = {},
): ContributionDestination {
  return {
    destination: "https://destinations.example/ipfs",
    medium: "https://media.example/ipfs",
    profile: "https://profiles.example/evidence/v1",
    configurationDigest: `sha256:${"c".repeat(64)}`,
    label: "Public IPFS",
    irreversible: true,
    deactivation: "unsupported",
    ...overrides,
  };
}

function resolverFor(
  repositories: Readonly<Record<string, EvidenceRepository>>,
): RepositoryResolver {
  return {
    resolve: async (bindingId) => {
      const repository = repositories[bindingId];
      if (repository === undefined) throw new Error(`unknown binding ${bindingId}`);
      return repository;
    },
  };
}

interface Fixture {
  readonly source: EvidenceRepository;
  readonly sourceReference: ReturnType<typeof createRecordReference>;
  readonly priorManifestBytes: Uint8Array;
  readonly priorManifestReference: ReturnType<typeof createArtifactReference>;
  readonly route: VerifiedReuseDecision;
}

async function seededReuseFixture(): Promise<Fixture> {
  const source = new InMemoryEvidenceRepository();
  const sourceBytes = new TextEncoder().encode(JSON.stringify({ source: true }));
  const sourceReference = createRecordReference("execution-evidence", sourceBytes);
  await source.putRecord("execution-evidence", sourceBytes);

  const preparedRecordBytes = new TextEncoder().encode(JSON.stringify({ prepared: true }));
  const preparedRecordReceipt = await source.putRecord("execution-evidence", preparedRecordBytes);
  const artifactBytes = new TextEncoder().encode("prior artifact bytes");
  const artifactReceipt = await source.putArtifact(artifactBytes);

  const priorDestination = destination({ destination: "https://prior-destination.example" });
  const priorDisclosure = createPreparedDisclosureManifest({
    requestId: "prior-request",
    intentFingerprint: `sha256:${"1".repeat(64)}`,
    source: sourceReference,
    preparedRecord: preparedRecordReceipt.reference,
    artifacts: [artifactReceipt.reference],
    preparation: {
      kind: "derived",
      derivationReceipt: { digest: `sha256:${"2".repeat(64)}` },
      policyInput: { digest: `sha256:${"3".repeat(64)}` },
      implementationDescriptor: { digest: `sha256:${"4".repeat(64)}` },
      policyDigest: `sha256:${"5".repeat(64)}` as Sha256Digest,
      implementationDigest: `sha256:${"6".repeat(64)}` as Sha256Digest,
    },
    policyDecision: {
      authorityId: "https://authority.example/policy",
      decisionId: "prior-decision",
      digest: `sha256:${"7".repeat(64)}`,
    },
    destinations: [priorDestination],
    unavailableArtifacts: [],
    risk: {
      irreversibility: "immutable-or-replicable",
      sourceCommitmentCorrelation: "none-declared",
    },
  });
  const priorManifestReceipt = await source.putArtifact(priorDisclosure.manifestBytes);

  const route: VerifiedReuseDecision = {
    kind: "reuse-prepared",
    decision: {
      authorityId: "https://authority.example/policy",
      decisionId: "new-decision",
      digest: `sha256:${"8".repeat(64)}`,
    },
    source: sourceReference,
    issuedAt: "2026-07-28T00:00:00Z",
    priorManifest: priorManifestReceipt.reference,
    expectedPriorPreviewFingerprint: priorDisclosure.previewFingerprint,
    preparedRecord: preparedRecordReceipt.reference,
    preparedArtifacts: [artifactReceipt.reference],
    policyDigest: `sha256:${"5".repeat(64)}` as Sha256Digest,
    implementationDigest: `sha256:${"6".repeat(64)}` as Sha256Digest,
  };

  return {
    source,
    sourceReference,
    priorManifestBytes: priorDisclosure.manifestBytes,
    priorManifestReference: priorManifestReceipt.reference,
    route,
  };
}

describe("prepareReusableDisclosure", () => {
  test("reuses a prior manifest for new destinations, producing new Publication identities", async () => {
    const fixture = await seededReuseFixture();
    const staging = new InMemoryEvidenceRepository();
    const newDestination = destination({ destination: "https://new-destination.example" });
    const result = await prepareReusableDisclosure(
      {
        requestId: "request-2",
        intentFingerprint: `sha256:${"9".repeat(64)}`,
        source: { reference: fixture.sourceReference, bytes: new TextEncoder().encode(JSON.stringify({ source: true })) },
        route: fixture.route,
        sourceRepositoryBindingId: SOURCE_BINDING,
        stagingRepositoryBindingId: STAGING_BINDING,
        destinations: [newDestination],
      },
      resolverFor({ [SOURCE_BINDING]: fixture.source, [STAGING_BINDING]: staging }),
    );
    expect(result.status).toBe("preview-ready");
    expect(result.disclosure.manifest.preparation).toEqual({
      kind: "verified-reuse",
      priorPreviewFingerprint: fixture.route.expectedPriorPreviewFingerprint,
    });
    // only the new destination appears -- prior destination authorization is not imported
    expect(result.disclosure.manifest.destinations).toHaveLength(1);
    expect(result.disclosure.manifest.destinations[0]!.descriptor.destination)
      .toBe(newDestination.destination);
    // new destination -> new bundle/payload identities, not copied from the prior manifest
    expect(result.disclosure.previewFingerprint).not.toBe(fixture.route.expectedPriorPreviewFingerprint);
  });

  test("requires the prior manifest bytes to hash to the expected preview fingerprint", async () => {
    const fixture = await seededReuseFixture();
    const staging = new InMemoryEvidenceRepository();
    const tamperedRoute: VerifiedReuseDecision = {
      ...fixture.route,
      expectedPriorPreviewFingerprint: `sha256:${"0".repeat(64)}` as Sha256Digest,
    };
    await expect(
      prepareReusableDisclosure(
        {
          requestId: "request-2",
          intentFingerprint: `sha256:${"9".repeat(64)}`,
          source: { reference: fixture.sourceReference, bytes: new TextEncoder().encode(JSON.stringify({ source: true })) },
          route: tamperedRoute,
          sourceRepositoryBindingId: SOURCE_BINDING,
          stagingRepositoryBindingId: STAGING_BINDING,
          destinations: [destination()],
        },
        resolverFor({ [SOURCE_BINDING]: fixture.source, [STAGING_BINDING]: staging }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });
  });

  test("rejects reuse when the prior source does not match the new source", async () => {
    const fixture = await seededReuseFixture();
    const staging = new InMemoryEvidenceRepository();
    const differentSource = {
      family: "execution-evidence" as const,
      digest: `sha256:${"d".repeat(64)}` as Sha256Digest,
    };
    await expect(
      prepareReusableDisclosure(
        {
          requestId: "request-2",
          intentFingerprint: `sha256:${"9".repeat(64)}`,
          source: { reference: differentSource, bytes: new Uint8Array() },
          route: fixture.route,
          sourceRepositoryBindingId: SOURCE_BINDING,
          stagingRepositoryBindingId: STAGING_BINDING,
          destinations: [destination()],
        },
        resolverFor({ [SOURCE_BINDING]: fixture.source, [STAGING_BINDING]: staging }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("reloads and digest-verifies every reused record and artifact byte", async () => {
    const fixture = await seededReuseFixture();
    const tamperingSource: EvidenceRepository = {
      capabilities: Object.freeze({}),
      putRecord: fixture.source.putRecord.bind(fixture.source),
      putArtifact: fixture.source.putArtifact.bind(fixture.source),
      getRecord: fixture.source.getRecord.bind(fixture.source),
      getArtifact: async (reference) => {
        if (reference.digest === fixture.route.priorManifest.digest) {
          return fixture.priorManifestBytes;
        }
        // return wrong bytes for the reused artifact
        return new TextEncoder().encode("tampered bytes");
      },
    };
    const staging = new InMemoryEvidenceRepository();
    await expect(
      prepareReusableDisclosure(
        {
          requestId: "request-2",
          intentFingerprint: `sha256:${"9".repeat(64)}`,
          source: { reference: fixture.sourceReference, bytes: new Uint8Array() },
          route: fixture.route,
          sourceRepositoryBindingId: SOURCE_BINDING,
          stagingRepositoryBindingId: STAGING_BINDING,
          destinations: [destination()],
        },
        resolverFor({ [SOURCE_BINDING]: tamperingSource, [STAGING_BINDING]: staging }),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH" });
  });

  test("rejects reuse when the implementation identity has changed", async () => {
    const fixture = await seededReuseFixture();
    const staging = new InMemoryEvidenceRepository();
    const changedRoute: VerifiedReuseDecision = {
      ...fixture.route,
      implementationDigest: `sha256:${"f".repeat(64)}` as Sha256Digest,
    };
    await expect(
      prepareReusableDisclosure(
        {
          requestId: "request-2",
          intentFingerprint: `sha256:${"9".repeat(64)}`,
          source: { reference: fixture.sourceReference, bytes: new Uint8Array() },
          route: changedRoute,
          sourceRepositoryBindingId: SOURCE_BINDING,
          stagingRepositoryBindingId: STAGING_BINDING,
          destinations: [destination()],
        },
        resolverFor({ [SOURCE_BINDING]: fixture.source, [STAGING_BINDING]: staging }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });
});
