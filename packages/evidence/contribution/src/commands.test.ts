// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
  createContributionRequest,
  inspectContribution,
  type ContributionClock,
  type ContributionCommandBaseDependencies,
  type ContributionIdentifierSource,
} from "./commands.js";
import { EvidenceContributionError } from "./errors.js";
import { InMemoryContributionStore } from "./testing-fixtures.js";
import type { CreateContributionRequestInput } from "./types.js";

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
