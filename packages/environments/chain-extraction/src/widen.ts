// SPDX-License-Identifier: Apache-2.0

import type { ChainInstance } from "@jinn-network/chain-environment-record";
import * as ce3 from "@jinn-network/chain-environment-verification";
import type { Sha256Digest } from "@jinn-network/trust-core";

import type { AnchorCapture, HeaderProofDescriptor } from "./anchor.js";
import type { ExtractionRequest } from "./baseline.js";
import { createBudgetedArchivePort, type BudgetedArchivePort } from "./budget.js";
import {
  assembleCandidate,
  buildClosedStateRecord,
  computeSealedInitialCommitment,
  resolveClosedStateResources,
  storeExtractionArtifacts,
  type ChainEnvironmentCandidate,
} from "./candidate.js";
import {
  buildCoverageArtifacts,
  collectSourceProofs,
  PROOF_BUNDLE_FORMAT,
} from "./coverage.js";
import {
  classifyExtractionFailure,
  stageFail,
  stageForExtractionFailure,
  stageOk,
  type ExtractionFailureDisposition,
  type ExtractionFailureReason,
  type ExtractionStage,
  type StageOutcome,
} from "./failures.js";
import { harvestTouchedState } from "./harvest.js";
import {
  DEFAULT_ARCHIVE_BUDGET,
  DEFAULT_MAX_WIDENINGS,
  MAX_WIDENINGS_CEILING,
} from "./identifiers.js";
import { createLayeredStateBackend } from "./layered-backend.js";
import {
  mergeIntoStateArtifact,
  stateArtifactKeySet,
  type StateArtifact,
} from "./artifact.js";
import {
  differenceKeySets,
  keySetIsEmpty,
  type StateKeySet,
} from "./key-set.js";
import type { ArchiveUsage, ExtractionDeps } from "./ports.js";

export type { LayeredStateBackend } from "./layered-backend.js";
export { createLayeredStateBackend } from "./layered-backend.js";

export interface WideningRound {
  readonly index: number;
  readonly recordDigest: Sha256Digest;
  readonly outcome: ce3.ChainVerificationOutcome;
  readonly blackholedObservationDigest?: Sha256Digest;
  readonly matchedBaseline: boolean;
  readonly widenedBy?: StateKeySet;
  readonly archiveCalls: number;
}

export interface WidenOptions {
  readonly maxWidenings?: number;
  readonly runCount?: number;
  readonly budget?: Partial<typeof DEFAULT_ARCHIVE_BUDGET>;
}

export type ConvergenceResult =
  | {
    readonly status: "converged";
    readonly candidate: ChainEnvironmentCandidate;
    readonly attestation: ce3.SealedAttestation;
    readonly rounds: readonly WideningRound[];
    readonly archiveUsage: ArchiveUsage;
  }
  | {
    readonly status: "failed";
    readonly reason: ExtractionFailureReason;
    readonly disposition: ExtractionFailureDisposition;
    readonly stage: ExtractionStage;
    readonly detail: string;
    readonly rounds: readonly WideningRound[];
    readonly archiveUsage: ArchiveUsage;
    readonly attestation?: ce3.SealedAttestation;
  };

function asPrefixedDigest(digest: string): `sha256:${string}` {
  return digest.startsWith("sha256:") ? digest as `sha256:${string}` : `sha256:${digest}` as `sha256:${string}`;
}

function asDigestSet(digest: unknown): { sha256: string } {
  const sha256 = (digest as { sha256?: string }).sha256;
  if (sha256 === undefined) {
    throw new Error("descriptor digest.sha256 is required.");
  }
  return { sha256 };
}

function headerProofForAnchor(
  request: ExtractionRequest,
  record: ChainEnvironmentCandidate["record"],
): AnchorCapture["headerProof"] {
  if (request.headerProof !== undefined) return request.headerProof;
  const fromRecord = record.sourceAnchor?.headerProof;
  if (fromRecord === undefined || fromRecord.name === undefined || fromRecord.digest?.sha256 === undefined) {
    return undefined;
  }
  return {
    name: fromRecord.name,
    digest: { sha256: fromRecord.digest.sha256 },
  } satisfies HeaderProofDescriptor;
}

function anchorFromArtifact(
  artifact: StateArtifact,
  request: ExtractionRequest,
  headerProof: AnchorCapture["headerProof"],
): AnchorCapture {
  return {
    blockNumber: artifact.anchor.blockNumber,
    blockHash: artifact.anchor.blockHash,
    stateRoot: artifact.anchor.stateRoot,
    timestamp: artifact.anchor.timestamp,
    finality: {
      observedAt: new Date().toISOString(),
      finalizedBlockNumber: artifact.anchor.blockNumber,
      depthBelowFinalized: 0,
      finalizedAtObservation: request.finalityPolicy === "finalized",
    },
    headerProof,
  };
}

function loadSourceProofManifest(
  candidate: ChainEnvironmentCandidate,
): ce3.SourceProofManifest | undefined {
  if (candidate.record.stateMaterialization.fidelityClass === "local") {
    return undefined;
  }
  return JSON.parse(new TextDecoder().decode(candidate.coverage.manifestBytes)) as ce3.SourceProofManifest;
}

function isWidenableOutcome(outcome: ce3.ChainVerificationOutcome): boolean {
  return outcome === "closed-reproducible" || outcome === "initial-state-mismatch";
}

function failureForOutcome(
  outcome: ce3.ChainVerificationOutcome,
): { reason: ExtractionFailureReason; detail: string } {
  switch (outcome) {
    case "probe-divergence":
    case "reset-divergence":
      return {
        reason: "divergence-unexplained",
        detail: "The blackholed runs disagreed with each other; missing state cannot cause that.",
      };
    case "source-coverage-incomplete":
      return {
        reason: "coverage-incomplete",
        detail: "The sealed artifact carries entries CE4 cannot classify.",
      };
    case "artifact-unavailable":
      return {
        reason: "artifact-store-failure",
        detail: "A required artifact was unavailable during closed-state verification.",
      };
    case "verification-infrastructure-failure":
      return {
        reason: "runtime-failure",
        detail: "Verification infrastructure failed during closed-state verification.",
      };
    default:
      return {
        reason: "verification-refused",
        detail: `Closed-state verification returned "${outcome}", which widening cannot address.`,
      };
  }
}

function convergenceFailed(
  reason: ExtractionFailureReason,
  detail: string,
  rounds: readonly WideningRound[],
  archiveUsage: ArchiveUsage,
  attestation?: ce3.SealedAttestation,
): ConvergenceResult {
  return {
    status: "failed",
    reason,
    disposition: classifyExtractionFailure(reason),
    stage: stageForExtractionFailure(reason),
    detail,
    rounds,
    archiveUsage,
    ...(attestation === undefined ? {} : { attestation }),
  };
}

export async function localizeMissingState(
  deps: ExtractionDeps,
  archive: BudgetedArchivePort,
  input: {
    readonly candidate: ChainEnvironmentCandidate;
    readonly request: ExtractionRequest;
  },
): Promise<StageOutcome<StateKeySet>> {
  const record = input.candidate.record;
  const resourcesOutcome = await resolveClosedStateResources(deps.artifactStore, record);
  if (!resourcesOutcome.ok) return resourcesOutcome;

  const layered = createLayeredStateBackend(input.candidate.artifact, archive);
  const resources = resourcesOutcome.value;
  let instance: ChainInstance | undefined;

  try {
    instance = await deps.runtime.materializer.materialize({
      record,
      instanceId: "chain-extraction/localize",
      networkPolicy: ce3.ARCHIVE_NETWORK_POLICY,
      stateBackend: layered,
      resources,
    });

    if (instance.report === undefined) {
      return stageFail("runtime-failure", "Localization materialization returned no report.");
    }

    const probeSuiteBytes = resources.byDigest.get(
      ce3.fromDigestSet(asDigestSet(record.verificationContract.probeSuite.descriptor.digest)),
    );
    const comparatorBytes = resources.byDigest.get(
      asPrefixedDigest(String(record.verificationContract.comparator.digest)),
    );
    if (probeSuiteBytes === undefined || comparatorBytes === undefined) {
      return stageFail("runtime-failure", "Localization could not resolve probe resources.");
    }

    const probeResult = await deps.runtime.probes.execute({
      instance,
      probeSuiteBytes,
      comparatorBytes,
      timeoutSeconds: ce3.DEFAULT_PROBE_TIMEOUT_SECONDS,
    });
    if (probeResult.timedOut) {
      return stageFail("runtime-failure", "Localization probes timed out.");
    }

    for (const module of record.fixtures.modules) {
      const descriptor = module.module;
      if (descriptor.mediaType !== ce3.CHAIN_SOLUTION_MEDIA_TYPE) continue;

      const scriptBytes = resources.byDigest.get(ce3.fromDigestSet(asDigestSet(descriptor.digest)));
      if (scriptBytes === undefined) {
        return stageFail(
          "runtime-failure",
          `Localization could not resolve reference script ${module.id}.`,
        );
      }

      let script;
      try {
        script = ce3.parseChainSolutionScript(scriptBytes);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return stageFail(
          "runtime-failure",
          `Localization could not parse reference script ${module.id}: ${message}`,
        );
      }

      const replay = await deps.replayer.replay({
        instance,
        script,
        envelope: record.capabilityEnvelope,
      });
      if (replay.status === "refused") {
        return stageFail(
          "runtime-failure",
          `Localization refused reference script ${module.id}: ${replay.refusal.detail}`,
        );
      }
    }
  } catch (cause) {
    if (cause instanceof ce3.ChainVerificationError) {
      return stageFail("runtime-failure", `Localization failed: ${cause.message}`);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/Archive budget exhausted/u.test(message)) {
      return stageFail("archive-budget-exhausted", message);
    }
    return stageFail("runtime-failure", message);
  } finally {
    if (instance !== undefined) {
      await instance.stop().catch(() => undefined);
    }
  }

  return stageOk(differenceKeySets(layered.misses(), stateArtifactKeySet(input.candidate.artifact)));
}

async function widenCandidate(
  deps: ExtractionDeps,
  archive: BudgetedArchivePort,
  input: {
    readonly candidate: ChainEnvironmentCandidate;
    readonly request: ExtractionRequest;
    readonly missing: StateKeySet;
  },
): Promise<StageOutcome<ChainEnvironmentCandidate>> {
  const anchor = anchorFromArtifact(
    input.candidate.artifact,
    input.request,
    headerProofForAnchor(input.request, input.candidate.record),
  );

  const harvestOutcome = await harvestTouchedState(archive, {
    journal: input.missing,
    anchor,
  });
  if (!harvestOutcome.ok) return harvestOutcome;

  const artifact = mergeIntoStateArtifact(
    input.candidate.artifact,
    harvestOutcome.value.artifact.accounts,
  );

  const newAddresses = new Set<string>();
  for (const address of input.missing.accounts) newAddresses.add(address);
  for (const address of input.missing.code) newAddresses.add(address);
  for (const entry of input.missing.storage) newAddresses.add(entry.address);
  const sourceAddresses = [...new Set([
    ...input.request.sourceAddresses,
    ...input.candidate.artifact.accounts.map((account) => account.address),
    ...newAddresses,
  ])];

  let bundle;
  if (input.request.fidelityClass === "local") {
    bundle = {
      format: PROOF_BUNDLE_FORMAT,
      proofFormat: "eip-1186" as const,
      anchor: {
        blockNumber: artifact.anchor.blockNumber,
        blockHash: artifact.anchor.blockHash,
        stateRoot: artifact.anchor.stateRoot,
      },
      accounts: [],
    };
  } else {
    const proofsOutcome = await collectSourceProofs(archive, artifact, {
      addresses: sourceAddresses,
      stateRoot: anchor.stateRoot,
    });
    if (!proofsOutcome.ok) return proofsOutcome;
    bundle = proofsOutcome.value;
  }

  const coverageOutcome = buildCoverageArtifacts({
    artifact,
    fidelityClass: input.request.fidelityClass,
    bundle,
    declarations: input.request.fixtureDeclarations,
  });
  if (!coverageOutcome.ok) return coverageOutcome;

  const provisionalStored = await storeExtractionArtifacts(deps.artifactStore, artifact, coverageOutcome.value);
  if (!provisionalStored.ok) return provisionalStored;

  const provisional = buildClosedStateRecord(
    input.request,
    anchor,
    artifact,
    coverageOutcome.value,
    provisionalStored.value,
    input.candidate.record.stateMaterialization.initialStateCommitment as `0x${string}`,
  );

  const resourcesOutcome = await resolveClosedStateResources(deps.artifactStore, provisional);
  if (!resourcesOutcome.ok) return resourcesOutcome;

  const commitmentOutcome = await computeSealedInitialCommitment(
    deps,
    provisional,
    resourcesOutcome.value,
    artifact,
  );
  if (!commitmentOutcome.ok) return commitmentOutcome;

  return assembleCandidate(deps, {
    request: input.request,
    anchor,
    baseline: input.candidate.baseline,
    artifact,
    coverage: coverageOutcome.value,
    initialStateCommitment: commitmentOutcome.value,
  });
}

export async function widenAndReverify(
  deps: ExtractionDeps,
  input: { readonly candidate: ChainEnvironmentCandidate; readonly request: ExtractionRequest },
  options: WidenOptions = {},
): Promise<ConvergenceResult> {
  const maxWidenings = options.maxWidenings
    ?? input.request.maxWidenings
    ?? DEFAULT_MAX_WIDENINGS;
  if (maxWidenings > MAX_WIDENINGS_CEILING) {
    return convergenceFailed(
      "widen-bound-above-ceiling",
      `maxWidenings=${maxWidenings} exceeds the ceiling of ${MAX_WIDENINGS_CEILING}.`,
      [],
      { calls: 0, bytes: 0, limits: DEFAULT_ARCHIVE_BUDGET },
    );
  }

  const budget = { ...DEFAULT_ARCHIVE_BUDGET, ...input.request.budget, ...options.budget };
  const archive = createBudgetedArchivePort(deps.archive, budget);
  const ce3Deps = {
    runtime: deps.runtime,
    artifactStore: deps.artifactStore,
    signer: deps.signer,
    clock: deps.clock,
    verifier: deps.verifier,
  };

  let candidate = input.candidate;
  const rounds: WideningRound[] = [];

  for (let index = 0; index <= maxWidenings; index += 1) {
    const callsAtRoundStart = archive.usage().calls;
    const manifest = loadSourceProofManifest(candidate);

    const coverage = ce3.assessArtifactCoverage({
      fidelityClass: candidate.record.stateMaterialization.fidelityClass,
      entries: candidate.coverage.entries,
      ...(manifest === undefined ? {} : { manifest }),
      fixtureMutations: input.request.fixtureDeclarations,
      mutatesSourceProtocolState: candidate.coverage.mutatesSourceProtocolState,
    });
    if (!coverage.complete) {
      return convergenceFailed(
        "coverage-incomplete",
        `${coverage.uncovered} artifact entr(ies) are neither proof-covered nor fixture-declared.`,
        rounds,
        archive.usage(),
      );
    }

    let attestation: ce3.SealedAttestation;
    try {
      attestation = await ce3.verifyChainEnvironment(ce3Deps, candidate.record, {
        runCount: options.runCount ?? ce3.MINIMUM_RUN_COUNT,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return convergenceFailed(
        "runtime-failure",
        message,
        rounds,
        archive.usage(),
      );
    }

    if (attestation.statement.predicateType !== ce3.CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE) {
      return convergenceFailed(
        "verification-refused",
        `Expected predicate type ${ce3.CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE}; `
        + `received ${String(attestation.statement.predicateType)}.`,
        rounds,
        archive.usage(),
        attestation,
      );
    }

    const firstObservation = attestation.observations[0];
    const matchedBaseline = attestation.outcome === "closed-reproducible"
      && firstObservation !== undefined
      && ce3.chainObservationsEqual(firstObservation, candidate.baseline.observation);

    const round: WideningRound = {
      index,
      recordDigest: candidate.recordDigest,
      outcome: attestation.outcome,
      ...(firstObservation === undefined
        ? {}
        : { blackholedObservationDigest: ce3.chainObservationDigest(firstObservation) }),
      matchedBaseline,
      archiveCalls: archive.usage().calls - callsAtRoundStart,
    };
    rounds.push(round);

    if (matchedBaseline) {
      return {
        status: "converged",
        candidate,
        attestation,
        rounds,
        archiveUsage: archive.usage(),
      };
    }

    if (!isWidenableOutcome(attestation.outcome)) {
      const failure = failureForOutcome(attestation.outcome);
      return convergenceFailed(
        failure.reason,
        failure.detail,
        rounds,
        archive.usage(),
        attestation,
      );
    }

    if (index === maxWidenings) {
      const widenedSummary = rounds
        .filter((entry) => entry.widenedBy !== undefined && !keySetIsEmpty(entry.widenedBy))
        .map((entry) => `round ${entry.index}`)
        .join(", ");
      return convergenceFailed(
        "widen-bound-exhausted",
        widenedSummary.length === 0
          ? `Reached maxWidenings=${maxWidenings} without convergence.`
          : `Reached maxWidenings=${maxWidenings} after widening in ${widenedSummary}.`,
        rounds,
        archive.usage(),
        attestation,
      );
    }

    const localizeOutcome = await localizeMissingState(deps, archive, {
      candidate,
      request: input.request,
    });
    if (!localizeOutcome.ok) {
      return convergenceFailed(
        localizeOutcome.reason,
        localizeOutcome.detail,
        rounds,
        archive.usage(),
        attestation,
      );
    }

    const missing = localizeOutcome.value;
    if (keySetIsEmpty(missing)) {
      return convergenceFailed(
        "divergence-unexplained",
        "Observation diverged from the baseline with no out-of-slice read — check determinism "
        + "controls and runtime identity.",
        rounds,
        archive.usage(),
        attestation,
      );
    }

    const widenOutcome = await widenCandidate(deps, archive, {
      candidate,
      request: input.request,
      missing,
    });
    if (!widenOutcome.ok) {
      return convergenceFailed(
        widenOutcome.reason,
        widenOutcome.detail,
        rounds,
        archive.usage(),
        attestation,
      );
    }

    rounds[rounds.length - 1] = { ...round, widenedBy: missing };
    candidate = widenOutcome.value;
  }

  return convergenceFailed(
    "runtime-failure",
    "The widen loop ended without a terminal outcome.",
    rounds,
    archive.usage(),
  );
}
