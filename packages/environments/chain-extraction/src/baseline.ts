// SPDX-License-Identifier: Apache-2.0

import type { ChainEnvironmentRecord } from "@jinn-network/chain-environment-record";
import {
  ChainVerificationError,
  chainObservationDigest,
  observeArchiveEnvironment,
  type CanonicalChainObservation,
  type FixtureMutationDeclaration,
  type SealedAttestation,
} from "@jinn-network/chain-environment-verification";
import type { Sha256Digest } from "@jinn-network/trust-core";

import type { AnchorCapture } from "./anchor.js";
import type { BudgetedArchivePort } from "./budget.js";
import { stageFail, stageOk, type StageOutcome } from "./failures.js";
import { BASELINE_RUN_COUNT, type ArchiveBudgetLimits } from "./identifiers.js";
import type { StateKeySet } from "./key-set.js";
import { asChainStateBackend, type ExtractionDeps, type ForkBackendBinding } from "./ports.js";

/**
 * What the author supplies. The draft is a complete, valid **archive-dependent** record --
 * CE1's `fixtures/chain/archive-dependent.json` is exactly this shape, and its E13 rules
 * are vacuous while `stateArtifact` is absent, which is why the pipeline can start here.
 * CE4 rewrites exactly two blocks on the way to `closed-state`.
 */
export type ChainEnvironmentRecordDraft = ChainEnvironmentRecord;

export interface ExtractionRequest {
  readonly draft: ChainEnvironmentRecordDraft;
  /** Fallback when the draft's `sourceAnchor` omits `caip2ChainId`. */
  readonly caip2ChainId?: string;
  readonly anchorBlockNumber: number;
  readonly fidelityClass: "local" | "anchored-subset" | "full-state";
  /** Addresses whose artifact entries the author claims come from the source chain. */
  readonly sourceAddresses: readonly string[];
  /** CE3's declaration shape, verbatim: `{address, kind, slot?}`. */
  readonly fixtureDeclarations: readonly FixtureMutationDeclaration[];
  /** Declared and then checked against what the archive reports (design §4.3). */
  readonly finalityPolicy: "finalized" | "safe" | "latest" | `confirmations:${number}`;
  readonly headerProof?: { readonly name: string; readonly digest: { readonly sha256: string } };
  readonly budget?: Partial<ArchiveBudgetLimits>;
  readonly maxWidenings?: number;
}

export interface ConnectedBaseline {
  /** The digest every blackholed run must reproduce, computed with CE3's own function. */
  readonly observationDigest: Sha256Digest;
  readonly observation: CanonicalChainObservation;
  readonly runObservationDigests: readonly Sha256Digest[];
  /** Every state key the connected runs read through the injected archive port. */
  readonly touched: StateKeySet;
  /** CE3's archive-observation attestation, carried verbatim. */
  readonly attestation: SealedAttestation;
}

function withAnchoredDraft(
  request: ExtractionRequest,
  anchor: AnchorCapture,
  forkBackend: ForkBackendBinding,
): ChainEnvironmentRecord {
  const draft = request.draft;
  const existingAnchor = draft.sourceAnchor;
  if (existingAnchor === undefined) {
    throw new Error("An archive-dependent draft must carry a source anchor before extraction.");
  }

  const sourceAnchor = {
    ...existingAnchor,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
    stateRoot: anchor.stateRoot,
    timestamp: anchor.timestamp,
    finalityPolicy: request.finalityPolicy,
    ...(request.headerProof === undefined
      ? anchor.headerProof === undefined ? {} : { headerProof: anchor.headerProof }
      : { headerProof: request.headerProof }),
  };

  const stateMaterializationBase = {
    ...draft.stateMaterialization,
    closureClass: "archive-dependent" as const,
    fidelityClass: request.fidelityClass,
  };

  const stateMaterialization = forkBackend.kind === "locator"
    ? {
        ...stateMaterializationBase,
        archive: {
          requiredCapabilities: ["archive-state"],
          providerLocators: [forkBackend.locator],
        },
      }
    : stateMaterializationBase;

  return {
    ...draft,
    sourceAnchor: sourceAnchor as NonNullable<ChainEnvironmentRecord["sourceAnchor"]>,
    stateMaterialization,
  };
}

/**
 * Runs the author's archive-dependent draft through CE3's archive-observation protocol,
 * with the fork's state backend bound to CE4's injected, budgeted, journaling port
 * (see `ExtractionDeps.forkBackend` and Finding F-CE4-1). The observation it returns is
 * the reference the whole widen loop converges to; the journal it leaves behind is the
 * harvest ground truth.
 */
export async function establishBaseline(
  deps: ExtractionDeps,
  request: ExtractionRequest,
  archive: BudgetedArchivePort,
  anchor: AnchorCapture,
): Promise<StageOutcome<ConnectedBaseline>> {
  const record = withAnchoredDraft(request, anchor, deps.forkBackend);

  let attestation: SealedAttestation;
  try {
    attestation = await observeArchiveEnvironment(
      {
        runtime: deps.runtime,
        artifactStore: deps.artifactStore,
        signer: deps.signer,
        clock: deps.clock,
        verifier: deps.verifier,
      },
      record,
      {
        runCount: BASELINE_RUN_COUNT,
        providers: [{ id: "connected", stateBackend: asChainStateBackend(archive) }],
      },
    );
  } catch (cause) {
    if (cause instanceof ChainVerificationError) {
      return stageFail("runtime-failure", `The archive-observation protocol refused the draft: ${cause.message}`);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/Archive budget exhausted/u.test(message)) return stageFail("archive-budget-exhausted", message);
    return stageFail("runtime-failure", message);
  }

  if (attestation.outcome !== "archive-observed") {
    const failureDetail = attestation.statement.predicate?.failure?.detail;
    if (failureDetail !== undefined && /Archive budget exhausted/u.test(failureDetail)) {
      return stageFail("archive-budget-exhausted", failureDetail);
    }
    // CE3's vocabulary maps onto CE4's without inventing a third: a provider that
    // disagreed is a provider-disagreement; runs that disagreed are an unstable baseline;
    // anything else is the host's problem, not the slice's.
    const reason = attestation.outcome === "provider-disagreement"
      ? "archive-self-disagreement"
      : attestation.outcome === "probe-divergence" || attestation.outcome === "reset-divergence"
        ? "baseline-unstable"
        : attestation.outcome === "artifact-unavailable"
          ? "artifact-store-failure"
          : "runtime-failure";
    return stageFail(
      reason,
      `The connected baseline came back "${attestation.outcome}". A world that is not `
      + "repeat-stable while connected cannot be closed by widening its slice.",
    );
  }

  const observations = attestation.observations;
  const first = observations[0];
  if (first === undefined) return stageFail("runtime-failure", "The baseline produced no observation.");
  const digests = observations.map((observation) => chainObservationDigest(observation));
  const divergent = digests.findIndex((digest) => digest !== digests[0]);
  if (divergent > 0) {
    return stageFail(
      "baseline-unstable",
      `The connected world disagreed with itself: run 1 observed ${digests[0]}, `
      + `run ${divergent + 1} observed ${digests[divergent]}.`,
    );
  }

  return stageOk({
    observationDigest: digests[0]!,
    observation: first,
    runObservationDigests: digests,
    touched: archive.journal(),
    attestation,
  });
}
