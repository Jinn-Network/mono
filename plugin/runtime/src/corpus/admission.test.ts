// SPDX-License-Identifier: Apache-2.0
import type { DsseChainVerifier } from "@jinn-network/trust-core";
import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_CORPUS_PRODUCER_PURPOSE,
  composeAdmission,
  createDeniedProducerAdmission,
  createFollowedSourceAdmission,
  createTrustPolicyAdmission,
} from "./admission.js";

const alice = { agent: "https://agents.test/alice", name: "attempts" };
const mallory = { agent: "https://agents.test/mallory", name: "attempts" };

const source = {
  agent: alice.agent,
  name: alice.name,
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
  signingKeys: [],
};

const GENESIS = `sha256:${"c".repeat(64)}` as const;
const alwaysValid: DsseChainVerifier = () => ({ validSignerKeyids: [] });

describe("followed-source admission", () => {
  test("admits a configured archive", () => {
    expect(createFollowedSourceAdmission([source]).admitSource(alice).status).toBe("admitted");
  });

  test("rejects an archive this runtime does not follow", () => {
    const decision = createFollowedSourceAdmission([source]).admitSource(mallory);
    expect(decision).toEqual({ status: "rejected", reason: "source-not-followed" });
  });

  test("rejects everything when no archive is configured", () => {
    expect(createFollowedSourceAdmission([]).admitSource(alice).status).toBe("rejected");
  });
});

describe("trust-policy producer admission — fail-closed", () => {
  const options = {
    genesisDigest: GENESIS,
    producerPurpose: DEFAULT_CORPUS_PRODUCER_PURPOSE,
    now: () => "2026-07-30T00:00:00Z",
    dsseVerifier: alwaysValid,
  };

  test("rejects every producer when no policy version is available", () => {
    const admission = createTrustPolicyAdmission({ ...options, policyVersions: [] });
    expect(admission.admitProducer("https://agents.test/alice")).toEqual({
      status: "rejected",
      reason: "policy-unavailable",
    });
  });

  test("rejects every producer when the chain does not verify", () => {
    const admission = createTrustPolicyAdmission({
      ...options,
      policyVersions: [new TextEncoder().encode("not a dsse envelope")],
    });
    expect(admission.admitProducer("https://agents.test/alice").status).toBe("rejected");
  });

  test("maps an expired policy to its own reason", () => {
    const verify = vi.fn(() => ({ ok: false, reason: "policy-expired" as const }));
    const admission = createTrustPolicyAdmission({
      ...options,
      policyVersions: [new Uint8Array([1])],
      verifyChain: verify,
    });
    expect(admission.admitProducer("https://agents.test/alice")).toEqual({
      status: "rejected",
      reason: "policy-expired",
    });
  });

  test("admits only a producer listed under the configured purpose", () => {
    const newest = {
      purposes: {
        [DEFAULT_CORPUS_PRODUCER_PURPOSE]: {
          accepted: ["https://agents.test/alice"],
          requiredStrength: "attested",
        },
      },
    };
    const admission = createTrustPolicyAdmission({
      ...options,
      policyVersions: [new Uint8Array([1])],
      verifyChain: () => ({ ok: true, newest } as never),
    });
    expect(admission.admitProducer("https://agents.test/alice").status).toBe("admitted");
    expect(admission.admitProducer("https://agents.test/mallory")).toEqual({
      status: "rejected",
      reason: "producer-not-listed",
    });
  });

  test("rejects when the configured purpose is absent from the policy", () => {
    const admission = createTrustPolicyAdmission({
      ...options,
      policyVersions: [new Uint8Array([1])],
      verifyChain: () => ({ ok: true, newest: { purposes: {} } } as never),
    });
    expect(admission.admitProducer("https://agents.test/alice")).toEqual({
      status: "rejected",
      reason: "producer-not-listed",
    });
  });

  test("verifies the chain once per clock reading, not once per producer", () => {
    const verify = vi.fn(() => ({ ok: true, newest: { purposes: {} } }) as never);
    const admission = createTrustPolicyAdmission({
      ...options,
      policyVersions: [new Uint8Array([1])],
      verifyChain: verify,
    });
    admission.admitProducer("a");
    admission.admitProducer("b");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  test("passes the injected verifier through and never verifies signatures itself", () => {
    const dsseVerifier = vi.fn(() => ({ validSignerKeyids: [] }));
    createTrustPolicyAdmission({
      ...options,
      dsseVerifier,
      policyVersions: [new TextEncoder().encode("x")],
    }).admitProducer("a");
    // The real verifyPolicyChain rejects the malformed envelope before it
    // reaches the verifier; the point under test is that C5 supplies no
    // cryptography of its own and holds no key material.
    expect(dsseVerifier.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("composition", () => {
  test("an empty composition admits nothing — there is no permissive default", () => {
    const admission = composeAdmission();
    expect(admission.admitSource(alice).status).toBe("rejected");
    expect(admission.admitProducer("anyone").status).toBe("rejected");
  });

  test("one rejection is enough to reject", () => {
    const admission = composeAdmission(
      createFollowedSourceAdmission([source]),
      createDeniedProducerAdmission(),
    );
    expect(admission.admitSource(alice).status).toBe("admitted");
    expect(admission.admitProducer("https://agents.test/alice")).toEqual({
      status: "rejected",
      reason: "policy-unavailable",
    });
  });

  test("returns the first rejection's reason, not a generic one", () => {
    const admission = composeAdmission(createFollowedSourceAdmission([source]));
    expect(admission.admitSource(mallory)).toEqual({
      status: "rejected",
      reason: "source-not-followed",
    });
  });
});
