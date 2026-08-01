// SPDX-License-Identifier: Apache-2.0

/**
 * Design §5.2, the authoring class. K fresh materializations against at least two
 * independently operated providers where policy permits, the same probe suite, and an
 * attestation that records providers, observation time, RPC methods/calls/bytes, and any
 * disagreement.
 *
 * What `archive-observed` means, in full: at the recorded time, these providers supplied
 * state consistent with the declared anchor and produced these observations. It does not
 * speak to offline repeatability, provider retention, or durable-pool eligibility.
 * Marketplace supply advertised as re-verifiable attestation evidence MUST reference a `closed-state`
 * attestation instead, which is why this entry point can never emit `closed-reproducible`.
 */

import {
  chainEnvironmentRecordDigest,
  requiresStateBackend,
  sealChainEnvironmentRecord,
  type ChainEnvironmentRecord,
  type ChainInstance,
  type ChainStateBackend,
  type NetworkPolicy,
  type VerifiedChainInstance,
} from "@jinn-network/chain-environment-record";
import {
  DSSE_PAYLOAD_TYPE,
  recordDigest,
  sealSignedRecord,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import {
  assessArtifactCoverage,
  type CoverageAssessment,
  type SourceProofManifest,
} from "./coverage.js";
import { PrefixedSha256Schema, fromDigestSet, toDigestSet, type DigestSet, type ResourceDescriptor } from "./digests.js";
import { conformanceFailure, invalidInput } from "./errors.js";
import {
  CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";
import {
  buildEnvironmentObservation,
  checkRuntimeIdentity,
  checkSourceAnchor,
  declaredFixtureAccounts,
  declaredFixtureMutations,
} from "./instance-checks.js";
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
import type {
  ChainEnvironmentVerificationPredicate,
  EnvironmentObservation,
  FailureBlock,
  IsolationEvidence,
  ProviderObservation,
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
import type { ChainVerificationDeps } from "./ports.js";
import type { SealedAttestation } from "./verify.js";

export type { SealedAttestation } from "./verify.js";

/** Archive observation uses a fork backend; archive RPC on the policy stays unreachable. */
export const ARCHIVE_NETWORK_POLICY: NetworkPolicy = Object.freeze({
  egress: "denied",
  dns: "absent",
  archiveRpc: "unreachable",
  forkBackend: "present",
}) as NetworkPolicy;

export interface ArchiveProviderSpec {
  readonly id: string;
  readonly stateBackend: ChainStateBackend;
}

export interface ObserveArchiveOptions {
  readonly providers: readonly ArchiveProviderSpec[];
  /** K. Defaults to, and may never be below, `MINIMUM_RUN_COUNT`. */
  readonly runCount?: number;
  readonly probeTimeoutSeconds?: number;
  readonly instanceIdPrefix?: string;
  readonly signal?: AbortSignal;
}

interface RunRecord {
  readonly instanceId: string;
  readonly providerId: string;
  readonly observation: CanonicalChainObservation;
  readonly digest: Sha256Digest;
  readonly wallSeconds: number;
}

interface ProviderRunSummary {
  readonly id: string;
  readonly runs: readonly RunRecord[];
  readonly rpcCalls: number;
  readonly rpcBytes: number;
  readonly observedAt: string;
  readonly observationDigest: Sha256Digest;
}

interface ObservationContext {
  readonly resolved: readonly { name: string; descriptor: ResourceDescriptor; digest: Sha256Digest; size: number }[];
  readonly environment: EnvironmentObservation;
  readonly isolation: Omit<IsolationEvidence, "closureEvidenceMode" | "resolutionLog">;
  readonly coverage: CoverageAssessment;
  readonly cost: {
    artifactBytes: number;
    artifactCount: number;
    wallSeconds: number;
    rpcCalls: number;
    rpcBytes: number;
  };
}

type Observed =
  | {
    readonly kind: "success";
    readonly runs: readonly RunRecord[];
    readonly providers: readonly ProviderRunSummary[];
    readonly context: ObservationContext;
    readonly singleProviderNote?: ResourceDescriptor;
  }
  | {
    readonly kind: "failed";
    readonly reason: ChainVerificationFailureReason;
    readonly detail: string;
    readonly context: ObservationContext;
    readonly partial?: FailureBlock["coverage"];
    readonly completedRuns?: readonly RunRecord[];
    readonly instanceIds: readonly string[];
    readonly observations: readonly CanonicalChainObservation[];
    readonly providers?: readonly ProviderRunSummary[];
  };

interface RpcJournal {
  rpcCalls: number;
  rpcBytes: number;
}

function journalBackend(backend: ChainStateBackend, journal: RpcJournal): ChainStateBackend {
  const bump = (bytes: number): void => {
    journal.rpcCalls += 1;
    journal.rpcBytes += bytes;
  };
  return {
    async getAccount(address, blockNumber) {
      bump(128);
      return backend.getAccount(address, blockNumber);
    },
    async getCode(address, blockNumber) {
      bump(256);
      return backend.getCode(address, blockNumber);
    },
    async getStorageAt(address, slot, blockNumber) {
      bump(64);
      return backend.getStorageAt(address, slot, blockNumber);
    },
    async getBlockHeader(blockNumber) {
      bump(512);
      return backend.getBlockHeader(blockNumber);
    },
  };
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

function distributeRuns(providerCount: number, total: number): number[] {
  const counts = Array.from({ length: providerCount }, () => Math.floor(total / providerCount));
  let remainder = total % providerCount;
  for (let index = 0; index < providerCount && remainder > 0; index += 1) {
    counts[index]! += 1;
    remainder -= 1;
  }
  for (let index = 0; index < providerCount; index += 1) {
    if (counts[index]! < 1) counts[index] = 1;
  }
  return counts;
}

async function storeArtifact(
  deps: ChainVerificationDeps,
  bytes: Uint8Array,
  descriptor: { readonly name: string; readonly mediaType: string },
  signal: AbortSignal | undefined,
): Promise<ResourceDescriptor> {
  const expected = recordDigest(bytes);
  const receipt = await deps.artifactStore.putArtifact(
    bytes,
    signal === undefined ? undefined : { signal },
  );
  if (receipt.digest !== expected) {
    conformanceFailure(
      `Artifact store returned ${receipt.digest} for bytes digesting to ${expected}.`,
    );
  }
  return { ...descriptor, digest: toDigestSet(expected) };
}

function emptyContext(record: ChainEnvironmentRecord): ObservationContext {
  return {
    resolved: [],
    environment: buildEnvironmentObservation(record, undefined, undefined),
    isolation: {
      networkPolicy: ARCHIVE_NETWORK_POLICY,
      egressAttempts: [],
      forbiddenProbes: [],
      signerScope: {
        declaredRoles: record.capabilityEnvelope.signerRoles.map((role) => role.role),
        exposedAccounts: [],
        unexpectedAccounts: [],
      },
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
    cost: { artifactBytes: 0, artifactCount: 0, wallSeconds: 0, rpcCalls: 0, rpcBytes: 0 },
  };
}

function validateProviders(
  record: ChainEnvironmentRecord,
  providers: readonly ArchiveProviderSpec[],
): void {
  if (providers.length === 0) {
    invalidInput("observeArchiveEnvironment requires at least one archive provider.");
  }
  if (requiresStateBackend(record)) {
    for (const provider of providers) {
      if (provider.stateBackend === undefined) {
        invalidInput(
          "each archive provider must supply a stateBackend for archive-dependent records.",
        );
      }
    }
  }
}

/**
 * Design §5.2's weaker observation protocol. Never emits `closed-reproducible` and never
 * calls `assessClosure`.
 */
export async function observeArchiveEnvironment(
  deps: ChainVerificationDeps,
  record: ChainEnvironmentRecord,
  options?: ObserveArchiveOptions,
): Promise<SealedAttestation> {
  if (record.stateMaterialization.closureClass !== "archive-dependent") {
    invalidInput(
      "observeArchiveEnvironment runs the archive-dependent protocol; a closed-state record is "
      + "checked through verifyChainEnvironment, which makes the stronger bounded claim design §5.1 allows.",
    );
  }
  if (options === undefined) {
    invalidInput("observeArchiveEnvironment requires archive provider options.");
  }
  const runCount = options.runCount ?? MINIMUM_RUN_COUNT;
  if (!Number.isInteger(runCount) || runCount < MINIMUM_RUN_COUNT) {
    invalidInput(
      `This profile requires at least ${MINIMUM_RUN_COUNT} fresh materializations; received ${String(options.runCount)}.`,
    );
  }
  validateProviders(record, options.providers);

  const recordBytes = sealChainEnvironmentRecord(record);
  const recordDigestValue = PrefixedSha256Schema.parse(
    chainEnvironmentRecordDigest(recordBytes),
  ) as Sha256Digest;

  const startedAt = toRfc3339Utc(deps.clock.now());
  const observed = await observeArchive(
    deps,
    record,
    options.providers,
    {
      runCount,
      probeTimeoutSeconds: options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS,
      instanceIdPrefix:
        options.instanceIdPrefix ?? recordDigestValue.slice("sha256:".length, 16),
      signal: options.signal,
    },
  );
  const endedAt = toRfc3339Utc(deps.clock.now());

  const resolutionLog = await storeArtifact(
    deps,
    canonicalResolutionLogBytes(observed.context.resolved),
    { name: "resolution-log", mediaType: "application/json" },
    options.signal,
  );

  const window = { startedAt, endedAt };
  const predicate = observed.kind === "success"
    ? await buildArchiveSuccessPredicate(
      deps,
      window,
      observed,
      resolutionLog,
      options.signal,
    )
    : observed.completedRuns !== undefined
      && isRunBearingOutcome(outcomeForFailureReason(observed.reason))
      ? await buildArchiveDivergencePredicate(
        deps,
        window,
        observed,
        observed.completedRuns,
        resolutionLog,
        options.signal,
      )
      : buildArchiveFailurePredicate(deps, window, observed, resolutionLog);

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
    instanceIds: observed.kind === "success"
      ? observed.runs.map((run) => run.instanceId)
      : observed.instanceIds,
    observations: observed.kind === "success"
      ? observed.runs.map((run) => run.observation)
      : observed.observations,
  };
}

async function observeArchive(
  deps: ChainVerificationDeps,
  record: ChainEnvironmentRecord,
  providers: readonly ArchiveProviderSpec[],
  options: {
    readonly runCount: number;
    readonly probeTimeoutSeconds: number;
    readonly instanceIdPrefix: string;
    readonly signal: AbortSignal | undefined;
  },
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
        ...emptyContext(record),
        resolved: resolution.resolved,
        cost: {
          artifactBytes: resolution.resolved.reduce((total, one) => total + one.size, 0),
          artifactCount: resolution.resolved.length,
          wallSeconds: 0,
          rpcCalls: 0,
          rpcBytes: 0,
        },
      },
      instanceIds: [],
      observations: [],
    };
  }

  const runs: RunRecord[] = [];
  const instanceIds: string[] = [];
  const observations: CanonicalChainObservation[] = [];
  const providerSummaries: ProviderRunSummary[] = [];
  let coverage: CoverageAssessment | undefined;
  let identity: VerifiedChainInstance | undefined;
  let egressAttempts: IsolationEvidence["egressAttempts"] = [];
  let forbiddenProbes: IsolationEvidence["forbiddenProbes"] = [];
  let signerScope: IsolationEvidence["signerScope"] = {
    declaredRoles: record.capabilityEnvelope.signerRoles.map((role) => role.role),
    exposedAccounts: [],
    unexpectedAccounts: [],
  };
  let wallSeconds = 0;
  let totalRpcCalls = 0;
  let totalRpcBytes = 0;

  const runCounts = distributeRuns(providers.length, options.runCount);
  let runIndex = 0;

  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex]!;
    const journal: RpcJournal = { rpcCalls: 0, rpcBytes: 0 };
    const journaledBackend = journalBackend(provider.stateBackend, journal);
    const providerRuns: RunRecord[] = [];
    const observedAt = toRfc3339Utc(deps.clock.now());

    for (let localIndex = 0; localIndex < runCounts[providerIndex]!; localIndex += 1) {
      const instanceId = `${options.instanceIdPrefix}-${provider.id}-run-${localIndex}`;
      let instance: ChainInstance;
      try {
        instance = await deps.runtime.materializer.materialize({
          record,
          instanceId,
          networkPolicy: ARCHIVE_NETWORK_POLICY,
          stateBackend: journaledBackend,
          resources: {
            byDigest: resolution.bytes as ReadonlyMap<`sha256:${string}`, Uint8Array>,
          },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (cause) {
        return fail("materializer-failed", `run ${runIndex}: ${describeCause(cause)}`);
      }
      instanceIds.push(instance.instanceId);
      if (instance.report === undefined) {
        return fail(
          "materialization-report-absent",
          `run ${runIndex}: instance ${instance.instanceId}`,
        );
      }
      const materialized = instance as VerifiedChainInstance;
      identity ??= materialized;
      egressAttempts = [...egressAttempts, ...materialized.report.isolation.egressAttempts];
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
            `run ${runIndex}: instantiated ${materialized.report.postFixtureCommitment}, record declares `
            + `${record.stateMaterialization.initialStateCommitment}`,
          );
        }

        forbiddenProbes = materialized.report.isolation.forbiddenProbes
          .map((probe) => ({ ...probe, passed: probe.observedClass === probe.expectedClass }));
        const failedProbe = forbiddenProbes.find((probe) => !probe.passed);
        if (failedProbe !== undefined) {
          return fail(
            "rpc-allowlist-violation",
            `run ${runIndex}: ${failedProbe.method} answered ${failedProbe.observedClass}, expected `
            + `${failedProbe.expectedClass}`,
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
          return fail("signer-scope-violation", `run ${runIndex}: ${unexpectedAccounts.join(", ")}`);
        }
        const unenforced = materialized.report.isolation.ceilingChecks.find((one) => !one.enforced);
        if (unenforced !== undefined) {
          return fail("ceiling-not-enforced", `run ${runIndex}: ${unenforced.name}`);
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
            return fail("resource-unresolvable", `run ${runIndex}: probe resources missing from resolution`);
          }
          probeResult = await deps.runtime.probes.execute({
            instance,
            probeSuiteBytes,
            comparatorBytes,
            timeoutSeconds: options.probeTimeoutSeconds,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
        } catch (cause) {
          return fail("probe-executor-failed", `run ${runIndex}: ${describeCause(cause)}`);
        }
        if (probeResult.timedOut) {
          return fail("run-timeout", `run ${runIndex} exceeded ${options.probeTimeoutSeconds}s`);
        }
        const observation = buildCanonicalChainObservation(probeResult.observation);
        observations.push(observation);
        const runRecord: RunRecord = {
          instanceId: instance.instanceId,
          providerId: provider.id,
          observation,
          digest: chainObservationDigest(observation),
          wallSeconds: probeResult.cost.wallSeconds,
        };
        runs.push(runRecord);
        providerRuns.push(runRecord);
        wallSeconds += probeResult.cost.wallSeconds;
      } finally {
        await instance.stop();
      }
      runIndex += 1;
    }

    const reference = providerRuns[0]!;
    const observationDigest = reference.digest;
    providerSummaries.push({
      id: provider.id,
      runs: providerRuns,
      rpcCalls: journal.rpcCalls,
      rpcBytes: journal.rpcBytes,
      observedAt,
      observationDigest,
    });
    totalRpcCalls += journal.rpcCalls;
    totalRpcBytes += journal.rpcBytes;
  }

  const providerDigests = new Set(providerSummaries.map((one) => one.observationDigest));
  if (providerDigests.size > 1) {
    const context = buildContext(
      record,
      resolution,
      identity,
      coverage,
      egressAttempts,
      forbiddenProbes,
      signerScope,
      wallSeconds,
      totalRpcCalls,
      totalRpcBytes,
    );
    return {
      kind: "failed",
      reason: "provider-observation-disagreement",
      detail: `${providerDigests.size} providers produced distinct observation digests`,
      context,
      completedRuns: runs,
      instanceIds,
      observations,
      providers: providerSummaries,
    };
  }

  const context = buildContext(
    record,
    resolution,
    identity,
    coverage,
    egressAttempts,
    forbiddenProbes,
    signerScope,
    wallSeconds,
    totalRpcCalls,
    totalRpcBytes,
  );

  let singleProviderNote: ResourceDescriptor | undefined;
  if (providers.length === 1) {
    singleProviderNote = await storeArtifact(
      deps,
      new TextEncoder().encode(
        "Design §5.2 prefers two independently operated providers where policy permits; "
        + "one provider was available and is recorded without upgrade.",
      ),
      { name: "provider-availability-note", mediaType: "text/plain" },
      options.signal,
    );
  }

  return {
    kind: "success",
    runs,
    providers: providerSummaries,
    context,
    ...(singleProviderNote === undefined ? {} : { singleProviderNote }),
  };

  function fail(
    reason: ChainVerificationFailureReason,
    detail: string,
    partial?: FailureBlock["coverage"],
    completedRuns?: readonly RunRecord[],
  ): Observed {
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
          networkPolicy: ARCHIVE_NETWORK_POLICY,
          egressAttempts,
          forbiddenProbes,
          signerScope,
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
          rpcCalls: totalRpcCalls,
          rpcBytes: totalRpcBytes,
        },
      },
      instanceIds,
      observations,
      ...(partial === undefined ? {} : { partial }),
      ...(providerSummaries.length === 0 ? {} : { providers: providerSummaries }),
    };
  }
}

function buildContext(
  record: ChainEnvironmentRecord,
  resolution: Extract<ResolutionResult, { ok: true }>,
  identity: VerifiedChainInstance | undefined,
  coverage: CoverageAssessment | undefined,
  egressAttempts: IsolationEvidence["egressAttempts"],
  forbiddenProbes: IsolationEvidence["forbiddenProbes"],
  signerScope: IsolationEvidence["signerScope"],
  wallSeconds: number,
  rpcCalls: number,
  rpcBytes: number,
): ObservationContext {
  return {
    resolved: resolution.resolved,
    environment: buildEnvironmentObservation(record, identity, coverage),
    isolation: {
      networkPolicy: ARCHIVE_NETWORK_POLICY,
      egressAttempts,
      forbiddenProbes,
      signerScope,
    },
    coverage: coverage!,
    cost: {
      artifactBytes: resolution.resolved.reduce((total, one) => total + one.size, 0),
      artifactCount: resolution.resolved.length,
      wallSeconds,
      rpcCalls,
      rpcBytes,
    },
  };
}

function providerObservations(
  summaries: readonly ProviderRunSummary[],
): readonly ProviderObservation[] {
  return summaries.map((summary) => ({
    id: summary.id,
    observedAt: summary.observedAt,
    rpcCalls: summary.rpcCalls,
    rpcBytes: summary.rpcBytes,
    observationDigest: summary.observationDigest,
  }));
}

async function buildArchiveSuccessPredicate(
  deps: ChainVerificationDeps,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<Observed, { kind: "success" }>,
  resolutionLog: ResourceDescriptor,
  signal: AbortSignal | undefined,
): Promise<ChainEnvironmentVerificationPredicate> {
  const reference = observed.runs[0]!;
  const baselineDescriptor = await storeArtifact(
    deps,
    canonicalChainObservationBytes(reference.observation),
    { name: "observation", mediaType: "application/json" },
    signal,
  );
  return {
    protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    scope: "component",
    outcome: "archive-observed",
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
      allObservationsEqual: observed.runs.every((run) => run.digest === reference.digest),
      freshInstances:
        new Set(observed.runs.map((run) => run.instanceId)).size === observed.runs.length,
    },
    baseline: {
      commitment: observed.context.environment.postFixtureCommitment,
      observation: baselineDescriptor,
    },
    isolation: {
      ...observed.context.isolation,
      closureEvidenceMode: "fork-backend-refusal",
      resolutionLog,
    },
    cost: observed.context.cost,
    providers: providerObservations(observed.providers),
    ...(observed.singleProviderNote === undefined
      ? {}
      : { evidence: [observed.singleProviderNote] }),
  } as ChainEnvironmentVerificationPredicate;
}

async function buildArchiveDivergencePredicate(
  deps: ChainVerificationDeps,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<Observed, { kind: "failed" }>,
  runs: readonly RunRecord[],
  resolutionLog: ResourceDescriptor,
  signal: AbortSignal | undefined,
): Promise<ChainEnvironmentVerificationPredicate> {
  const reference = runs[0]!;
  const baselineDescriptor = await storeArtifact(
    deps,
    canonicalChainObservationBytes(reference.observation),
    { name: "observation", mediaType: "application/json" },
    signal,
  );
  for (const run of runs.slice(1).filter((one) => one.digest !== reference.digest)) {
    await storeArtifact(
      deps,
      canonicalChainObservationBytes(run.observation),
      { name: `observation-${run.instanceId}`, mediaType: "application/json" },
      signal,
    );
  }
  const allObservationsEqual = runs.every((run) => run.digest === reference.digest);
  return {
    ...buildArchiveFailurePredicate(deps, window, observed, resolutionLog),
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

function buildArchiveFailurePredicate(
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
      closureEvidenceMode: "fork-backend-refusal",
      resolutionLog,
    },
    cost: observed.context.cost,
    ...(observed.providers === undefined
      ? {}
      : { providers: providerObservations(observed.providers) }),
    failure: {
      stage: stageForFailureReason(observed.reason),
      reason: observed.reason,
      detail: observed.detail,
      ...(observed.partial === undefined ? {} : { coverage: observed.partial }),
    },
  } as ChainEnvironmentVerificationPredicate;
}
