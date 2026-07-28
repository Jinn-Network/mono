// SPDX-License-Identifier: Apache-2.0
import {
  createBuiltinDerivationDetectors,
  createEvidenceDeriver,
} from "@jinn-network/evidence-derivation";
import {
  createSyntheticDerivationInput,
} from "@jinn-network/evidence-derivation/testing";
import type {
  DerivationFinding,
  DerivationHoldReason,
  DeriveExecutionEvidenceInput,
  EvidenceDeriver,
  EvidenceDerivationOutcome,
} from "@jinn-network/evidence-derivation";
import {
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test, vi } from "vitest";

import { EvidenceContributionError } from "./errors.js";
import type { DerivationResolver, ReviewReferenceStore } from "./policy.js";
import { prepareExecutionDisclosure } from "./prepare-execution.js";
import type { RepositoryResolver } from "./source.js";
import type {
  ContributionDestination,
  VerifiedDeriveExecutionDecision,
} from "./types.js";

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

function destination(): ContributionDestination {
  return {
    destination: "https://destinations.example/ipfs",
    medium: "https://media.example/ipfs",
    profile: "https://profiles.example/evidence/v1",
    configurationDigest: `sha256:${"c".repeat(64)}`,
    label: "Public IPFS",
    irreversible: true,
    deactivation: "unsupported",
  };
}

async function seedSourceRepository(): Promise<{
  readonly repository: EvidenceRepository;
  readonly input: DeriveExecutionEvidenceInput;
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
  const route: VerifiedDeriveExecutionDecision = {
    kind: "derive-execution",
    decision: {
      authorityId: "https://authority.example/policy",
      decisionId: "decision-1",
      digest: `sha256:${"a".repeat(64)}`,
    },
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
  return { repository, input, route };
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

function derivationsFor(deriver: EvidenceDeriver): DerivationResolver {
  return { resolve: async () => deriver };
}

function neverReviews(): ReviewReferenceStore {
  return {
    retain: async () => {
      throw new Error("unexpected review retain call");
    },
  };
}

describe("prepareExecutionDisclosure", () => {
  test("stages a publishable-unchanged outcome and builds a preview-ready manifest", async () => {
    const { repository, input, route } = await seedSourceRepository();
    const staging = new InMemoryEvidenceRepository();
    const result = await prepareExecutionDisclosure(
      {
        requestId: "request-1",
        intentFingerprint: `sha256:${"e".repeat(64)}`,
        source: { reference: input.sourceRecord.reference, bytes: input.sourceRecord.bytes },
        sourceRepositoryBindingId: SOURCE_BINDING,
        stagingRepositoryBindingId: STAGING_BINDING,
        route,
        destinations: [destination()],
      },
      {
        repositories: resolverFor({ [SOURCE_BINDING]: repository, [STAGING_BINDING]: staging }),
        derivations: derivationsFor(silentDeriver()),
        reviews: neverReviews(),
      },
    );
    expect(result.status).toBe("preview-ready");
    if (result.status !== "preview-ready") return;
    expect(result.disclosure.manifest.preparation.kind).toBe("publishable-unchanged");
    expect(result.disclosure.manifest.preparedRecord).toEqual(input.sourceRecord.reference);
    expect(result.disclosure.manifest.bindingImpact).toEqual({
      executionVerification: "existing-verification-applicable",
      resultEvaluation: "preserved-for-exact-subjects",
      taskDerived: false,
      resultDerived: false,
    });
    // staged bytes are readable back from staging by their exact reference
    await expect(staging.getRecord(input.sourceRecord.reference))
      .resolves.toEqual(input.sourceRecord.bytes);
  });

  test("pairs source artifact entity IDs with their correct exact bytes", async () => {
    const { repository, input, route } = await seedSourceRepository();
    const staging = new InMemoryEvidenceRepository();
    const deriveSpy = vi.fn(silentDeriver().derive);
    const spiedDeriver: EvidenceDeriver = { derive: deriveSpy };
    await prepareExecutionDisclosure(
      {
        requestId: "request-1",
        intentFingerprint: `sha256:${"e".repeat(64)}`,
        source: { reference: input.sourceRecord.reference, bytes: input.sourceRecord.bytes },
        sourceRepositoryBindingId: SOURCE_BINDING,
        stagingRepositoryBindingId: STAGING_BINDING,
        route,
        destinations: [destination()],
      },
      {
        repositories: resolverFor({ [SOURCE_BINDING]: repository, [STAGING_BINDING]: staging }),
        derivations: derivationsFor(spiedDeriver),
        reviews: neverReviews(),
      },
    );
    const passedInput = deriveSpy.mock.calls[0]![0] as DeriveExecutionEvidenceInput;
    expect(passedInput.sourceArtifacts).toEqual(input.sourceArtifacts);
  });

  test("review-required sends findings only to the review store and stages no payload", async () => {
    const { repository, input, route } = await seedSourceRepository();
    const staging = new InMemoryEvidenceRepository();
    const findings: readonly DerivationFinding[] = [{
      class: "email",
      confidence: "HIGH",
      surfaceId: "trace/trajectory.jsonl",
      start: 0,
      end: 1,
      evidence: [],
      detector: {
        id: "test-detector",
        version: "1.0.0",
        implementationDigest: `sha256:${"9".repeat(64)}`,
        reproducibility: "byte-stable",
      },
    }];
    const reviewRetain = vi.fn(async () => ({ reviewReference: "review-42" }));
    const reviewRequiredDeriver: EvidenceDeriver = {
      derive: async () => ({ status: "review-required", findings }),
    };
    const result = await prepareExecutionDisclosure(
      {
        requestId: "request-1",
        intentFingerprint: `sha256:${"e".repeat(64)}`,
        source: { reference: input.sourceRecord.reference, bytes: input.sourceRecord.bytes },
        sourceRepositoryBindingId: SOURCE_BINDING,
        stagingRepositoryBindingId: STAGING_BINDING,
        route,
        destinations: [destination()],
      },
      {
        repositories: resolverFor({ [SOURCE_BINDING]: repository, [STAGING_BINDING]: staging }),
        derivations: derivationsFor(reviewRequiredDeriver),
        reviews: { retain: reviewRetain },
      },
    );
    expect(result).toEqual({ status: "review-required", reviewReference: "review-42" });
    expect(reviewRetain).toHaveBeenCalledWith(
      { requestId: "request-1", findings },
      undefined,
    );
    await expect(staging.getRecord(input.sourceRecord.reference)).resolves.toBeNull();
  });

  test("withheld stores only content-free safe reason codes", async () => {
    const { repository, input, route } = await seedSourceRepository();
    const staging = new InMemoryEvidenceRepository();
    const reasons: readonly DerivationHoldReason[] = [{ code: "some-upstream-reason" }];
    const withholdingDeriver: EvidenceDeriver = {
      derive: async () => ({ status: "withheld", reasons }),
    };
    const result = await prepareExecutionDisclosure(
      {
        requestId: "request-1",
        intentFingerprint: `sha256:${"e".repeat(64)}`,
        source: { reference: input.sourceRecord.reference, bytes: input.sourceRecord.bytes },
        sourceRepositoryBindingId: SOURCE_BINDING,
        stagingRepositoryBindingId: STAGING_BINDING,
        route,
        destinations: [destination()],
      },
      {
        repositories: resolverFor({ [SOURCE_BINDING]: repository, [STAGING_BINDING]: staging }),
        derivations: derivationsFor(withholdingDeriver),
        reviews: neverReviews(),
      },
    );
    expect(result).toEqual({ status: "withheld", reasons: [{ code: "POLICY_WITHHELD" }] });
  });

  test("re-validates output Protocol conformance and rejects nonconforming derived bytes", async () => {
    const { repository, input, route } = await seedSourceRepository();
    const staging = new InMemoryEvidenceRepository();
    const garbage = new TextEncoder().encode(JSON.stringify({ garbage: true }));
    const badDeriver: EvidenceDeriver = {
      derive: async (): Promise<EvidenceDerivationOutcome> => ({
        status: "publishable-unchanged",
        record: {
          reference: { family: "execution-evidence" as const, digest: createRecordReference("execution-evidence", garbage).digest },
          bytes: garbage,
        },
        artifacts: [],
        bindingImpact: {
          executionVerification: "existing-verification-applicable",
          resultEvaluation: "preserved-for-exact-subjects",
          taskDerived: false,
          resultDerived: false,
        },
      }),
    };
    await expect(
      prepareExecutionDisclosure(
        {
          requestId: "request-1",
          intentFingerprint: `sha256:${"e".repeat(64)}`,
          source: { reference: input.sourceRecord.reference, bytes: input.sourceRecord.bytes },
          sourceRepositoryBindingId: SOURCE_BINDING,
          stagingRepositoryBindingId: STAGING_BINDING,
          route,
          destinations: [destination()],
        },
        {
          repositories: resolverFor({ [SOURCE_BINDING]: repository, [STAGING_BINDING]: staging }),
          derivations: derivationsFor(badDeriver),
          reviews: neverReviews(),
        },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_NONCONFORMING" });
  });

  test("cancellation leaves the private source untouched", async () => {
    const { repository, input, route } = await seedSourceRepository();
    const staging = new InMemoryEvidenceRepository();
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareExecutionDisclosure(
        {
          requestId: "request-1",
          intentFingerprint: `sha256:${"e".repeat(64)}`,
          source: { reference: input.sourceRecord.reference, bytes: input.sourceRecord.bytes },
          sourceRepositoryBindingId: SOURCE_BINDING,
          stagingRepositoryBindingId: STAGING_BINDING,
          route,
          destinations: [destination()],
        },
        {
          repositories: resolverFor({ [SOURCE_BINDING]: repository, [STAGING_BINDING]: staging }),
          derivations: derivationsFor(silentDeriver()),
          reviews: neverReviews(),
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    // the source record is unchanged and still exactly readable
    await expect(repository.getRecord(input.sourceRecord.reference))
      .resolves.toEqual(input.sourceRecord.bytes);
  });

  test("rejects preparing a non-execution-evidence source through the derive route", async () => {
    const { repository, input, route } = await seedSourceRepository();
    const staging = new InMemoryEvidenceRepository();
    await expect(
      prepareExecutionDisclosure(
        {
          requestId: "request-1",
          intentFingerprint: `sha256:${"e".repeat(64)}`,
          source: {
            reference: { family: "result-evaluation", digest: input.sourceRecord.reference.digest },
            bytes: input.sourceRecord.bytes,
          },
          sourceRepositoryBindingId: SOURCE_BINDING,
          stagingRepositoryBindingId: STAGING_BINDING,
          route,
          destinations: [destination()],
        },
        {
          repositories: resolverFor({ [SOURCE_BINDING]: repository, [STAGING_BINDING]: staging }),
          derivations: derivationsFor(silentDeriver()),
          reviews: neverReviews(),
        },
      ),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });
  });
});
