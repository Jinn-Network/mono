// SPDX-License-Identifier: Apache-2.0

import type { ArchiveUsage } from "./ports.js";
import { captureAnchor, confirmAnchorUnchanged } from "./anchor.js";
import { establishBaseline, type ExtractionRequest } from "./baseline.js";
import { createBudgetedArchivePort } from "./budget.js";
import {
  buildCoverageArtifacts,
  collectSourceProofs,
  PROOF_BUNDLE_FORMAT,
  type ProofBundle,
} from "./coverage.js";
import {
  assembleCandidate,
  assertClosedStatePreconditions,
  buildClosedStateRecord,
  computeSealedInitialCommitment,
  PROVISIONAL_COMMITMENT,
  resolveClosedStateResources,
  storeExtractionArtifacts,
  type ChainEnvironmentCandidate,
} from "./candidate.js";
import {
  classifyExtractionFailure,
  stageForExtractionFailure,
  type ExtractionFailureDisposition,
  type ExtractionFailureReason,
  type ExtractionStage,
  type StageOutcome,
} from "./failures.js";
import {
  DEFAULT_ARCHIVE_BUDGET,
  DEFAULT_MAX_WIDENINGS,
  MAX_WIDENINGS_CEILING,
} from "./identifiers.js";
import { harvestTouchedState } from "./harvest.js";
import type { ExtractionDeps } from "./ports.js";
import type { StateKeySet } from "./key-set.js";

const ZERO_ARCHIVE_USAGE: ArchiveUsage = Object.freeze({
  calls: 0,
  bytes: 0,
  limits: DEFAULT_ARCHIVE_BUDGET,
});

export type ExtractionResult =
  | {
    readonly status: "candidate";
    readonly candidate: ChainEnvironmentCandidate;
    readonly archiveUsage: ArchiveUsage;
    readonly dumpOmissions: StateKeySet;
    readonly dumpOnlyEntries: StateKeySet;
    readonly maxWidenings: number;
  }
  | {
    readonly status: "failed";
    readonly reason: ExtractionFailureReason;
    readonly disposition: ExtractionFailureDisposition;
    readonly stage: ExtractionStage;
    readonly detail: string;
    readonly archiveUsage: ArchiveUsage;
  };

function extractionFailed(
  reason: ExtractionFailureReason,
  detail: string,
  archiveUsage: ArchiveUsage,
): ExtractionResult {
  return {
    status: "failed",
    reason,
    disposition: classifyExtractionFailure(reason),
    stage: stageForExtractionFailure(reason),
    detail,
    archiveUsage,
  };
}

function failFromStage<T>(
  outcome: Extract<StageOutcome<T>, { ok: false }>,
  archiveUsage: ArchiveUsage,
): ExtractionResult {
  return extractionFailed(outcome.reason, outcome.detail, archiveUsage);
}

export async function extractEnvironment(
  deps: ExtractionDeps,
  request: ExtractionRequest,
): Promise<ExtractionResult> {
  const maxWidenings = request.maxWidenings ?? DEFAULT_MAX_WIDENINGS;
  if (maxWidenings > MAX_WIDENINGS_CEILING) {
    return extractionFailed(
      "widen-bound-above-ceiling",
      `maxWidenings=${maxWidenings} exceeds the ceiling of ${MAX_WIDENINGS_CEILING}.`,
      ZERO_ARCHIVE_USAGE,
    );
  }

  const preconditions = assertClosedStatePreconditions(request.draft);
  if (!preconditions.ok) {
    return extractionFailed(preconditions.reason, preconditions.detail, ZERO_ARCHIVE_USAGE);
  }

  const budget = { ...DEFAULT_ARCHIVE_BUDGET, ...request.budget };
  const archive = createBudgetedArchivePort(deps.archive, budget);

  const anchorOutcome = await captureAnchor(
    archive,
    {
      blockNumber: request.anchorBlockNumber,
      ...(request.headerProof === undefined ? {} : { headerProof: request.headerProof }),
    },
    deps.clock,
  );
  if (!anchorOutcome.ok) {
    return failFromStage(anchorOutcome, archive.usage());
  }
  const anchor = anchorOutcome.value;

  if (request.finalityPolicy === "finalized" && !anchor.finality.finalizedAtObservation) {
    return extractionFailed(
      "verification-refused",
      `Anchor block ${anchor.blockNumber} is above the finalized head observed at `
      + `${anchor.finality.finalizedBlockNumber}.`,
      archive.usage(),
    );
  }

  const baselineOutcome = await establishBaseline(deps, request, archive, anchor);
  if (!baselineOutcome.ok) {
    return failFromStage(baselineOutcome, archive.usage());
  }
  const baseline = baselineOutcome.value;

  const instanceId = baseline.attestation.instanceIds.at(-1);
  const harvestOutcome = await harvestTouchedState(archive, {
    journal: archive.journal(),
    anchor,
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(deps.stateDump === undefined ? {} : { dump: deps.stateDump }),
  });
  if (!harvestOutcome.ok) {
    return failFromStage(harvestOutcome, archive.usage());
  }
  const { artifact, dumpOmissions, dumpOnlyEntries } = harvestOutcome.value;

  let bundle: ProofBundle;
  if (request.fidelityClass === "local") {
    bundle = {
      format: PROOF_BUNDLE_FORMAT,
      proofFormat: "eip-1186",
      anchor: {
        blockNumber: artifact.anchor.blockNumber,
        blockHash: artifact.anchor.blockHash,
        stateRoot: artifact.anchor.stateRoot,
      },
      accounts: [],
    };
  } else {
    const proofsOutcome = await collectSourceProofs(archive, artifact, {
      addresses: request.sourceAddresses,
      stateRoot: anchor.stateRoot,
    });
    if (!proofsOutcome.ok) {
      return failFromStage(proofsOutcome, archive.usage());
    }
    bundle = proofsOutcome.value;
  }

  const coverageOutcome = buildCoverageArtifacts({
    artifact,
    fidelityClass: request.fidelityClass,
    bundle,
    declarations: request.fixtureDeclarations,
  });
  if (!coverageOutcome.ok) {
    return failFromStage(coverageOutcome, archive.usage());
  }
  const coverage = coverageOutcome.value;

  const anchorConfirmed = await confirmAnchorUnchanged(archive, anchor);
  if (!anchorConfirmed.ok) {
    return failFromStage(anchorConfirmed, archive.usage());
  }

  const stored = await storeExtractionArtifacts(deps.artifactStore, artifact, coverage);
  if (!stored.ok) {
    return failFromStage(stored, archive.usage());
  }

  const provisional = buildClosedStateRecord(
    request,
    anchor,
    artifact,
    coverage,
    stored.value,
    PROVISIONAL_COMMITMENT,
  );

  const resourcesOutcome = await resolveClosedStateResources(deps.artifactStore, provisional);
  if (!resourcesOutcome.ok) {
    return failFromStage(resourcesOutcome, archive.usage());
  }

  const commitmentOutcome = await computeSealedInitialCommitment(
    deps,
    provisional,
    resourcesOutcome.value,
    artifact,
  );
  if (!commitmentOutcome.ok) {
    return failFromStage(commitmentOutcome, archive.usage());
  }

  const candidateOutcome = await assembleCandidate(deps, {
    request,
    anchor,
    baseline,
    artifact,
    coverage,
    initialStateCommitment: commitmentOutcome.value,
  });
  if (!candidateOutcome.ok) {
    return failFromStage(candidateOutcome, archive.usage());
  }

  return {
    status: "candidate",
    candidate: candidateOutcome.value,
    archiveUsage: archive.usage(),
    dumpOmissions,
    dumpOnlyEntries,
    maxWidenings,
  };
}
