// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, test } from "vitest";

import type {
  ContributionDestination,
  CreateContributionRequestInput,
  DisclosurePolicyDecisionReference,
} from "./types.js";

describe("Contribution public vocabulary", () => {
  test("models one exact source and explicit destinations", () => {
    const policy: DisclosurePolicyDecisionReference = {
      authorityId: "https://authority.example/policy",
      decisionId: "decision-1",
      digest: `sha256:${"a".repeat(64)}`,
    };
    const input: CreateContributionRequestInput = {
      idempotencyKey: "plugin:attempt-1",
      source: {
        repositoryBindingId: "private-local",
        record: {
          family: "execution-evidence",
          digest: `sha256:${"b".repeat(64)}`,
        },
      },
      stagingRepositoryBindingId: "private-staging",
      policyDecision: policy,
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
      hostContext: { attemptId: "attempt-1" },
    };
    expect(input.source.record.family).toBe("execution-evidence");
    expectTypeOf<ContributionDestination["deactivation"]>()
      .toEqualTypeOf<"supported" | "unsupported">();
  });
});
