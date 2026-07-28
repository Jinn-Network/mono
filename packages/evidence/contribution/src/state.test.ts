// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { EvidenceContributionError } from "./errors.js";
import {
  acquireContributionWorkClaim,
  assertValidPreparationTransition,
  createProposedContributionRequestState,
  deriveContributionAggregateStatus,
  releaseContributionWorkClaim,
  type ContributionDestinationState,
  type ContributionRequestState,
} from "./state.js";
import type { CreateContributionRequestInput } from "./types.js";

function proposal(): CreateContributionRequestInput {
  return {
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
  };
}

function proposedState(): ContributionRequestState {
  return createProposedContributionRequestState({
    requestId: "request-1",
    proposal: proposal(),
    proposalFingerprint: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-07-28T00:00:00Z",
  });
}

function destinationState(
  overrides: Partial<ContributionDestinationState> = {},
): ContributionDestinationState {
  return {
    destination: "https://a.example",
    authorization: { status: "awaiting-authorization" },
    publication: { status: "not-started" },
    deactivation: { requested: false },
    ...overrides,
  };
}

function previewReadyState(
  destinations: readonly ContributionDestinationState[],
): ContributionRequestState {
  return {
    ...proposedState(),
    preparation: {
      status: "preview-ready",
      disclosure: {
        manifest: {} as never,
        manifestBytes: new Uint8Array(),
        previewFingerprint: `sha256:${"e".repeat(64)}`,
      },
    },
    destinations,
  };
}

describe("assertValidPreparationTransition", () => {
  test("allows proposed to move to preparing or declined", () => {
    expect(() => assertValidPreparationTransition("proposed", "preparing"))
      .not.toThrow();
    expect(() => assertValidPreparationTransition("proposed", "declined"))
      .not.toThrow();
  });

  test("rejects preparation skipping directly from proposed to preview-ready", () => {
    expect(() => assertValidPreparationTransition("proposed", "preview-ready"))
      .toThrow(EvidenceContributionError);
  });

  test("rejects an already-terminal declined state moving anywhere", () => {
    expect(() => assertValidPreparationTransition("declined", "preparing"))
      .toThrow(EvidenceContributionError);
  });
});

describe("deriveContributionAggregateStatus", () => {
  test("passes through the preparation status before preview-ready", () => {
    expect(deriveContributionAggregateStatus(proposedState())).toBe("proposed");
  });

  test("preview-ready with destinations awaiting authorization does not imply authorization", () => {
    const state = previewReadyState([destinationState()]);
    expect(deriveContributionAggregateStatus(state)).toBe("awaiting-authorization");
  });

  test("authorization and publication are independent per destination", () => {
    const state = previewReadyState([
      destinationState({
        destination: "https://a.example",
        authorization: { status: "authorized" },
        publication: { status: "publishing" },
      }),
      destinationState({ destination: "https://b.example" }),
    ]);
    // one destination active/publishing, the other still awaiting its own
    // independent authorization -- no all-destinations transaction.
    expect(deriveContributionAggregateStatus(state)).toBe("publishing");
  });

  test("mixed success and denial derive attention-required", () => {
    const state = previewReadyState([
      destinationState({
        destination: "https://a.example",
        authorization: { status: "authorized" },
        publication: { status: "published", publishedAt: "2026-07-28T00:00:01Z" },
      }),
      destinationState({
        destination: "https://b.example",
        authorization: { status: "denied", reasonCode: "DESTINATION_DENIED" },
      }),
      destinationState({ destination: "https://c.example" }),
    ]);
    expect(deriveContributionAggregateStatus(state)).toBe("attention-required");
  });

  test("requires at least one completed Publication receipt for completed", () => {
    const allDenied = previewReadyState([
      destinationState({
        destination: "https://a.example",
        authorization: { status: "denied", reasonCode: "DESTINATION_DENIED" },
      }),
    ]);
    expect(deriveContributionAggregateStatus(allDenied)).toBe("declined");

    const oneCompleted = previewReadyState([
      destinationState({
        destination: "https://a.example",
        authorization: { status: "authorized" },
        publication: { status: "published", publishedAt: "2026-07-28T00:00:01Z" },
      }),
      destinationState({
        destination: "https://b.example",
        authorization: { status: "denied", reasonCode: "DESTINATION_DENIED" },
      }),
    ]);
    expect(deriveContributionAggregateStatus(oneCompleted)).toBe("completed");
  });

  test("deactivation remains orthogonal to an in-flight publish", () => {
    const state = previewReadyState([
      destinationState({
        destination: "https://a.example",
        authorization: { status: "authorized" },
        publication: { status: "publishing" },
        deactivation: { requested: true, requestedAt: "2026-07-28T00:00:01Z" },
      }),
    ]);
    // deactivation was requested but the already-started Publication may
    // still reconcile -- it does not immediately become "deactivated".
    expect(deriveContributionAggregateStatus(state)).toBe("publishing");
  });

  test("every destination deactivated derives deactivated", () => {
    const state = previewReadyState([
      destinationState({
        destination: "https://a.example",
        deactivation: { requested: true, requestedAt: "2026-07-28T00:00:01Z" },
      }),
    ]);
    expect(deriveContributionAggregateStatus(state)).toBe("deactivated");
  });
});

describe("work claims", () => {
  test("an expired claim may be replaced by another owner", () => {
    const claimed = acquireContributionWorkClaim(
      proposedState(),
      "worker-a",
      "2026-07-28T00:00:00Z",
      "2026-07-28T00:00:01Z",
    );
    const reclaimed = acquireContributionWorkClaim(
      claimed,
      "worker-b",
      "2026-07-28T00:00:02Z",
      "2026-07-28T00:00:03Z",
    );
    expect(reclaimed.workClaim).toMatchObject({ ownerId: "worker-b", generation: 2 });
  });

  test("a live claim held by another owner is retained", () => {
    const claimed = acquireContributionWorkClaim(
      proposedState(),
      "worker-a",
      "2026-07-28T00:00:00Z",
      "2026-07-28T01:00:00Z",
    );
    expect(() =>
      acquireContributionWorkClaim(
        claimed,
        "worker-b",
        "2026-07-28T00:00:01Z",
        "2026-07-28T01:00:01Z",
      )).toThrow(EvidenceContributionError);
  });

  test("releasing with the wrong generation is rejected", () => {
    const claimed = acquireContributionWorkClaim(
      proposedState(),
      "worker-a",
      "2026-07-28T00:00:00Z",
      "2026-07-28T01:00:00Z",
    );
    expect(() => releaseContributionWorkClaim(claimed, "worker-a", 99))
      .toThrow(EvidenceContributionError);
  });

  test("releasing with the matching owner and generation clears the claim", () => {
    const claimed = acquireContributionWorkClaim(
      proposedState(),
      "worker-a",
      "2026-07-28T00:00:00Z",
      "2026-07-28T01:00:00Z",
    );
    const released = releaseContributionWorkClaim(claimed, "worker-a", 1);
    expect(released.workClaim).toBeUndefined();
  });
});
