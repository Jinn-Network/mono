// SPDX-License-Identifier: Apache-2.0

import type { SourceIdentity } from "@jinn-network/record-discovery-protocol";
import {
  verifyPolicyChain,
  type DsseChainVerifier,
  type PolicyChainVerificationResult,
  type Sha256Digest,
  type VerifyPolicyChainOptions,
} from "@jinn-network/trust-core";

import type { MirrorSourceConfig } from "../config.js";

/**
 * The purpose under which a trust policy lists agents whose records this
 * runtime will admit into an agent's context. A namespaced extension
 * purpose, which `TrustPolicySchema` explicitly admits alongside the nine
 * core purposes (`packages/trust/core/src/policy.ts:37-42`).
 */
export const DEFAULT_CORPUS_PRODUCER_PURPOSE = "jinn:corpus-producer" as const;

export type AdmissionRejectionReason =
  | "source-not-followed"
  | "producer-not-listed"
  | "policy-unavailable"
  | "policy-invalid"
  | "policy-expired";

export type AdmissionDecision =
  | { readonly status: "admitted" }
  | { readonly status: "rejected"; readonly reason: AdmissionRejectionReason };

export interface CorpusAdmission {
  admitSource(source: SourceIdentity): AdmissionDecision;
  admitProducer(producerId: string): AdmissionDecision;
}

const ADMITTED: AdmissionDecision = Object.freeze({ status: "admitted" });

function reject(reason: AdmissionRejectionReason): AdmissionDecision {
  return Object.freeze({ status: "rejected", reason });
}

function archiveKey(source: SourceIdentity): string {
  return `${source.agent}/${source.name}`;
}

/** Admits exactly the archives this runtime is configured to follow. */
export function createFollowedSourceAdmission(
  sources: readonly MirrorSourceConfig[],
): CorpusAdmission {
  const followed = new Set(sources.map(archiveKey));
  return Object.freeze({
    admitSource(source: SourceIdentity): AdmissionDecision {
      return followed.has(archiveKey(source)) ? ADMITTED : reject("source-not-followed");
    },
    admitProducer(): AdmissionDecision {
      // Producer admission is not this half's concern; composition supplies it.
      return ADMITTED;
    },
  });
}

export type PolicyChainVerifier = (
  versions: readonly Uint8Array[],
  options: VerifyPolicyChainOptions,
) => PolicyChainVerificationResult;

export interface TrustPolicyAdmissionOptions {
  readonly policyVersions: readonly Uint8Array[];
  readonly genesisDigest: Sha256Digest;
  readonly producerPurpose: string;
  readonly now: () => string;
  /** Injected per custody law C1/C3: C5 implements no cryptography. */
  readonly dsseVerifier: DsseChainVerifier;
  /** Seam for tests; production uses trust-core's own `verifyPolicyChain`. */
  readonly verifyChain?: PolicyChainVerifier;
}

/**
 * Producer admission over a hash-linked, dual-threshold-signed trust-policy
 * chain. Fail-closed at every branch: no policy, an unverifiable chain, an
 * expired chain, a missing purpose, and an unlisted producer all REJECT.
 * There is no code path through this function that admits by default.
 */
export function createTrustPolicyAdmission(
  options: TrustPolicyAdmissionOptions,
): CorpusAdmission {
  const verifyChain = options.verifyChain ?? verifyPolicyChain;
  let memo: { readonly now: string; readonly result: PolicyChainVerificationResult } | undefined;

  function currentPolicy(): PolicyChainVerificationResult {
    const now = options.now();
    if (memo !== undefined && memo.now === now) return memo.result;
    const result = verifyChain(options.policyVersions, {
      genesisAnchor: { digest: options.genesisDigest },
      now,
      dsseVerifier: options.dsseVerifier,
    });
    memo = { now, result };
    return result;
  }

  return Object.freeze({
    admitSource(): AdmissionDecision {
      // Source (announcer) admission is the followed-source half's concern.
      return ADMITTED;
    },
    admitProducer(producerId: string): AdmissionDecision {
      if (options.policyVersions.length === 0) return reject("policy-unavailable");

      const outcome = currentPolicy();
      if (!outcome.ok || outcome.newest === undefined) {
        return reject(outcome.reason === "policy-expired" ? "policy-expired" : "policy-invalid");
      }

      const entry = outcome.newest.purposes[options.producerPurpose];
      if (entry === undefined || !entry.accepted.includes(producerId)) {
        return reject("producer-not-listed");
      }
      return ADMITTED;
    },
  });
}

/**
 * The admission a runtime with no trust configuration gets. Named so the
 * absence of a policy is a visible construction choice rather than a
 * forgotten one; there is deliberately no `createOpenAdmission`.
 */
export function createDeniedProducerAdmission(
  reason: AdmissionRejectionReason = "policy-unavailable",
): CorpusAdmission {
  return Object.freeze({
    admitSource(): AdmissionDecision {
      return ADMITTED;
    },
    admitProducer(): AdmissionDecision {
      return reject(reason);
    },
  });
}

/**
 * Conjunction: every part must admit. An EMPTY composition rejects — the
 * fail-closed identity, not the fail-open one, so a wiring mistake that
 * drops every part denies rather than admits.
 */
export function composeAdmission(...parts: readonly CorpusAdmission[]): CorpusAdmission {
  if (parts.length === 0) {
    return Object.freeze({
      admitSource: (): AdmissionDecision => reject("source-not-followed"),
      admitProducer: (): AdmissionDecision => reject("policy-unavailable"),
    });
  }
  return Object.freeze({
    admitSource(source: SourceIdentity): AdmissionDecision {
      for (const part of parts) {
        const decision = part.admitSource(source);
        if (decision.status === "rejected") return decision;
      }
      return ADMITTED;
    },
    admitProducer(producerId: string): AdmissionDecision {
      for (const part of parts) {
        const decision = part.admitProducer(producerId);
        if (decision.status === "rejected") return decision;
      }
      return ADMITTED;
    },
  });
}
