// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { EvidenceContributionError } from "./errors.js";
import {
  createContributionProposalFingerprint,
  normalizeCreateContributionRequestInput,
  sealContributionIntent,
} from "./request.js";
import type {
  ContributionDestination,
  CreateContributionRequestInput,
  VerifiedDisclosurePolicyDecision,
  VerifiedWithholdDecision,
} from "./types.js";

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

function baseInput(
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
    destinations: [destination()],
    limits: {
      maxDestinations: 4,
      maxArtifacts: 128,
      maxArtifactBytes: 16_777_216,
      maxTotalArtifactBytes: 67_108_864,
      maxManifestBytes: 1_048_576,
      maxConcurrentDestinations: 2,
    },
    hostContext: { attemptId: "attempt-1" },
    ...overrides,
  };
}

function withholdRoute(
  source: CreateContributionRequestInput["source"]["record"],
): VerifiedWithholdDecision {
  return {
    kind: "withhold",
    decision: {
      authorityId: "https://authority.example/policy",
      decisionId: "decision-1",
      digest: `sha256:${"a".repeat(64)}`,
    },
    source,
    issuedAt: "2026-07-28T00:00:00Z",
    reasons: [{ code: "POLICY_WITHHELD" }],
  };
}

describe("normalizeCreateContributionRequestInput", () => {
  test("sorts destinations into deterministic order regardless of input order", () => {
    const a = destination({ destination: "https://a.example" });
    const b = destination({ destination: "https://b.example" });
    const first = normalizeCreateContributionRequestInput(
      baseInput({ destinations: [b, a] }),
    );
    const second = normalizeCreateContributionRequestInput(
      baseInput({ destinations: [a, b] }),
    );
    expect(first.destinations.map((entry) => entry.destination)).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(first).toEqual(second);
  });

  test("rejects duplicate destination IRIs with different configuration digests", () => {
    const first = destination({ destination: "https://a.example" });
    const second = destination({
      destination: "https://a.example",
      configurationDigest: `sha256:${"d".repeat(64)}`,
    });
    expect(() =>
      normalizeCreateContributionRequestInput(
        baseInput({ destinations: [first, second] }),
      )).toThrow(EvidenceContributionError);
  });

  test("rejects a malformed source digest", () => {
    const input = baseInput();
    expect(() =>
      normalizeCreateContributionRequestInput({
        ...input,
        source: { ...input.source, record: { ...input.source.record, digest: "bad" as never } },
      })).toThrow(EvidenceContributionError);
  });

  test("rejects a destination IRI carrying credentials", () => {
    const input = baseInput({
      destinations: [destination({ destination: "https://user:pass@a.example" })],
    });
    expect(() => normalizeCreateContributionRequestInput(input))
      .toThrow(EvidenceContributionError);
  });

  test("rejects more destinations than the declared limit", () => {
    const input = baseInput({
      destinations: [
        destination({ destination: "https://a.example" }),
        destination({ destination: "https://b.example" }),
      ],
      limits: {
        maxDestinations: 1,
        maxArtifacts: 1,
        maxArtifactBytes: 1,
        maxTotalArtifactBytes: 1,
        maxManifestBytes: 1,
        maxConcurrentDestinations: 1,
      },
    });
    expect(() => normalizeCreateContributionRequestInput(input))
      .toThrow(EvidenceContributionError);
  });

  test("does not share array or object identity with the input", () => {
    const input = baseInput();
    const normalized = normalizeCreateContributionRequestInput(input);
    expect(normalized).not.toBe(input);
    expect(normalized.destinations).not.toBe(input.destinations);
    expect(normalized.destinations[0]).not.toBe(input.destinations[0]);
  });

  test("mutating the input after normalization does not change the result", () => {
    const input = baseInput();
    const normalized = normalizeCreateContributionRequestInput(input);
    (input.destinations[0] as { label: string }).label = "mutated";
    expect(normalized.destinations[0]!.label).toBe("Public IPFS");
  });
});

describe("createContributionProposalFingerprint", () => {
  test("is stable across destination reordering and host-context key order", () => {
    const a = destination({ destination: "https://a.example" });
    const b = destination({ destination: "https://b.example" });
    const first = createContributionProposalFingerprint(
      baseInput({ destinations: [a, b], hostContext: { x: "1", y: "2" } }),
    );
    const second = createContributionProposalFingerprint(
      baseInput({ destinations: [b, a], hostContext: { y: "2", x: "1" } }),
    );
    expect(first).toBe(second);
  });

  test("does not cover idempotencyKey", () => {
    const first = createContributionProposalFingerprint(
      baseInput({ idempotencyKey: "key-a" }),
    );
    const second = createContributionProposalFingerprint(
      baseInput({ idempotencyKey: "key-b" }),
    );
    expect(first).toBe(second);
  });

  test("differs when the source digest differs", () => {
    const input = baseInput();
    const first = createContributionProposalFingerprint(input);
    const second = createContributionProposalFingerprint({
      ...input,
      source: {
        ...input.source,
        record: { ...input.source.record, digest: `sha256:${"f".repeat(64)}` },
      },
    });
    expect(first).not.toBe(second);
  });
});

describe("sealContributionIntent", () => {
  test("seals to the same intentFingerprint for equivalent inputs in different key order", () => {
    const inputA = baseInput({
      destinations: [
        destination({ destination: "https://a.example" }),
        destination({ destination: "https://b.example" }),
      ],
    });
    const inputB = baseInput({
      destinations: [
        destination({ destination: "https://b.example" }),
        destination({ destination: "https://a.example" }),
      ],
    });
    const verifiedRouteA: VerifiedDisclosurePolicyDecision = withholdRoute(
      inputA.source.record,
    );
    const verifiedRouteB: VerifiedDisclosurePolicyDecision = withholdRoute(
      inputB.source.record,
    );
    const first = sealContributionIntent({
      request: inputA,
      disclosureIntent: verifiedRouteA,
    });
    const second = sealContributionIntent({
      request: inputB,
      disclosureIntent: verifiedRouteB,
    });
    expect(first.intentFingerprint).toBe(second.intentFingerprint);
    expect(first.request).not.toBe(inputA);
    expect(first.request.destinations).not.toBe(inputA.destinations);
  });

  test("changes the fingerprint when the verified route differs", () => {
    const input = baseInput();
    const withheld = sealContributionIntent({
      request: input,
      disclosureIntent: withholdRoute(input.source.record),
    });
    const withheldDifferentReason = sealContributionIntent({
      request: input,
      disclosureIntent: {
        ...withholdRoute(input.source.record),
        reasons: [{ code: "SENSITIVE_REVIEW_REQUIRED" }],
      },
    });
    expect(withheld.intentFingerprint)
      .not.toBe(withheldDifferentReason.intentFingerprint);
  });
});
