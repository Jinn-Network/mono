// SPDX-License-Identifier: Apache-2.0

import {
  parseChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
  cryptoEnvironmentRecordDigest,
  type ChainEnvironmentRecord,
  type ChainInstance,
  type CryptoEnvironmentRecord,
  type NetworkPolicy,
  type VerifiedChainInstance,
} from "@jinn-network/chain-environment-record";
import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  DSSE_PAYLOAD_TYPE,
  recordDigest,
  sealSignedRecord,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { assessClosure } from "./closure.js";
import { PrefixedSha256Schema, fromDigestSet, toDigestSet, type DigestSet, type ResourceDescriptor } from "./digests.js";
import { conformanceFailure, invalidInput } from "./errors.js";
import {
  CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  COMPOSITE_OBSERVATION_SCHEMA_ID,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";
import {
  buildEnvironmentObservation,
  declaredFixtureAccounts,
} from "./instance-checks.js";
import {
  buildCanonicalChainObservation,
  buildCompositeObservation,
  compositeObservationBytes,
  compositeObservationDigest,
  type CanonicalChainObservation,
  type CompositeObservation,
  type InformationPlaneObservation,
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
  CompositionEvidence,
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
  buildCryptoEnvironmentVerificationStatement,
  type ChainEnvironmentVerificationStatement,
} from "./statement.js";
import type { SealedAttestation, VerifyChainEnvironmentOptions } from "./verify.js";

export type { SealedAttestation } from "./verify.js";

export interface RoutingEntry {
  readonly origin: string;
  readonly world: string;
  readonly precedence: number;
}

export interface RoutingCollision {
  readonly origin: string;
  readonly worlds: readonly string[];
}

/**
 * Design §4.4: two corpora claiming `api.llama.fi` is a reproducibility hazard, not a merge.
 * Declared precedence resolves it -- the higher-precedence world answers -- so a collision is
 * exactly the case where two or more worlds claim one origin at the same precedence and
 * nothing in the record says which one wins.
 */
export function assessOriginRouting(
  routing: readonly RoutingEntry[],
): readonly RoutingCollision[] {
  const byOriginAndPrecedence = new Map<string, Map<number, Set<string>>>();
  for (const entry of routing) {
    const byPrecedence = byOriginAndPrecedence.get(entry.origin) ?? new Map<number, Set<string>>();
    const worlds = byPrecedence.get(entry.precedence) ?? new Set<string>();
    worlds.add(entry.world);
    byPrecedence.set(entry.precedence, worlds);
    byOriginAndPrecedence.set(entry.origin, byPrecedence);
  }

  const collisions: RoutingCollision[] = [];
  for (const [origin, byPrecedence] of byOriginAndPrecedence) {
    for (const worlds of byPrecedence.values()) {
      if (worlds.size > 1) {
        collisions.push({ origin, worlds: [...worlds].sort(compareCodeUnitStrings) });
      }
    }
  }
  return collisions.sort((left, right) => compareCodeUnitStrings(left.origin, right.origin));
}

export interface VerifyCryptoEnvironmentOptions extends VerifyChainEnvironmentOptions {
  /** Component attestations the caller already holds, by component record digest. Recorded in
   * the composition block; never treated as a substitute for obtaining them. */
  readonly componentAttestations?: ReadonlyMap<string, `sha256:${string}`>;
}

interface CompositeRunRecord {
  readonly instanceId: string;
  readonly observation: CompositeObservation;
  readonly digest: Sha256Digest;
  readonly wallSeconds: number;
}

interface CompositeObservationContext {
  readonly resolved: readonly ResolvedResource[];
  readonly environment: EnvironmentObservation;
  readonly isolation: Omit<IsolationEvidence, "closureEvidenceMode" | "resolutionLog">;
  readonly closure: ReturnType<typeof assessClosure>;
  readonly cost: { artifactBytes: number; artifactCount: number; wallSeconds: number };
  readonly routing: readonly RoutingEntry[];
  readonly collisions: readonly RoutingCollision[];
  readonly wholeWorldOfflineBoot: boolean;
  readonly requestBudgetEnforced: boolean;
}

type CompositeObserved =
  | {
    readonly kind: "runs";
    readonly runs: readonly CompositeRunRecord[];
    readonly context: CompositeObservationContext;
  }
  | {
    readonly kind: "failed";
    readonly reason: ChainVerificationFailureReason;
    readonly detail: string;
    readonly context: CompositeObservationContext;
    readonly divergence?: FailureBlock["divergence"];
    readonly completedRuns?: readonly CompositeRunRecord[];
    readonly instanceIds: readonly string[];
    readonly observations: readonly CompositeObservation[];
  };

interface ObserveCompositeOptions {
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

function embeddedRecordSha256(
  digest: { readonly sha256?: string } | undefined,
): string {
  if (digest?.sha256 === undefined) {
    invalidInput("embedded record digest is missing");
  }
  return digest.sha256;
}

function embeddedRecordDigest(
  digest: { readonly sha256?: string } | undefined,
): Sha256Digest {
  return asPrefixedDigest(`sha256:${embeddedRecordSha256(digest)}`);
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

function compositeRecordDigest(composite: CryptoEnvironmentRecord): Sha256Digest {
  try {
    return PrefixedSha256Schema.parse(
      cryptoEnvironmentRecordDigest(sealCryptoEnvironmentRecord(composite)),
    ) as Sha256Digest;
  } catch {
    return recordDigest(canonicalJsonBytes(composite));
  }
}

function mapOriginRouting(composite: CryptoEnvironmentRecord): readonly RoutingEntry[] {
  const worldById = new Map(
    composite.informationWorlds.map((world) => [
      world.id,
      embeddedRecordDigest(world.record.digest),
    ]),
  );
  return composite.composition.originRouting.map((route) => {
    const world = worldById.get(route.worldId);
    if (world === undefined) {
      invalidInput(`composition.originRouting references unknown worldId ${route.worldId}`);
    }
    return { origin: route.origin, world, precedence: route.precedence };
  });
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

function componentResolutionRequests(
  composite: CryptoEnvironmentRecord,
): readonly ResolutionRequest[] {
  const requests: ResolutionRequest[] = [{
    name: "chain-world-record",
    descriptor: prefixedDescriptor(
      composite.chainWorld.record.name ?? "chain-world",
      embeddedRecordDigest(composite.chainWorld.record.digest),
    ),
  }];
  for (const world of composite.informationWorlds) {
    requests.push({
      name: `information-world-${world.id}`,
      descriptor: prefixedDescriptor(
        world.record.name ?? world.id,
        embeddedRecordDigest(world.record.digest),
      ),
    });
  }
  for (const runtime of composite.serviceRuntimes) {
    requests.push({
      name: `service-runtime-${runtime.id}`,
      descriptor: prefixedDescriptor(
        runtime.id,
        asPrefixedDigest(runtime.image.manifestDigest),
      ),
    });
  }
  return requests;
}

function emptyInformationPlane(
  composite: CryptoEnvironmentRecord,
  enforced: boolean,
): InformationPlaneObservation {
  return {
    worlds: [],
    budget: {
      requests: composite.composition.requestBudget.maxRequests,
      bytes: composite.composition.requestBudget.maxResponseBytes,
      enforced,
    },
  };
}

function boundaryProbeFrom(
  observation: CanonicalChainObservation,
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

function minimalEnvironmentObservation(): EnvironmentObservation {
  return {
    closureClass: "closed-state",
    fidelityClass: "local",
    runtime: {
      family: "anvil",
      version: "0.0.0",
      imageManifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      platform: "linux/amd64",
      binaryDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      reportedVersion: "anvil",
      evmConfigurationDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      chainId: 0,
    },
    postFixtureCommitment: `0x${"0".repeat(64)}`,
    controls: { miningMode: "manual" },
    envelope: {
      rpcAllowlist: { read: [], stateChanging: [] },
      signerRoles: [],
      permittedChainId: 0,
      maxima: {
        maxTransactions: "0",
        maxAggregateGas: "0",
        maxExecutionDurationMs: "0",
      },
      egressPolicyId: "blackhole/1.0",
    },
  };
}

function emptyCompositeContext(
  composite: CryptoEnvironmentRecord,
  routing: readonly RoutingEntry[],
  collisions: readonly RoutingCollision[],
  options: ObserveCompositeOptions,
): CompositeObservationContext {
  return {
    resolved: [],
    environment: minimalEnvironmentObservation(),
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
        declaredRoles: [],
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
    cost: { artifactBytes: 0, artifactCount: 0, wallSeconds: 0 },
    routing,
    collisions,
    wholeWorldOfflineBoot: true,
    requestBudgetEnforced: composite.informationWorlds.length === 0,
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

function buildCompositionEvidence(
  composite: CryptoEnvironmentRecord,
  routing: readonly RoutingEntry[],
  collisions: readonly RoutingCollision[],
  chainWorldDigest: Sha256Digest,
  wholeWorldOfflineBoot: boolean,
  requestBudgetEnforced: boolean,
  componentAttestations?: ReadonlyMap<string, `sha256:${string}`>,
): CompositionEvidence {
  const attestationFor = (digest: Sha256Digest): `sha256:${string}` | undefined =>
    componentAttestations?.get(digest);

  const components: CompositionEvidence["components"] = [{
    role: "chain-world",
    record: chainWorldDigest,
    ...(attestationFor(chainWorldDigest) === undefined
      ? {}
      : { attestation: attestationFor(chainWorldDigest) }),
  }];
  for (const world of composite.informationWorlds) {
    const digest = embeddedRecordDigest(world.record.digest);
    components.push({
      role: "information-world",
      record: digest,
      ...(attestationFor(digest) === undefined ? {} : { attestation: attestationFor(digest) }),
    });
  }
  for (const runtime of composite.serviceRuntimes) {
    const digest = asPrefixedDigest(runtime.image.manifestDigest);
    components.push({
      role: "service-runtime",
      record: digest,
      ...(attestationFor(digest) === undefined ? {} : { attestation: attestationFor(digest) }),
    });
  }

  return {
    routing: routing.map((entry) => ({
      origin: entry.origin,
      world: asPrefixedDigest(entry.world),
      precedence: entry.precedence,
    })),
    collisions: collisions.map((collision) => ({
      origin: collision.origin,
      worlds: collision.worlds.map((world) => asPrefixedDigest(world)),
    })),
    missPolicy: "declared-miss-response",
    allowlistedOrigins: [...composite.composition.endpointAllowlist],
    requestBudget: {
      requests: composite.composition.requestBudget.maxRequests,
      bytes: composite.composition.requestBudget.maxResponseBytes,
      enforced: requestBudgetEnforced,
    },
    components,
    wholeWorldOfflineBoot,
  };
}

function mergeResolution(
  left: Extract<ResolutionResult, { ok: true }>,
  right: Extract<ResolutionResult, { ok: true }>,
): Extract<ResolutionResult, { ok: true }> {
  const bytes = new Map(left.bytes);
  for (const [digest, value] of right.bytes) {
    bytes.set(digest, value);
  }
  return {
    ok: true,
    resolved: [...left.resolved, ...right.resolved],
    bytes,
  };
}

async function observeComposite(
  deps: ChainVerificationDeps,
  composite: CryptoEnvironmentRecord,
  chainRecord: ChainEnvironmentRecord,
  routing: readonly RoutingEntry[],
  collisions: readonly RoutingCollision[],
  options: ObserveCompositeOptions,
): Promise<CompositeObserved> {
  const componentResolution = await resolveMaterials(
    deps.artifactStore,
    componentResolutionRequests(composite),
    options.signal,
  );
  if (!componentResolution.ok) {
    return failEarly(componentResolution, routing, collisions, options);
  }

  const chainResolution = await resolveMaterials(
    deps.artifactStore,
    materialRequests(chainRecord),
    options.signal,
  );
  if (!chainResolution.ok) {
    return failEarly(chainResolution, routing, collisions, options, componentResolution.resolved);
  }

  const resolution = mergeResolution(componentResolution, chainResolution);

  const runs: CompositeRunRecord[] = [];
  const instanceIds: string[] = [];
  const observations: CompositeObservation[] = [];
  let identity: VerifiedChainInstance | undefined;
  let egressAttempts: IsolationEvidence["egressAttempts"] = [];
  let forbiddenProbes: IsolationEvidence["forbiddenProbes"] = [];
  let signerScope: IsolationEvidence["signerScope"] = {
    declaredRoles: chainRecord.capabilityEnvelope.signerRoles.map((role) => role.role),
    exposedAccounts: [],
    unexpectedAccounts: [],
  };
  let loadedResources: string[] = [];
  let wholeWorldOfflineBoot = true;
  let requestBudgetEnforced = composite.informationWorlds.length === 0;
  let wallSeconds = 0;

  for (let index = 0; index < options.runCount; index += 1) {
    const instanceId = `${options.instanceIdPrefix}-run-${index}`;
    let instance: ChainInstance;
    try {
      instance = await deps.runtime.materializer.materialize({
        record: chainRecord,
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
    const verified = instance as VerifiedChainInstance;
    identity ??= verified;
    egressAttempts = [...egressAttempts, ...verified.report.isolation.egressAttempts];
    loadedResources = [...loadedResources, ...verified.report.loadedResources];
    wallSeconds += verified.report.cost.wallSeconds;

    if (verified.report.isolation.egressAttempts.some((attempt) => attempt.outcome === "succeeded")) {
      wholeWorldOfflineBoot = false;
    }

    try {
      forbiddenProbes = verified.report.isolation.forbiddenProbes
        .map((probe) => ({ ...probe, passed: probe.observedClass === probe.expectedClass }));
      const unexpectedAccounts = verified.report.isolation.exposedSignerAccounts
        .filter((account) => !declaredFixtureAccounts(chainRecord).includes(account));
      signerScope = {
        declaredRoles: chainRecord.capabilityEnvelope.signerRoles.map((role) => role.role),
        exposedAccounts: [...verified.report.isolation.exposedSignerAccounts],
        unexpectedAccounts,
      };

      let probeResult;
      try {
        const probeSuiteBytes = resolution.bytes.get(
          fromDigestSet(asDigestSet(chainRecord.verificationContract.probeSuite.descriptor.digest)),
        );
        const comparatorBytes = resolution.bytes.get(
          asPrefixedDigest(chainRecord.verificationContract.comparator.digest),
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

      const chainObservation = buildCanonicalChainObservation(probeResult.observation);
      let informationObservation = emptyInformationPlane(composite, requestBudgetEnforced);
      if (composite.informationWorlds.length > 0) {
        if (deps.informationRuntime === undefined) {
          return fail("information-runtime-absent", "information worlds require informationRuntime");
        }
        const worldBytes = composite.informationWorlds.map((world) => {
          const digest = embeddedRecordDigest(world.record.digest);
          const bytes = resolution.bytes.get(digest);
          if (bytes === undefined) {
            conformanceFailure(`information world ${world.id} bytes missing from resolution`);
          }
          return bytes;
        });
        const serveResult = await deps.informationRuntime.serve({
          instance,
          worldRecords: worldBytes,
          corpora: new Map(),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (serveResult.egressAttempts.length > 0) {
          wholeWorldOfflineBoot = false;
        }
        informationObservation = buildCompositeObservation({
          schema: COMPOSITE_OBSERVATION_SCHEMA_ID,
          chain: chainObservation,
          information: serveResult.observation,
        }).information;
        requestBudgetEnforced = informationObservation.budget.enforced;
      }

      const compositeObservation = buildCompositeObservation({
        schema: COMPOSITE_OBSERVATION_SCHEMA_ID,
        chain: chainObservation,
        information: informationObservation,
      });
      observations.push(compositeObservation);
      runs.push({
        instanceId: instance.instanceId,
        observation: compositeObservation,
        digest: compositeObservationDigest(compositeObservation),
        wallSeconds: probeResult.cost.wallSeconds,
      });
      wallSeconds += probeResult.cost.wallSeconds;
    } finally {
      await instance.stop();
    }
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
      ? { boundaryProbe: boundaryProbeFrom(reference.observation.chain) }
      : {}),
    resolvedDigests: resolution.resolved.map((one) => one.digest),
    loadedResources,
    observationsEqual,
  });

  const context: CompositeObservationContext = {
    resolved: resolution.resolved,
    environment: buildEnvironmentObservation(chainRecord, identity, undefined),
    isolation: {
      networkPolicy: options.networkPolicy,
      ...(options.networkPolicy.forkBackend === "absent"
        ? { boundaryProbe: boundaryProbeFrom(reference.observation.chain) }
        : {}),
      egressAttempts,
      forbiddenProbes,
      signerScope,
    },
    closure,
    cost: {
      artifactBytes: resolution.resolved.reduce((total, one) => total + one.size, 0),
      artifactCount: resolution.resolved.length,
      wallSeconds,
    },
    routing,
    collisions,
    wholeWorldOfflineBoot,
    requestBudgetEnforced,
  };

  if (!wholeWorldOfflineBoot) {
    return {
      kind: "failed",
      reason: "egress-succeeded",
      detail: "a component required network during whole-world offline boot",
      context: { ...context, wholeWorldOfflineBoot: false },
      instanceIds,
      observations,
    };
  }

  if (collisions.length > 0) {
    return {
      kind: "failed",
      reason: "origin-routing-collision",
      detail: `${collisions.length} origin routing collision(s)`,
      context,
      instanceIds,
      observations,
    };
  }

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

  function failEarly(
    resolutionFailure: Extract<ResolutionResult, { ok: false }>,
    routingEntries: readonly RoutingEntry[],
    collisionList: readonly RoutingCollision[],
    observeOptions: ObserveCompositeOptions,
    resolved: readonly ResolvedResource[] = resolutionFailure.resolved,
  ): CompositeObserved {
    return {
      kind: "failed",
      reason: resolutionFailure.reason,
      detail: resolutionFailure.detail,
      context: {
        ...emptyCompositeContext(composite, routingEntries, collisionList, observeOptions),
        resolved,
        cost: {
          artifactBytes: resolved.reduce((total, one) => total + one.size, 0),
          artifactCount: resolved.length,
          wallSeconds: 0,
        },
      },
      instanceIds: [],
      observations: [],
    };
  }

  function fail(
    reason: ChainVerificationFailureReason,
    detail: string,
    completedRuns?: readonly CompositeRunRecord[],
  ): CompositeObserved {
    const latestObservation = observations[observations.length - 1];
    const sealed = options.networkPolicy.forkBackend === "absent";
    return {
      kind: "failed",
      reason,
      detail,
      ...(completedRuns === undefined ? {} : { completedRuns }),
      context: {
        resolved: resolution.resolved,
        environment: buildEnvironmentObservation(chainRecord, identity, undefined),
        isolation: {
          networkPolicy: options.networkPolicy,
          ...(sealed
            ? {
              boundaryProbe: latestObservation === undefined
                ? { probeId: "out-of-slice-read", readsEmptyOutsideSlice: false }
                : boundaryProbeFrom(latestObservation.chain),
            }
            : {}),
          egressAttempts,
          forbiddenProbes,
          signerScope,
        },
        closure: {
          mode: options.networkPolicy.forkBackend === "present"
            ? "fork-backend-refusal"
            : "sealed-boundary",
          closed: false,
          evidence: [],
        },
        cost: {
          artifactBytes: resolution.resolved.reduce((total, one) => total + one.size, 0),
          artifactCount: resolution.resolved.length,
          wallSeconds,
        },
        routing,
        collisions,
        wholeWorldOfflineBoot,
        requestBudgetEnforced,
      },
      instanceIds,
      observations,
    };
  }
}

async function buildCompositeRunsPredicate(
  deps: ChainVerificationDeps,
  composite: CryptoEnvironmentRecord,
  chainWorldDigest: Sha256Digest,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<CompositeObserved, { kind: "runs" }>,
  resolutionLog: ResourceDescriptor,
  componentAttestations: ReadonlyMap<string, `sha256:${string}`> | undefined,
  signal: AbortSignal | undefined,
): Promise<ChainEnvironmentVerificationPredicate> {
  const reference = observed.runs[0]!;
  const baselineDescriptor = await storeArtifact(
    deps.artifactStore,
    compositeObservationBytes(reference.observation),
    { name: "observation", mediaType: "application/json" },
    signal,
  );
  return {
    protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    scope: "composite",
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
    composition: buildCompositionEvidence(
      composite,
      observed.context.routing,
      observed.context.collisions,
      chainWorldDigest,
      observed.context.wholeWorldOfflineBoot,
      observed.context.requestBudgetEnforced,
      componentAttestations,
    ),
  } as ChainEnvironmentVerificationPredicate;
}

async function buildCompositeDivergencePredicate(
  deps: ChainVerificationDeps,
  composite: CryptoEnvironmentRecord,
  chainWorldDigest: Sha256Digest,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<CompositeObserved, { kind: "failed" }>,
  runs: readonly CompositeRunRecord[],
  resolutionLog: ResourceDescriptor,
  componentAttestations: ReadonlyMap<string, `sha256:${string}`> | undefined,
  signal: AbortSignal | undefined,
): Promise<ChainEnvironmentVerificationPredicate> {
  const reference = runs[0]!;
  const baselineDescriptor = await storeArtifact(
    deps.artifactStore,
    compositeObservationBytes(reference.observation),
    { name: "observation", mediaType: "application/json" },
    signal,
  );
  for (const run of runs.slice(1).filter((one) => one.digest !== reference.digest)) {
    await storeArtifact(
      deps.artifactStore,
      compositeObservationBytes(run.observation),
      { name: `observation-${run.instanceId}`, mediaType: "application/json" },
      signal,
    );
  }
  const allObservationsEqual = runs.every((run) => run.digest === reference.digest);
  return {
    ...buildCompositeFailurePredicate(
      composite,
      chainWorldDigest,
      window,
      observed,
      resolutionLog,
      deps.verifier,
      componentAttestations,
    ),
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

function buildCompositeFailurePredicate(
  composite: CryptoEnvironmentRecord,
  chainWorldDigest: Sha256Digest,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<CompositeObserved, { kind: "failed" }>,
  resolutionLog: ResourceDescriptor,
  verifier: ChainVerificationDeps["verifier"],
  componentAttestations: ReadonlyMap<string, `sha256:${string}`> | undefined,
): ChainEnvironmentVerificationPredicate {
  return {
    protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    scope: "composite",
    outcome: outcomeForFailureReason(observed.reason),
    window,
    verifier,
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
    composition: buildCompositionEvidence(
      composite,
      observed.context.routing,
      observed.context.collisions,
      chainWorldDigest,
      observed.context.wholeWorldOfflineBoot,
      observed.context.requestBudgetEnforced,
      componentAttestations,
    ),
    failure: {
      stage: stageForFailureReason(observed.reason),
      reason: observed.reason,
      detail: observed.detail,
      ...(observed.divergence === undefined ? {} : { divergence: observed.divergence }),
    },
  } as ChainEnvironmentVerificationPredicate;
}

export async function verifyCryptoEnvironment(
  deps: ChainVerificationDeps,
  composite: CryptoEnvironmentRecord,
  options: VerifyCryptoEnvironmentOptions = {},
): Promise<SealedAttestation> {
  const runCount = options.runCount ?? MINIMUM_RUN_COUNT;
  if (!Number.isInteger(runCount) || runCount < MINIMUM_RUN_COUNT) {
    invalidInput(
      `This profile requires at least ${MINIMUM_RUN_COUNT} fresh materializations; received ${String(options.runCount)}.`,
    );
  }

  const compositeDigestValue = compositeRecordDigest(composite);
  const chainWorldDigest = embeddedRecordDigest(composite.chainWorld.record.digest);
  const routing = mapOriginRouting(composite);
  const collisions = assessOriginRouting(routing);

  const componentResolution = await resolveMaterials(
    deps.artifactStore,
    componentResolutionRequests(composite),
    options.signal,
  );
  if (!componentResolution.ok) {
    const startedAt = toRfc3339Utc(deps.clock.now());
    const observed: Extract<CompositeObserved, { kind: "failed" }> = {
      kind: "failed",
      reason: componentResolution.reason,
      detail: componentResolution.detail,
      context: {
        ...emptyCompositeContext(composite, routing, collisions, {
          runCount,
          networkPolicy: options.networkPolicy ?? DEFAULT_BLACKHOLE_POLICY,
          probeTimeoutSeconds: options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS,
          instanceIdPrefix: compositeDigestValue.slice("sha256:".length, 16),
          signal: options.signal,
        }),
        resolved: componentResolution.resolved,
        cost: {
          artifactBytes: componentResolution.resolved.reduce((total, one) => total + one.size, 0),
          artifactCount: componentResolution.resolved.length,
          wallSeconds: 0,
        },
      },
      instanceIds: [],
      observations: [],
    };
    const endedAt = toRfc3339Utc(deps.clock.now());
    const resolutionLog = await storeArtifact(
      deps.artifactStore,
      canonicalResolutionLogBytes(observed.context.resolved),
      { name: "resolution-log", mediaType: "application/json" },
      options.signal,
    );
    const predicate = buildCompositeFailurePredicate(
      composite,
      chainWorldDigest,
      { startedAt, endedAt },
      observed,
      resolutionLog,
      deps.verifier,
      options.componentAttestations,
    );
    const statement = buildCryptoEnvironmentVerificationStatement({
      compositeDigest: compositeDigestValue,
      chainWorldDigest,
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
      instanceIds: [],
      observations: [],
    };
  }

  const chainBytes = componentResolution.bytes.get(chainWorldDigest);
  if (chainBytes === undefined) {
    conformanceFailure("Resolved chain world record bytes are missing from the resolution map.");
  }
  const chainRecord = parseChainEnvironmentRecord(chainBytes);

  if (collisions.length > 0) {
    const startedAt = toRfc3339Utc(deps.clock.now());
    const observed: Extract<CompositeObserved, { kind: "failed" }> = {
      kind: "failed",
      reason: "origin-routing-collision",
      detail: `${collisions.length} origin routing collision(s)`,
      context: {
        resolved: componentResolution.resolved,
        environment: buildEnvironmentObservation(chainRecord, undefined, undefined),
        isolation: {
          networkPolicy: options.networkPolicy ?? DEFAULT_BLACKHOLE_POLICY,
          boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: false },
          egressAttempts: [],
          forbiddenProbes: [],
          signerScope: {
            declaredRoles: chainRecord.capabilityEnvelope.signerRoles.map((role) => role.role),
            exposedAccounts: [],
            unexpectedAccounts: [],
          },
        },
        closure: {
          mode: "sealed-boundary",
          closed: false,
          evidence: [],
        },
        cost: {
          artifactBytes: componentResolution.resolved.reduce((total, one) => total + one.size, 0),
          artifactCount: componentResolution.resolved.length,
          wallSeconds: 0,
        },
        routing,
        collisions,
        wholeWorldOfflineBoot: true,
        requestBudgetEnforced: composite.informationWorlds.length === 0,
      },
      instanceIds: [],
      observations: [],
    };
    const endedAt = toRfc3339Utc(deps.clock.now());
    const resolutionLog = await storeArtifact(
      deps.artifactStore,
      canonicalResolutionLogBytes(observed.context.resolved),
      { name: "resolution-log", mediaType: "application/json" },
      options.signal,
    );
    const predicate = buildCompositeFailurePredicate(
      composite,
      chainWorldDigest,
      { startedAt, endedAt },
      observed,
      resolutionLog,
      deps.verifier,
      options.componentAttestations,
    );
    const statement = buildCryptoEnvironmentVerificationStatement({
      compositeDigest: compositeDigestValue,
      chainWorldDigest,
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
      instanceIds: [],
      observations: [],
    };
  }

  if (composite.informationWorlds.length > 0 && deps.informationRuntime === undefined) {
    const startedAt = toRfc3339Utc(deps.clock.now());
    const observed: Extract<CompositeObserved, { kind: "failed" }> = {
      kind: "failed",
      reason: "information-runtime-absent",
      detail: "information worlds require informationRuntime",
      context: {
        resolved: componentResolution.resolved,
        environment: buildEnvironmentObservation(chainRecord, undefined, undefined),
        isolation: {
          networkPolicy: options.networkPolicy ?? DEFAULT_BLACKHOLE_POLICY,
          boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: false },
          egressAttempts: [],
          forbiddenProbes: [],
          signerScope: {
            declaredRoles: chainRecord.capabilityEnvelope.signerRoles.map((role) => role.role),
            exposedAccounts: [],
            unexpectedAccounts: [],
          },
        },
        closure: {
          mode: "sealed-boundary",
          closed: false,
          evidence: [],
        },
        cost: {
          artifactBytes: componentResolution.resolved.reduce((total, one) => total + one.size, 0),
          artifactCount: componentResolution.resolved.length,
          wallSeconds: 0,
        },
        routing,
        collisions,
        wholeWorldOfflineBoot: true,
        requestBudgetEnforced: false,
      },
      instanceIds: [],
      observations: [],
    };
    const endedAt = toRfc3339Utc(deps.clock.now());
    const resolutionLog = await storeArtifact(
      deps.artifactStore,
      canonicalResolutionLogBytes(observed.context.resolved),
      { name: "resolution-log", mediaType: "application/json" },
      options.signal,
    );
    const predicate = buildCompositeFailurePredicate(
      composite,
      chainWorldDigest,
      { startedAt, endedAt },
      observed,
      resolutionLog,
      deps.verifier,
      options.componentAttestations,
    );
    const statement = buildCryptoEnvironmentVerificationStatement({
      compositeDigest: compositeDigestValue,
      chainWorldDigest,
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
      instanceIds: [],
      observations: [],
    };
  }

  const startedAt = toRfc3339Utc(deps.clock.now());
  const observed = await observeComposite(
    deps,
    composite,
    chainRecord,
    routing,
    collisions,
    {
      runCount,
      networkPolicy: options.networkPolicy ?? DEFAULT_BLACKHOLE_POLICY,
      probeTimeoutSeconds: options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS,
      instanceIdPrefix: options.instanceIdPrefix ?? compositeDigestValue.slice("sha256:".length, 16),
      signal: options.signal,
    },
  );
  const endedAt = toRfc3339Utc(deps.clock.now());

  const resolutionLog = await storeArtifact(
    deps.artifactStore,
    canonicalResolutionLogBytes(observed.context.resolved),
    { name: "resolution-log", mediaType: "application/json" },
    options.signal,
  );

  const predicate = observed.kind === "runs"
    ? await buildCompositeRunsPredicate(
      deps,
      composite,
      chainWorldDigest,
      { startedAt, endedAt },
      observed,
      resolutionLog,
      options.componentAttestations,
      options.signal,
    )
    : observed.completedRuns !== undefined
      && isRunBearingOutcome(outcomeForFailureReason(observed.reason))
      ? await buildCompositeDivergencePredicate(
        deps,
        composite,
        chainWorldDigest,
        { startedAt, endedAt },
        observed,
        observed.completedRuns,
        resolutionLog,
        options.componentAttestations,
        options.signal,
      )
      : buildCompositeFailurePredicate(
        composite,
        chainWorldDigest,
        { startedAt, endedAt },
        observed,
        resolutionLog,
        deps.verifier,
        options.componentAttestations,
      );

  const statement = buildCryptoEnvironmentVerificationStatement({
    compositeDigest: compositeDigestValue,
    chainWorldDigest,
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
      ? observed.runs.map((run) => run.observation.chain)
      : observed.observations.map((observation) => observation.chain),
  };
}
