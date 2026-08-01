// SPDX-License-Identifier: Apache-2.0

import { documentDigest, type Sha256Digest } from "./digest.js";
import { DerivationError } from "./errors.js";
import type { UpstreamIdentity } from "./source-commitment.js";

/** v1 has one strategy, and it imports (design §7.2 / §12: no synthetic strategies). */
export type ProvenanceKind = "mined";

/**
 * Evaluation material carried inline as base64 content plus its digest. `accessClass` is
 * not a field here because it is not a choice: D5 admits no private material in v1, and
 * the sealed spec's descriptors are stamped `"public"` explicitly at build time.
 */
export interface CandidateTestMaterial {
  readonly name: string;
  readonly mediaType: string;
  /** base64 of the material bytes. */
  readonly content: string;
  readonly digest: Sha256Digest;
}

export interface CandidateProvenance {
  readonly kind: ProvenanceKind;
  readonly upstream: UpstreamIdentity;
}

/**
 * What a strategy yields.
 *
 * Deliberately absent: `image`, `platform`, `parser`. Those come from the environment
 * record at sealing time, which is what makes C3's inline-match rule (§7.1) pass by
 * construction — a candidate has nowhere to put a disagreeing value.
 *
 * `goldPatch` is LOCAL-ONLY material: it reaches admission and the gold store, and never
 * the supply pool (`PoolEntry` has no field that could hold it).
 *
 * `statement` is upstream-authored, attacker-influencable text (design §7.3). Nothing in
 * this package sanitizes it, and no receipt minted downstream says anything about its
 * content safety.
 */
export interface Candidate {
  readonly id: string;
  readonly statement: string;
  readonly language: string;
  readonly testMaterial: readonly CandidateTestMaterial[];
  readonly transitions: {
    readonly failToPass: readonly string[];
    readonly passToPass: readonly string[];
  };
  readonly timeout: number;
  readonly goldPatch: Uint8Array;
  readonly provenance: CandidateProvenance;
  readonly rights: { readonly sourceLicense: string };
}

/**
 * A conservative SPDX *expression* shape: licence ids joined by AND/OR/WITH, optionally
 * parenthesized. Declared, never detected (design §4.2's honesty note) — this checks that
 * the producer supplied an expression, not that the expression is true of the source.
 */
export const SPDX_EXPRESSION_PATTERN =
  /^[A-Za-z0-9.+()-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+()-]+)*$/;

const encoder = new TextEncoder();

export function assertCandidate(candidate: Candidate): void {
  const fail = (message: string): never => {
    throw new DerivationError("invalid-input", `candidate ${candidate.id}: ${message}`);
  };

  if (candidate.id.length === 0) fail("id must be non-empty.");
  if (candidate.statement.length === 0) fail("statement must be non-empty.");
  if (candidate.language.length === 0) fail("language must be non-empty.");
  if (candidate.transitions.failToPass.length === 0) {
    fail("at least one fail-to-pass transition is required — a suite that cannot discriminate is not a task.");
  }
  if (!Number.isSafeInteger(candidate.timeout) || candidate.timeout <= 0) {
    fail(`timeout must be a positive integer; got ${candidate.timeout}.`);
  }
  if (candidate.goldPatch.byteLength === 0) fail("goldPatch must be non-empty.");
  if (candidate.testMaterial.length === 0) fail("at least one test-material descriptor is required.");
  for (const material of candidate.testMaterial) {
    if (material.name.length === 0) fail("test material name must be non-empty.");
    if (material.mediaType.length === 0) fail("test material mediaType must be non-empty.");
    const bytes = Uint8Array.from(Buffer.from(material.content, "base64"));
    if (documentDigest(bytes) !== material.digest) {
      fail(`test material "${material.name}" digest does not match its content.`);
    }
  }
  if (!SPDX_EXPRESSION_PATTERN.test(candidate.rights.sourceLicense)) {
    fail(
      `rights.sourceLicense must be an SPDX expression (D12); got `
        + `${JSON.stringify(candidate.rights.sourceLicense)}.`,
    );
  }
  if (encoder.encode(candidate.statement).byteLength === 0) fail("statement must encode to bytes.");
}
