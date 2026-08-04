// SPDX-License-Identifier: MIT

/**
 * The admission gate's vocabulary (product design §7.3–§7.4).
 *
 * Shapes only — no logic. Two families:
 *
 * 1. **The injected ports.** Admission is pure-ish: it decides, and the things that touch the world
 *    (materializing a package, running a canary, resolving a signature through the trust layer)
 *    arrive as ports. The materializer port is the one that had a real alternative — see
 *    FINDING F-C7c-5 at `MaterializerPort`.
 * 2. **The report.** Every §7.3 check is reported individually, pass or fail, whatever the outcome
 *    of the whole. An admission that returned only "rejected" would leave an owner to guess which
 *    of seven gates a candidate tripped, and a rejection is journaled (§5.2's
 *    `candidate-rejected`), so the report is what someone reads six weeks later.
 */

import type { TreeEntry } from "@jinn-network/policy-identity";
import type { PolicyOptimizationErrorCategory, PolicyOptimizationIssue } from "../errors.js";
import type { EvidenceBundleManifest } from "../evidence-bundle/bundle.js";
import type { HeldOutBoundary } from "../evidence-bundle/held-out.js";
import type { CampaignDocument } from "../types.js";
import type { AdmittedCandidate } from "../wave-types.js";
import type { PayloadClass, PayloadClassification } from "./payload-class.js";
import type { Population, PopulationEntry } from "./population.js";

/**
 * Digest-correct materialization, as a port (§7.3: "the policy materializes digest-correct through
 * the provisioner").
 *
 * ## FINDING F-C7c-5 — ported rather than imported, deliberately
 *
 * C5's workspace machinery (`packages/task-execution/backend-local/workspace/src/materialize.ts`)
 * does exactly this against a real filesystem. Importing it was available — the catalog permits a
 * tier-4 product to depend on platform packages — and was refused for two reasons:
 *
 * - The product's source-boundary guard already denies `task-execution-workspace` by name, with a
 *   stated rationale C7a/C7b did not invent for this case: "naming a concrete backend is exactly
 *   what the injected-port posture exists to prevent". Admission runs against whatever venue the
 *   campaign uses; wiring the local provisioner into it would make the gate local-only at the
 *   moment the marketplace venue arrives.
 * - The *verification* — `assertMaterializable` then `hashTreeLearnerPublicV1` then compare — is
 *   already available to this package through `@jinn-network/policy-identity`, which is pure. So
 *   the port supplies only the bytes; the **check stays here**, where the refusal is. A port that
 *   returned a boolean "yes it matched" would be the passthrough R5 warns about, one gate over.
 *
 * The port therefore returns a described tree and nothing else. It may not report success.
 */
export interface MaterializerPort {
  materialize(request: {
    /** The candidate manifest's loadout pin, verbatim. */
    readonly loadout: Readonly<Record<string, unknown>>;
    /** `sha256:` over the sealed manifest — for a port that fetches packages by candidate. */
    readonly manifestDigest: string;
  }): readonly TreeEntry[] | Promise<readonly TreeEntry[]>;
}

/** §7.3's optional smoke canary: "an optional smoke canary (small dev subset) completes". */
export interface SmokeCanaryPort {
  run(request: {
    readonly tupleDigest: string;
    readonly manifestDigest: string;
  }): SmokeCanaryOutcome | Promise<SmokeCanaryOutcome>;
}

export interface SmokeCanaryOutcome {
  readonly completed: boolean;
  /** Free text for the journal. Never a score — a canary asserts *usable*, never *better* (§7.3). */
  readonly detail?: string;
}

/**
 * Signature verification for cross-operator candidates (substrate §5.2, product §7.4).
 *
 * A port because resolving the proposer IRI runs through the trust layer's binding verification,
 * which this package does not depend on. `@jinn-network/policy-identity`'s
 * `verifyCandidateStatementBinding` checks the *envelope's* binding to the manifest; establishing
 * that the key belongs to the proposer is the host's.
 */
export interface SignaturePort {
  verify(request: {
    readonly manifestDigest: string;
    readonly manifestBytes: Uint8Array;
    readonly proposer: string;
  }): SignatureOutcome | Promise<SignatureOutcome>;
}

export interface SignatureOutcome {
  readonly verified: boolean;
  readonly detail?: string;
}

/**
 * The owner's admission-time consent (§7.3: "those payload classes require explicit owner approval
 * at admission, not merely at adoption").
 *
 * `crossOperator` is the caller's declaration, not an inference: whether the proposer is a stranger
 * is a fact about the operator's own setup, and v0's bound on exposure is precisely "the closed
 * proposer setup" (§7.4) — a package that guessed would either nag an owner about their own
 * learner or wave a stranger's hooks through.
 */
export interface AdmissionConsent {
  readonly crossOperator: boolean;
  /** Payload classes the owner has explicitly approved for this candidate or this campaign. */
  readonly approvedPayloadClasses: readonly PayloadClass[];
}

export interface AdmissionRequest {
  readonly campaign: CampaignDocument;
  /** The exact sealed manifest bytes. Admission parses these; it never re-seals a supplied object. */
  readonly manifestBytes: Uint8Array;
  /** The bundles this campaign issued. The manifest's provenance must match one of them (R5). */
  readonly issuedBundles: readonly EvidenceBundleManifest[];
  /** The boundary the lexical scan runs against (§6.3). */
  readonly boundary: HeldOutBoundary;
  readonly population: Population;
  readonly materializer: MaterializerPort;
  readonly consent?: AdmissionConsent;
  readonly smokeCanary?: SmokeCanaryPort;
  readonly signature?: SignaturePort;
  /**
   * Ruling R2's **additive** path-granular check. Absent → axis-level only, per the spec. Present →
   * every path whose bytes differ from the parent tree must sit under one of these prefixes.
   *
   * Supplied with the parent tree because a diff needs both sides, and admission holds neither
   * until the materializer runs.
   */
  readonly mutablePaths?: {
    readonly parentTree: readonly TreeEntry[];
    readonly prefixes: readonly string[];
  };
}

export type AdmissionCheckName =
  | "manifest"
  | "signature"
  | "evidence-bundle"
  | "frozen-axes"
  | "mutation-surface"
  | "materialization"
  | "mutable-paths"
  | "lexical-scan"
  | "payload-consent"
  | "smoke-canary"
  | "population";

export interface AdmissionCheck {
  readonly name: AdmissionCheckName;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail: string;
  readonly issues?: readonly PolicyOptimizationIssue[];
}

export interface AdmissionAccepted {
  readonly ok: true;
  readonly checks: readonly AdmissionCheck[];
  /** Exactly the wave engine's input seam. Nothing else crosses from admission into a wave. */
  readonly candidate: AdmittedCandidate;
  readonly manifestDigest: string;
  readonly payload: PayloadClassification;
  readonly population: Population;
  readonly entry: PopulationEntry;
  /** §7.3 — this manifest joined an arm the first-admitted manifest minted. */
  readonly joinedExisting: boolean;
}

export interface AdmissionRejected {
  readonly ok: false;
  readonly checks: readonly AdmissionCheck[];
  /** The category of the first failing check — the journal's rejection reason. */
  readonly reason: PolicyOptimizationErrorCategory;
  readonly errors: readonly PolicyOptimizationIssue[];
}

export type AdmissionResult = AdmissionAccepted | AdmissionRejected;
