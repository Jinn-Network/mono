// SPDX-License-Identifier: MIT

/**
 * The `PolicyProposer` contract (product design §7.1).
 *
 * ```
 * PolicyProposer.propose({
 *   parents:          typed references (substrate §5.1: {kind, digest}),
 *   evidence:         frozen evidence bundle reference (held-out-excluded),
 *   objective:        the campaign's objective (informational),
 *   mutationSurface:  the axes this campaign permits,
 *   budget:           proposal budget
 * }) → CandidateManifest[]
 * ```
 *
 * The contract is *product-local and deliberately thin*: "implementations are operator-chosen and
 * invisible to the campaign". Three consequences are built into the shapes below.
 *
 * - **`objective` is informational.** It is passed because a proposer may find it useful, and it is
 *   typed as the campaign's own `CampaignObjective` so nothing has to be re-spelled. Nothing checks
 *   that a proposer used it, and a proposer that ignores it entirely is conforming — §4: "the
 *   product never knows or encodes the method".
 * - **`evidence` is a *reference*, not the records.** A bundle reference plus the provenance block
 *   the proposer must copy into its manifest. The proposer dereferences the records through
 *   whatever retrieval surface it has; the campaign's contribution is the frozen, exclusion-filtered
 *   list and the digest that names it (ruling R5).
 * - **The return value is manifests, not payloads.** FINDING F-C7c-3 (README): a `CandidateManifest`
 *   names its loadout by digest, so the *bytes* of the proposed policy travel out of band. That is
 *   not an oversight in the design — it is what admission's materializer port is for (§7.3: "the
 *   policy materializes digest-correct through the provisioner"). A proposer that returns manifests
 *   for payloads nobody can fetch produces candidates that fail admission at the materialization
 *   check, which is the correct and legible failure.
 */

import type {
  CandidateEvidenceProvenance,
  CandidateManifest,
  PolicyParentRef,
} from "@jinn-network/policy-identity";
import type { CampaignObjective } from "../types.js";

/** Product §7.1's `evidence` argument: the frozen bundle, by reference. */
export interface EvidenceBundleRef {
  /** `sha256:` over the sealed bundle manifest's bytes. */
  readonly digest: string;
  /**
   * The substrate §5.1 block the proposer copies verbatim into every manifest it emits. Supplied
   * rather than derived so a proposer cannot accidentally construct a *nearly*-matching one; a
   * near-match is refused at admission and is indistinguishable from a forgery at a glance.
   */
  readonly provenance: CandidateEvidenceProvenance;
}

export interface ProposalBudget {
  /** Campaign §5.1's `budgets.proposal.maxProposals`, scoped to this call. */
  readonly maxProposals: number;
}

export interface PolicyProposalRequest {
  /** Substrate §5.1 typed references the proposals should derive from. */
  readonly parents: readonly PolicyParentRef[];
  readonly evidence: EvidenceBundleRef;
  /** Informational. A conforming proposer may ignore it entirely. */
  readonly objective: CampaignObjective;
  /** The axes this campaign permits a candidate to vary. v0: `["loadout"]`. */
  readonly mutationSurface: readonly string[];
  readonly budget: ProposalBudget;
}

/**
 * The contract. `id` exists so a journal entry can name which proposer produced a candidate without
 * the campaign knowing anything else about it — attribution, not capability discovery.
 */
export interface PolicyProposer {
  readonly id: string;
  propose(
    request: PolicyProposalRequest,
  ): readonly CandidateManifest[] | Promise<readonly CandidateManifest[]>;
}
