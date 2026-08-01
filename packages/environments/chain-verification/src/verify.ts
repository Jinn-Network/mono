// SPDX-License-Identifier: Apache-2.0

import {
  chainEnvironmentRecordDigest,
  sealChainEnvironmentRecord,
  type ChainEnvironmentRecord,
  type ChainInstance,
  type NetworkPolicy,
  type VerifiedChainInstance,
} from "@jinn-network/chain-environment-record";
import {
  DSSE_PAYLOAD_TYPE,
  recordDigest,
  sealSignedRecord,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { assessClosure, type ClosureAssessment } from "./closure.js";
import {
  assessArtifactCoverage,
  type CoverageAssessment,
  type SourceProofManifest,
} from "./coverage.js";
import {
  buildEnvironmentObservation,
  checkRuntimeIdentity,
  checkSourceAnchor,
  declaredFixtureAccounts,
  declaredFixtureMutations,
} from "./instance-checks.js";
import { PrefixedSha256Schema, fromDigestSet, toDigestSet, type DigestSet, type ResourceDescriptor } from "./digests.js";
import { conformanceFailure, invalidInput } from "./errors.js";
import {
  CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";
import {
  buildCanonicalChainObservation,
  canonicalChainObservationBytes,
  chainObservationDigest,
  type CanonicalChainObservation,
} from "./observation.js";
import {
  isRunBearingOutcome,
  outcomeForFailureReason,
  stageForFailureReason,
  type ChainVerificationFailureReason,
  type ChainVerificationOutcome,
} from "./outcomes.js";
import {
  DEFAULT_BLACKHOLE_POLICY,
  type ArtifactStore,
  type ChainVerificationDeps,
  type ResolvedResource,
} from "./ports.js";
import type {
  ChainEnvironmentVerificationPredicate,
  EnvironmentObservation,
  FailureBlock,
  IsolationEvidence,
} from "./predicate.js";
import {
  canonicalResolutionLogBytes,
  resolveMaterials,
  type ResolutionRequest,
  type ResolutionResult,
} from "./resolve.js";
import {
  buildChainEnvironmentVerificationStatement,
  type ChainEnvironmentVerificationStatement,
} from "./statement.js";

export type { ChainVerificationDeps } from "./ports.js";

export interface VerifyChainEnvironmentOptions {
  /** K. Defaults to, and may never be below, `MINIMUM_RUN_COUNT`. */
  readonly runCount?: number;
  /** Defaults to `DEFAULT_BLACKHOLE_POLICY`. Pass `forkBackend: "present"` when the runtime
   * under test is configured with one; the closure evidence mode follows. */
  readonly networkPolicy?: NetworkPolicy;
  readonly probeTimeoutSeconds?: number;
  /** Namespace for the fresh instance ids this call requests. */
  readonly instanceIdPrefix?: string;
  readonly signal?: AbortSignal;
}

export interface SealedAttestation {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  /** Identity of the sealed envelope. */
  readonly attestationDigest: Sha256Digest;
  readonly statement: ChainEnvironmentVerificationStatement;
  /** Also at `statement.predicate.outcome`; surfaced so a caller need not reach in. */
  readonly outcome: ChainVerificationOutcome;
  /**
   * Instance ids of the K runs, in run order. Not part of the signed payload: a host-side
   * check that each run got a fresh materialization rather than a snapshot revert.
   */
  readonly instanceIds: readonly string[];
  /**
   * The K canonical observations, in run order. Not signed -- their digests are -- and
   * returned so a caller comparing against its own baseline (an extraction widen loop) does
   * not have to re-run the protocol to see what diverged.
   */
  readonly observations: readonly CanonicalChainObservation[];
}

interface RunRecord {
  readonly instanceId: string;
  readonly observation: CanonicalChainObservation;
  readonly digest: Sha256Digest;
  readonly wallSeconds: number;
}

interface ObservationContext {
  readonly resolved: readonly ResolvedResource[];
  readonly environment: EnvironmentObservation;
  readonly isolation: Omit<IsolationEvidence, "closureEvidenceMode" | "resolutionLog">;
  readonly closure: ClosureAssessment;
  readonly coverage: CoverageAssessment;
  readonly cost: { artifactBytes: number; artifactCount: number; wallSeconds: number };
}

type Observed =
  | { readonly kind: "runs"; readonly runs: readonly RunRecord[]; readonly context: ObservationContext }
  | {
    readonly kind: "failed";
    readonly reason: ChainVerificationFailureReason;
    readonly detail: string;
    readonly context: ObservationContext;
    readonly partial?: FailureBlock["coverage"];
    readonly divergence?: FailureBlock["divergence"];
    readonly completedRuns?: readonly RunRecord[];
    readonly instanceIds: readonly string[];
    readonly observations: readonly CanonicalChainObservation[];
  };

interface ObserveOptions {
  readonly runCount: number;
  readonly networkPolicy: NetworkPolicy;
  readonly probeTimeoutSeconds: number;
  readonly instanceIdPrefix: string;
  readonly signal: AbortSignal | undefined;
}

function toRfc3339Utc(instant: Date): string {
  const milliseconds = instant.getTime();
  if (!Number.isFinite(milliseconds)) invalidInput("The injected clock returned an invalid Date.");
  return new Date(milliseconds).toISOString();
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function asPrefixedDigest(digest: string): `sha256:${string}` {
  return PrefixedSha256Schema.parse(digest) as `sha256:${string}`;
}

function asDigestSet(digest: unknown): DigestSet {
  const sha256 = (digest as { sha256?: string }).sha256;
  if (sha256 === undefined) {
    invalidInput("descriptor digest.sha256 is required.");
  }
  return { sha256 };
}

function asResourceDescriptor(descriptor: unknown): ResourceDescriptor {
  const typed = descriptor as {
    readonly name?: string;
    readonly uri?: string;
    readonly mediaType?: string;
    readonly digest: { readonly sha256?: string };
  };
  return {
    ...(typed.name === undefined ? {} : { name: typed.name }),
    ...(typed.uri === undefined ? {} : { uri: typed.uri }),
    ...(typed.mediaType === undefined ? {} : { mediaType: typed.mediaType }),
    digest: asDigestSet(typed.digest),
  };
}

function prefixedDescriptor(
  name: string,
  digest: `sha256:${string}`,
): ResourceDescriptor {
  return { name, digest: toDigestSet(digest) };
}

/** Step 1's request list, read straight off the record's blocks. */
function materialRequests(record: ChainEnvironmentRecord): readonly ResolutionRequest[] {
  const requests: ResolutionRequest[] = [
    {
      name: "materializer",
      descriptor: prefixedDescriptor(
        record.stateMaterialization.materializer.id,
        asPrefixedDigest(record.stateMaterialization.materializer.digest),
      ),
    },
    {
      name: "probe-suite",
      descriptor: asResourceDescriptor(record.verificationContract.probeSuite.descriptor),
    },
    {
      name: "comparator",
      descriptor: prefixedDescriptor(
        record.verificationContract.comparator.id,
        asPrefixedDigest(record.verificationContract.comparator.digest),
      ),
    },
  ];
  if (record.stateMaterialization.stateArtifact !== undefined) {
    requests.push({
      name: "state-artifact",
      descriptor: asResourceDescriptor(record.stateMaterialization.stateArtifact.descriptor),
    });
  }
  if (record.stateMaterialization.sourceProofManifest !== undefined) {
    requests.push({
      name: "source-proof-manifest",
      descriptor: asResourceDescriptor(record.stateMaterialization.sourceProofManifest.proofs),
    });
  }
  if (record.stateMaterialization.fixtureCoverage?.manifest !== undefined) {
    requests.push({
      name: "fixture-coverage-manifest",
      descriptor: asResourceDescriptor(record.stateMaterialization.fixtureCoverage.manifest),
    });
  }
  if (record.sourceAnchor?.headerProof !== undefined) {
    requests.push({
      name: "header-proof",
      descriptor: asResourceDescriptor(record.sourceAnchor.headerProof),
    });
  }
  record.fixtures.modules.forEach((module, index) => {
    requests.push({
      name: `fixture-${index}-${module.id}`,
      descriptor: asResourceDescriptor(module.module),
    });
  });
  return requests;
}

function sourceManifestDigest(record: ChainEnvironmentRecord): Sha256Digest {
  const manifest = record.stateMaterialization.sourceProofManifest;
  if (manifest === undefined) {
    invalidInput("sourceProofManifest is absent on this record.");
  }
  return fromDigestSet(asDigestSet(manifest.proofs.digest));
}

function decodeSourceProofManifest(
  resolution: Extract<ResolutionResult, { ok: true }>,
  record: ChainEnvironmentRecord,
): SourceProofManifest {
  const bytes = resolution.bytes.get(sourceManifestDigest(record));
  if (bytes === undefined) {
    conformanceFailure("Resolved source-proof manifest bytes are missing from the resolution map.");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as SourceProofManifest;
}

function checkSourceProof(
  record: ChainEnvironmentRecord,
  manifest: SourceProofManifest,
): { readonly reason: ChainVerificationFailureReason; readonly detail: string } | undefined {
  const anchor = record.sourceAnchor;
  if (anchor === undefined) return undefined;
  if (manifest.anchorStateRoot !== anchor.stateRoot) {
    return {
      reason: "state-proof-invalid",
      detail: `manifest anchor ${manifest.anchorStateRoot} does not match record ${anchor.stateRoot}`,
    };
  }
  return undefined;
}

function boundaryProbeFrom(
  observation: CanonicalChainObservation,
  _record: ChainEnvironmentRecord,
): NonNullable<IsolationEvidence["boundaryProbe"]> {
  const probe = observation.probes.find((entry) => entry.id === "out-of-slice-read-is-empty");
  if (probe === undefined) {
    return { probeId: "out-of-slice-read", readsEmptyOutsideSlice: false };
  }
  return {
    probeId: "out-of-slice-read",
    readsEmptyOutsideSlice: probe.expectedErrorClass === "empty-account"
      && probe.observedErrorClass === "empty-account",
  };
}

function emptyContext(record: ChainEnvironmentRecord, options: ObserveOptions): ObservationContext {
  return {
    resolved: [],
    environment: buildEnvironmentObservation(record, undefined, undefined),
    isolation: {
      networkPolicy: options.networkPolicy,
      ...(options.networkPolicy.forkBackend === "absent"
        ? {
          boundaryProbe: {
            probeId: "out-of-slice-read",
            readsEmptyOutsideSlice: false,
          },
        }
        : {}),
      egressAttempts: [],
      forbiddenProbes: [],
      signerScope: {
        declaredRoles: record.capabilityEnvelope.signerRoles.map((role) => role.role),
        exposedAccounts: [],
        unexpectedAccounts: [],
      },
    },
    closure: {
      mode: options.networkPolicy.forkBackend === "present"
        ? "fork-backend-refusal"
        : "sealed-boundary",
      closed: false,
      evidence: [],
    },
    coverage: {
      applicable: false,
      complete: false,
      proofCovered: 0,
      fixtureDeclared: 0,
      uncovered: 0,
      uncoveredAccounts: [],
      uncoveredCodeEntries: [],
      uncoveredStorageSlots: [],
      undeclaredMutations: [],
    },
    cost: { artifactBytes: 0, artifactCount: 0, wallSeconds: 0 },
  };
}

async function storeArtifact(
  store: ArtifactStore,
  bytes: Uint8Array,
  descriptor: { readonly name: string; readonly mediaType: string },
  signal: AbortSignal | undefined,
): Promise<ResourceDescriptor> {
  const expected = recordDigest(bytes);
  const receipt = await store.putArtifact(bytes, signal === undefined ? undefined : { signal });
  if (receipt.digest !== expected) {
    conformanceFailure(
      `Artifact store returned ${receipt.digest} for bytes digesting to ${expected}.`,
    );
  }
  return { ...descriptor, digest: toDigestSet(expected) };
}

/**
 * Executes design §5.1's closed-state protocol against `record` and returns a DSSE-sealed
 * in-toto Statement.
 */
export async function verifyChainEnvironment(
  deps: ChainVerificationDeps,
  record: ChainEnvironmentRecord,
  options: VerifyChainEnvironmentOptions = {},
): Promise<SealedAttestation> {
  const runCount = options.runCount ?? MINIMUM_RUN_COUNT;
  if (!Number.isInteger(runCount) || runCount < MINIMUM_RUN_COUNT) {
    invalidInput(
      `This profile requires at least ${MINIMUM_RUN_COUNT} fresh materializations; received ${String(options.runCount)}.`,
    );
  }
  if (record.stateMaterialization.closureClass !== "closed-state") {
    invalidInput(
      "verifyChainEnvironment runs the closed-state protocol; an archive-dependent record is "
      + "observed through observeArchiveEnvironment, which makes the weaker claim design §5.2 "
      + "allows it to make.",
    );
  }

  const recordBytes = sealChainEnvironmentRecord(record);
  const recordDigestValue = PrefixedSha256Schema.parse(
    chainEnvironmentRecordDigest(recordBytes),
  ) as Sha256Digest;

  const startedAt = toRfc3339Utc(deps.clock.now());
  const observed = await observe(deps, record, {
    runCount,
    networkPolicy: options.networkPolicy ?? DEFAULT_BLACKHOLE_POLICY,
    probeTimeoutSeconds: options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS,
    instanceIdPrefix: options.instanceIdPrefix ?? recordDigestValue.slice("sha256:".length, 16),
    signal: options.signal,
  });
  const endedAt = toRfc3339Utc(deps.clock.now());

  const resolutionLog = await storeArtifact(
    deps.artifactStore,
    canonicalResolutionLogBytes(observed.context.resolved),
    { name: "resolution-log", mediaType: "application/json" },
    options.signal,
  );

  const window = { startedAt, endedAt };
  const predicate = observed.kind === "runs"
    ? await buildRunsPredicate(deps, window, observed, resolutionLog, options.signal)
    : observed.completedRuns !== undefined
      && isRunBearingOutcome(outcomeForFailureReason(observed.reason))
      ? await buildDivergencePredicate(
        deps,
        window,
        observed,
        observed.completedRuns,
        resolutionLog,
        options.signal,
      )
      : buildFailurePredicate(deps, window, observed, resolutionLog);

  const stateArtifact = record.stateMaterialization.stateArtifact;
  const statement = buildChainEnvironmentVerificationStatement({
    recordDigest: recordDigestValue,
    ...(stateArtifact === undefined
      ? {}
      : { stateArtifactDigest: fromDigestSet(asDigestSet(stateArtifact.descriptor.digest)) }),
    predicate,
  });

  const sealed = await sealSignedRecord({
    record: statement,
    payloadType: DSSE_PAYLOAD_TYPE,
    signer: deps.signer,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return {
    envelopeBytes: sealed.envelopeBytes,
    payloadBytes: sealed.payloadBytes,
    attestationDigest: sealed.recordDigest,
    statement,
    outcome: predicate.outcome,
    instanceIds: observed.kind === "runs"
      ? observed.runs.map((run) => run.instanceId)
      : observed.instanceIds,
    observations: observed.kind === "runs"
      ? observed.runs.map((run) => run.observation)
      : observed.observations,
  };
}

async function observe(
  deps: ChainVerificationDeps,
  record: ChainEnvironmentRecord,
  options: ObserveOptions,
): Promise<Observed> {
  const resolution = await resolveMaterials(
    deps.artifactStore,
    materialRequests(record),
    options.signal,
  );
  if (!resolution.ok) {
    return {
      kind: "failed",
      reason: resolution.reason,
      detail: resolution.detail,
      context: {
        ...emptyContext(record, options),
        resolved: resolution.resolved,
        cost: {
          artifactBytes: resolution.resolved.reduce((total, one) => total + one.size, 0),
          artifactCount: resolution.resolved.length,
          wallSeconds: 0,
        },
      },
      instanceIds: [],
      observations: [],
    };
  }

  const runs: RunRecord[] = [];
  const instanceIds: string[] = [];
  const observations: CanonicalChainObservation[] = [];
  let coverage: CoverageAssessment | undefined;
  let identity: VerifiedChainInstance | undefined;
  let egressAttempts: IsolationEvidence["egressAttempts"] = [];
  let forbiddenProbes: IsolationEvidence["forbiddenProbes"] = [];
  let signerScope: IsolationEvidence["signerScope"] = {
    declaredRoles: record.capabilityEnvelope.signerRoles.map((role) => role.role),
    exposedAccounts: [],
    unexpectedAccounts: [],
  };
  let loadedResources: string[] = [];
  let resetCommitment: `0x${string}` | undefined;
  let pendingResetFailure: { readonly detail: string } | undefined;
  let wallSeconds = 0;

  for (let index = 0; index < options.runCount; index += 1) {
    const instanceId = `${options.instanceIdPrefix}-run-${index}`;
    let instance: ChainInstance;
    try {
      instance = await deps.runtime.materializer.materialize({
        record,
        instanceId,
        networkPolicy: options.networkPolicy,
        resources: {
          byDigest: resolution.bytes as ReadonlyMap<`sha256:${string}`, Uint8Array>,
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      return fail("materializer-failed", `run ${index}: ${describeCause(cause)}`);
    }
    instanceIds.push(instance.instanceId);
    if (instance.report === undefined) {
      return fail("materialization-report-absent", `run ${index}: instance ${instance.instanceId}`);
    }
    const materialized = instance as VerifiedChainInstance;
    identity ??= materialized;
    egressAttempts = [...egressAttempts, ...materialized.report.isolation.egressAttempts];
    loadedResources = [...loadedResources, ...materialized.report.loadedResources];
    wallSeconds += materialized.report.cost.wallSeconds;

    try {
      const identityFailure = checkRuntimeIdentity(record, materialized);
      if (identityFailure !== undefined) return fail(identityFailure.reason, identityFailure.detail);

      if (coverage === undefined) {
        const manifest = record.stateMaterialization.sourceProofManifest !== undefined
          ? decodeSourceProofManifest(resolution, record)
          : undefined;
        if (manifest !== undefined) {
          const proofFailure = checkSourceProof(record, manifest);
          if (proofFailure !== undefined) return fail(proofFailure.reason, proofFailure.detail);
        }
        coverage = assessArtifactCoverage({
          fidelityClass: record.stateMaterialization.fidelityClass,
          entries: materialized.report.artifactEntries,
          ...(manifest === undefined ? {} : { manifest }),
          fixtureMutations: declaredFixtureMutations(record, resolution),
          mutatesSourceProtocolState:
            record.stateMaterialization.mutatesSourceProtocolState ?? false,
        });
        if (!coverage.complete) {
          return fail(
            coverage.reason ?? "artifact-entry-uncovered",
            `${coverage.uncovered} artifact entr(ies) are neither proof-covered nor fixture-declared`,
            {
              uncoveredAccounts: [...coverage.uncoveredAccounts],
              uncoveredCodeEntries: [...coverage.uncoveredCodeEntries],
              uncoveredStorageSlots: [...coverage.uncoveredStorageSlots],
              undeclaredMutations: [...coverage.undeclaredMutations],
            },
          );
        }
        const anchorFailure = checkSourceAnchor(record, materialized);
        if (anchorFailure !== undefined) return fail(anchorFailure.reason, anchorFailure.detail);
      }

      if (materialized.report.postFixtureCommitment
        !== record.stateMaterialization.initialStateCommitment) {
        return fail(
          "post-fixture-commitment-mismatch",
          `run ${index}: instantiated ${materialized.report.postFixtureCommitment}, record declares `
          + `${record.stateMaterialization.initialStateCommitment}`,
        );
      }

      forbiddenProbes = materialized.report.isolation.forbiddenProbes
        .map((probe) => ({ ...probe, passed: probe.observedClass === probe.expectedClass }));
      const failedProbe = forbiddenProbes.find((probe) => !probe.passed);
      if (failedProbe !== undefined) {
        return fail(
          "rpc-allowlist-violation",
          `run ${index}: ${failedProbe.method} answered ${failedProbe.observedClass}, expected `
          + failedProbe.expectedClass,
        );
      }
      const unexpectedAccounts = materialized.report.isolation.exposedSignerAccounts
        .filter((account) => !declaredFixtureAccounts(record).includes(account));
      signerScope = {
        declaredRoles: record.capabilityEnvelope.signerRoles.map((role) => role.role),
        exposedAccounts: [...materialized.report.isolation.exposedSignerAccounts],
        unexpectedAccounts,
      };
      if (unexpectedAccounts.length > 0) {
        return fail("signer-scope-violation", `run ${index}: ${unexpectedAccounts.join(", ")}`);
      }
      const unenforced = materialized.report.isolation.ceilingChecks.find((one) => !one.enforced);
      if (unenforced !== undefined) {
        return fail("ceiling-not-enforced", `run ${index}: ${unenforced.name}`);
      }

      let probeResult;
      try {
        const probeSuiteBytes = resolution.bytes.get(
          fromDigestSet(asDigestSet(record.verificationContract.probeSuite.descriptor.digest)),
        );
        const comparatorBytes = resolution.bytes.get(
          asPrefixedDigest(record.verificationContract.comparator.digest),
        );
        if (probeSuiteBytes === undefined || comparatorBytes === undefined) {
          return fail("resource-unresolvable", `run ${index}: probe resources missing from resolution`);
        }
        probeResult = await deps.runtime.probes.execute({
          instance,
          probeSuiteBytes,
          comparatorBytes,
          timeoutSeconds: options.probeTimeoutSeconds,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (cause) {
        return fail("probe-executor-failed", `run ${index}: ${describeCause(cause)}`);
      }
      if (probeResult.timedOut) {
        return fail("run-timeout", `run ${index} exceeded ${options.probeTimeoutSeconds}s`);
      }
      const observation = buildCanonicalChainObservation(probeResult.observation);
      observations.push(observation);
      runs.push({
        instanceId: instance.instanceId,
        observation,
        digest: chainObservationDigest(observation),
        wallSeconds: probeResult.cost.wallSeconds,
      });
      wallSeconds += probeResult.cost.wallSeconds;

      if (index === 0 && record.verificationContract.resetRequirements.minimumRuns > 0) {
        const postReset = await deps.runtime.materializer.reset(instance, options.signal);
        resetCommitment = postReset;
        if (postReset !== materialized.report.postFixtureCommitment) {
          pendingResetFailure = {
            detail: `reset produced ${postReset}, baseline is ${materialized.report.postFixtureCommitment}`,
          };
        }
      }
    } finally {
      await instance.stop();
    }
  }

  if (pendingResetFailure !== undefined) {
    return fail(
      "reset-observation-divergence",
      pendingResetFailure.detail,
      undefined,
      runs,
    );
  }

  const reference = runs[0]!;
  const divergent = runs
    .map((run, runIndex) => ({ run, index: runIndex }))
    .filter(({ run }) => run.digest !== reference.digest);
  const observationsEqual = divergent.length === 0;

  const closure = assessClosure({
    networkPolicy: options.networkPolicy,
    egressAttempts,
    ...(options.networkPolicy.forkBackend === "absent"
      ? { boundaryProbe: boundaryProbeFrom(reference.observation, record) }
      : {}),
    resolvedDigests: resolution.resolved.map((one) => one.digest),
    loadedResources,
    observationsEqual,
  });

  const context: ObservationContext = {
    resolved: resolution.resolved,
    environment: buildEnvironmentObservation(record, identity!, coverage),
    isolation: {
      networkPolicy: options.networkPolicy,
      ...(options.networkPolicy.forkBackend === "absent"
        ? { boundaryProbe: boundaryProbeFrom(reference.observation, record) }
        : {}),
      egressAttempts,
      forbiddenProbes,
      signerScope,
      ...(resetCommitment === undefined ? {} : { resetCommitment }),
    },
    closure,
    coverage: coverage!,
    cost: {
      artifactBytes: resolution.resolved.reduce((total, one) => total + one.size, 0),
      artifactCount: resolution.resolved.length,
      wallSeconds,
    },
  };

  if (!closure.closed && closure.reason !== "probe-observation-divergence") {
    return {
      kind: "failed",
      reason: closure.reason!,
      detail: closure.detail ?? "closure assessment failed",
      context,
      instanceIds,
      observations,
    };
  }
  if (!observationsEqual) {
    return {
      kind: "failed",
      reason: "probe-observation-divergence",
      detail: `${divergent.length} of ${runs.length} runs diverged from run 0`,
      context,
      completedRuns: runs,
      instanceIds,
      observations,
      divergence: {
        referenceRunIndex: 0,
        referenceObservationDigest: reference.digest,
        divergentRuns: divergent.map(({ run, index: runIndex }) => ({
          index: runIndex,
          instanceId: run.instanceId,
          observationDigest: run.digest,
          observation: { name: `observation-run-${runIndex}`, digest: toDigestSet(run.digest) },
        })),
      },
    };
  }

  return { kind: "runs", runs, context };

  function fail(
    reason: ChainVerificationFailureReason,
    detail: string,
    partial?: FailureBlock["coverage"],
    completedRuns?: readonly RunRecord[],
  ): Observed {
    const sealed = options.networkPolicy.forkBackend === "absent";
    const latestObservation = observations[observations.length - 1];
    return {
      kind: "failed",
      reason,
      detail,
      ...(completedRuns === undefined ? {} : { completedRuns }),
      context: {
        resolved: resolution.resolved,
        environment: buildEnvironmentObservation(record, identity, coverage),
        isolation: {
          networkPolicy: options.networkPolicy,
          ...(sealed
            ? {
              boundaryProbe: latestObservation === undefined
                ? { probeId: "out-of-slice-read", readsEmptyOutsideSlice: false }
                : boundaryProbeFrom(latestObservation, record),
            }
            : {}),
          egressAttempts,
          forbiddenProbes,
          signerScope,
          ...(resetCommitment === undefined ? {} : { resetCommitment }),
        },
        closure: {
          mode: options.networkPolicy.forkBackend === "present"
            ? "fork-backend-refusal"
            : "sealed-boundary",
          closed: false,
          evidence: [],
        },
        coverage: coverage ?? {
          applicable: false,
          complete: false,
          proofCovered: 0,
          fixtureDeclared: 0,
          uncovered: 0,
          uncoveredAccounts: [],
          uncoveredCodeEntries: [],
          uncoveredStorageSlots: [],
          undeclaredMutations: [],
        },
        cost: {
          artifactBytes: resolution.resolved.reduce((total, one) => total + one.size, 0),
          artifactCount: resolution.resolved.length,
          wallSeconds,
        },
      },
      instanceIds,
      observations,
      ...(partial === undefined ? {} : { partial }),
    };
  }
}

async function buildRunsPredicate(
  deps: ChainVerificationDeps,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<Observed, { kind: "runs" }>,
  resolutionLog: ResourceDescriptor,
  signal: AbortSignal | undefined,
): Promise<ChainEnvironmentVerificationPredicate> {
  const reference = observed.runs[0]!;
  const baselineDescriptor = await storeArtifact(
    deps.artifactStore,
    canonicalChainObservationBytes(reference.observation),
    { name: "observation", mediaType: "application/json" },
    signal,
  );
  return {
    protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    scope: "component",
    outcome: "closed-reproducible",
    window,
    verifier: deps.verifier,
    materials: observed.context.resolved.map((one) => ({
      name: one.name,
      digest: toDigestSet(one.digest),
    })),
    environment: observed.context.environment,
    runs: {
      count: observed.runs.length,
      observationDigest: reference.digest,
      perRun: observed.runs.map((run) => ({
        instanceId: run.instanceId,
        observationDigest: run.digest,
        wallSeconds: run.wallSeconds,
      })),
      allObservationsEqual: true,
      freshInstances:
        new Set(observed.runs.map((run) => run.instanceId)).size === observed.runs.length,
    },
    baseline: {
      commitment: observed.context.environment.postFixtureCommitment,
      observation: baselineDescriptor,
    },
    isolation: {
      ...observed.context.isolation,
      closureEvidenceMode: observed.context.closure.mode,
      resolutionLog,
    },
    cost: observed.context.cost,
  } as ChainEnvironmentVerificationPredicate;
}

/**
 * `probe-divergence` is run-bearing: the K runs completed and disagreed, which is a fact
 * about the environment and carries the full repetition evidence. `baseline` is run 0's
 * observation -- one observation among divergent ones, not the environment's answer -- and a
 * reader who takes it without also reading `failure.divergence` is reading past the claim.
 */
async function buildDivergencePredicate(
  deps: ChainVerificationDeps,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<Observed, { kind: "failed" }>,
  runs: readonly RunRecord[],
  resolutionLog: ResourceDescriptor,
  signal: AbortSignal | undefined,
): Promise<ChainEnvironmentVerificationPredicate> {
  const reference = runs[0]!;
  const baselineDescriptor = await storeArtifact(
    deps.artifactStore,
    canonicalChainObservationBytes(reference.observation),
    { name: "observation", mediaType: "application/json" },
    signal,
  );
  for (const run of runs.slice(1).filter((one) => one.digest !== reference.digest)) {
    await storeArtifact(
      deps.artifactStore,
      canonicalChainObservationBytes(run.observation),
      { name: `observation-${run.instanceId}`, mediaType: "application/json" },
      signal,
    );
  }
  const allObservationsEqual = runs.every((run) => run.digest === reference.digest);
  return {
    ...buildFailurePredicate(deps, window, observed, resolutionLog),
    runs: {
      count: runs.length,
      observationDigest: reference.digest,
      perRun: runs.map((run) => ({
        instanceId: run.instanceId,
        observationDigest: run.digest,
        wallSeconds: run.wallSeconds,
      })),
      allObservationsEqual,
      freshInstances: new Set(runs.map((run) => run.instanceId)).size === runs.length,
    },
    baseline: {
      commitment: observed.context.environment.postFixtureCommitment,
      observation: baselineDescriptor,
    },
  } as ChainEnvironmentVerificationPredicate;
}

function buildFailurePredicate(
  deps: ChainVerificationDeps,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<Observed, { kind: "failed" }>,
  resolutionLog: ResourceDescriptor,
): ChainEnvironmentVerificationPredicate {
  return {
    protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    scope: "component",
    outcome: outcomeForFailureReason(observed.reason),
    window,
    verifier: deps.verifier,
    materials: observed.context.resolved.map((one) => ({
      name: one.name,
      digest: toDigestSet(one.digest),
    })),
    environment: observed.context.environment,
    isolation: {
      ...observed.context.isolation,
      closureEvidenceMode: observed.context.closure.mode,
      resolutionLog,
    },
    cost: observed.context.cost,
    failure: {
      stage: stageForFailureReason(observed.reason),
      reason: observed.reason,
      detail: observed.detail,
      ...(observed.divergence === undefined ? {} : { divergence: observed.divergence }),
      ...(observed.partial === undefined ? {} : { coverage: observed.partial }),
    },
  } as ChainEnvironmentVerificationPredicate;
}
