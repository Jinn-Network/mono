// SPDX-License-Identifier: Apache-2.0
import type { Sha256Digest } from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import { createContributionReadModel } from "./read-model.js";
import { createProposedContributionRequestState, type ContributionRequestState } from "./state.js";
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

describe("createContributionReadModel", () => {
  test("projects the store revision alongside durable state", () => {
    const model = createContributionReadModel({ revision: 3, value: proposedState() });
    expect(model.revision).toBe(3);
    expect(model.status).toBe("proposed");
    expect(model.requestId).toBe("request-1");
  });

  test("never includes Evidence payload bytes, only the manifest byte snapshot when preview-ready", () => {
    const state: ContributionRequestState = {
      ...proposedState(),
      preparation: {
        status: "preview-ready",
        disclosure: {
          manifest: {} as never,
          manifestBytes: new Uint8Array([1, 2, 3]),
          previewFingerprint: `sha256:${"e".repeat(64)}` as Sha256Digest,
        },
      },
    };
    const model = createContributionReadModel({ revision: 1, value: state });
    expect(model.previewFingerprint).toBe(`sha256:${"e".repeat(64)}`);
    expect(model.manifestBytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("surfaces the withheld reasons and review reference safely", () => {
    const withheld = createContributionReadModel({
      revision: 1,
      value: {
        ...proposedState(),
        preparation: { status: "withheld", reasons: [{ code: "POLICY_WITHHELD" }] },
      },
    });
    expect(withheld.withheldReasons).toEqual([{ code: "POLICY_WITHHELD" }]);

    const reviewing = createContributionReadModel({
      revision: 1,
      value: {
        ...proposedState(),
        preparation: { status: "review-required", reviewReference: "review-ref-1" },
      },
    });
    expect(reviewing.reviewReference).toBe("review-ref-1");
  });

  test("surfaces the declined reason code", () => {
    const model = createContributionReadModel({
      revision: 1,
      value: {
        ...proposedState(),
        preparation: {
          status: "declined",
          declinedAt: "2026-07-28T00:00:01Z",
          reasonCode: "OPERATOR_ATTENTION_REQUIRED",
        },
      },
    });
    expect(model.declinedReasonCode).toBe("OPERATOR_ATTENTION_REQUIRED");
    expect(model.status).toBe("declined");
  });
});
