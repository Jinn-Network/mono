// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import type { EvidenceRecordReference, Sha256Digest } from
  "@jinn-network/evidence-repository";

import { EvidenceContributionError } from "./errors.js";
import { resolveDisclosureRoute, type DisclosurePolicyAuthority } from "./policy.js";
import type {
  DisclosurePolicyDecisionReference,
  VerifiedDisclosurePolicyDecision,
} from "./types.js";

function digest(fill: string): Sha256Digest {
  return `sha256:${fill.repeat(64)}` as Sha256Digest;
}

const source: EvidenceRecordReference = {
  family: "execution-evidence",
  digest: digest("b"),
};

const decisionReference: DisclosurePolicyDecisionReference = {
  authorityId: "https://authority.example/policy",
  decisionId: "decision-1",
  digest: digest("a"),
};

const now = "2026-07-28T00:00:00Z";

function withholdDecision(
  overrides: Partial<VerifiedDisclosurePolicyDecision> = {},
): VerifiedDisclosurePolicyDecision {
  return {
    kind: "withhold",
    decision: decisionReference,
    source,
    issuedAt: "2026-07-27T00:00:00Z",
    reasons: [{ code: "POLICY_WITHHELD" }],
    ...overrides,
  } as VerifiedDisclosurePolicyDecision;
}

function authorityReturning(
  value: VerifiedDisclosurePolicyDecision,
): DisclosurePolicyAuthority {
  return { verify: async () => value };
}

describe("resolveDisclosureRoute", () => {
  test("rejects a decision bound to a different source", async () => {
    const authority = authorityReturning(withholdDecision({
      source: { family: "execution-evidence", digest: digest("f") },
    }));
    await expect(
      resolveDisclosureRoute(decisionReference, source, authority, now),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("rejects a decision echoing a different decision reference", async () => {
    const authority = authorityReturning(withholdDecision({
      decision: { ...decisionReference, decisionId: "other-decision" },
    }));
    await expect(
      resolveDisclosureRoute(decisionReference, source, authority, now),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("rejects an expired policy decision", async () => {
    const authority = authorityReturning(withholdDecision({
      expiresAt: "2026-07-27T23:59:59Z",
    }));
    await expect(
      resolveDisclosureRoute(decisionReference, source, authority, now),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });
  });

  test("rejects a malformed policy decision", async () => {
    const authority: DisclosurePolicyAuthority = {
      verify: async () => ({ decision: decisionReference } as never),
    };
    await expect(
      resolveDisclosureRoute(decisionReference, source, authority, now),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });
  });

  test("accepts derive-execution only for execution-evidence", async () => {
    const authority = authorityReturning({
      kind: "derive-execution",
      decision: decisionReference,
      source,
      issuedAt: "2026-07-27T00:00:00Z",
      policyInput: { digest: digest("1") },
      implementationDescriptor: { digest: digest("2") },
      sourceArtifacts: [],
      policyDigest: digest("3"),
      implementationDigest: digest("4"),
      completedAt: "2026-07-27T00:00:01Z",
      risk: { irreversibility: "immutable-or-replicable", sourceCommitmentCorrelation: "none-declared" },
    });
    const route = await resolveDisclosureRoute(decisionReference, source, authority, now);
    expect(route.kind).toBe("derive-execution");
  });

  test("rejects derive-execution for a non-execution-evidence source", async () => {
    const signedSource = { family: "result-evaluation" as const, digest: source.digest };
    const authority = authorityReturning({
      kind: "derive-execution",
      decision: decisionReference,
      source: signedSource,
      issuedAt: "2026-07-27T00:00:00Z",
      policyInput: { digest: digest("1") },
      implementationDescriptor: { digest: digest("2") },
      sourceArtifacts: [],
      policyDigest: digest("3"),
      implementationDigest: digest("4"),
      completedAt: "2026-07-27T00:00:01Z",
      risk: { irreversibility: "immutable-or-replicable", sourceCommitmentCorrelation: "none-declared" },
    });
    await expect(
      resolveDisclosureRoute(decisionReference, signedSource, authority, now),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });
  });

  test("accepts disclose-signed-unchanged only for Evaluation or Verification", async () => {
    const signedSource = { family: "result-evaluation" as const, digest: source.digest };
    const authority = authorityReturning({
      kind: "disclose-signed-unchanged",
      decision: decisionReference,
      source: signedSource,
      issuedAt: "2026-07-27T00:00:00Z",
      allowedCompanionArtifacts: [],
    });
    const route = await resolveDisclosureRoute(decisionReference, signedSource, authority, now);
    expect(route.kind).toBe("disclose-signed-unchanged");
  });

  test("rejects disclose-signed-unchanged for execution-evidence", async () => {
    const authority = authorityReturning({
      kind: "disclose-signed-unchanged",
      decision: decisionReference,
      source,
      issuedAt: "2026-07-27T00:00:00Z",
      allowedCompanionArtifacts: [],
    });
    await expect(
      resolveDisclosureRoute(decisionReference, source, authority, now),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });
  });

  test("withhold returns only content-free reason codes", async () => {
    const authority = authorityReturning(withholdDecision());
    const route = await resolveDisclosureRoute(decisionReference, source, authority, now);
    expect(route).toMatchObject({ kind: "withhold", reasons: [{ code: "POLICY_WITHHELD" }] });
  });

  test("snapshots the authority's return value and rejects a Proxy", async () => {
    const proxied = new Proxy(withholdDecision(), {});
    const authority: DisclosurePolicyAuthority = { verify: async () => proxied };
    await expect(
      resolveDisclosureRoute(decisionReference, source, authority, now),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("rejects an accessor property on the authority's return value", async () => {
    const value: Record<string, unknown> = { ...withholdDecision() };
    Object.defineProperty(value, "kind", { get: () => "withhold", enumerable: true });
    const authority: DisclosurePolicyAuthority = {
      verify: async () => value as unknown as VerifiedDisclosurePolicyDecision,
    };
    await expect(
      resolveDisclosureRoute(decisionReference, source, authority, now),
    ).rejects.toThrow(EvidenceContributionError);
  });
});
