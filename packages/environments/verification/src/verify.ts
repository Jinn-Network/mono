// SPDX-License-Identifier: Apache-2.0

import {
  environmentRecordDigest,
  sealEnvironmentRecord,
  type EnvironmentRecord,
} from "@jinn-network/environment-record";
import {
  DSSE_PAYLOAD_TYPE,
  recordDigest,
  sealSignedRecord,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { PrefixedSha256Schema, toDigestSet, type ResourceDescriptor } from "./digests.js";
import { conformanceFailure, invalidInput } from "./errors.js";
import { stageForFailureReason, type VerificationFailureReason } from "./failures.js";
import {
  DEFAULT_TIMEOUT_SECONDS,
  ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";
import {
  canonicalOutcomeSetBytes,
  outcomeSetDigest,
  outcomeSetsEqual,
  tallyOutcomeSet,
  type OutcomeSet,
} from "./outcome-set.js";
import type { ArtifactStore, ContainerRunResult, VerificationDeps } from "./ports.js";
import type {
  EnvironmentVerificationPredicate,
  RunObservation,
  VerificationControls,
} from "./predicate.js";
import {
  buildEnvironmentVerificationStatement,
  type EnvironmentVerificationStatement,
} from "./statement.js";

export type { VerificationDeps } from "./ports.js";

/**
 * The v1 profile's controls. Truthful by construction: `verifyEnvironment`
 * applies exactly these to every run request rather than merely declaring them.
 */
export const DEFAULT_VERIFICATION_CONTROLS: VerificationControls = Object.freeze({
  network: "none",
  seeds: Object.freeze({ PYTHONHASHSEED: "0" }),
  order: "default",
  parallelism: 1,
  locale: "C.UTF-8",
  tz: "UTC",
}) as VerificationControls;

export interface VerifyEnvironmentOptions {
  /** K. Defaults to, and may never be below, `MINIMUM_RUN_COUNT`. */
  readonly runCount?: number;
  readonly controls?: VerificationControls;
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface SealedAttestation {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  /** Identity of the sealed envelope. */
  readonly attestationDigest: Sha256Digest;
  readonly statement: EnvironmentVerificationStatement;
  /**
   * Container ids of the K runs, in run order. Not part of the signed payload:
   * a host-side check that each run got a fresh container.
   */
  readonly containerIds: readonly string[];
}

interface RunRecord {
  readonly outcomes: OutcomeSet;
  readonly digest: Sha256Digest;
  readonly observation: RunObservation;
  readonly containerId: string;
}

type Observation =
  | { readonly kind: "runs"; readonly runs: readonly RunRecord[] }
  | {
    readonly kind: "error";
    readonly reason: VerificationFailureReason;
    readonly detail?: string;
    readonly containerIds: readonly string[];
  };

function toRfc3339Utc(instant: Date): string {
  const milliseconds = instant.getTime();
  if (!Number.isFinite(milliseconds)) invalidInput("The injected clock returned an invalid Date.");
  return new Date(milliseconds).toISOString();
}

function controlsToEnv(controls: VerificationControls): Record<string, string> {
  return {
    ...controls.seeds,
    LC_ALL: controls.locale,
    LANG: controls.locale,
    TZ: controls.tz,
  };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function storeOutcomes(
  artifactStore: ArtifactStore,
  outcomes: OutcomeSet,
  signal: AbortSignal | undefined,
): Promise<ResourceDescriptor> {
  const bytes = canonicalOutcomeSetBytes(outcomes);
  const expected = recordDigest(bytes);
  const receipt = await artifactStore.putArtifact(
    bytes,
    signal === undefined ? undefined : { signal },
  );
  if (receipt.digest !== expected) {
    conformanceFailure(
      `Artifact store returned ${receipt.digest} for bytes digesting to ${expected}.`,
    );
  }
  return { name: "outcomes", mediaType: "application/json", digest: toDigestSet(expected) };
}

/**
 * Executes the v1 verification protocol (design §5.3) against `record` and
 * returns a DSSE-sealed in-toto Statement.
 *
 * The claim is bounded: `result: "stable"` means K consecutive runs of the
 * record's declared test scope produced identical outcome-sets under the
 * declared controls -- no more. Divergence (`unstable`) and infrastructure
 * failure (`error`) are signed and returned by the same call; this function
 * throws only for caller error (`INVALID_INPUT`) or a port that broke its
 * contract (`CONFORMANCE_FAILURE`), never for an environment fact.
 */
export async function verifyEnvironment(
  deps: VerificationDeps,
  record: EnvironmentRecord,
  options: VerifyEnvironmentOptions = {},
): Promise<SealedAttestation> {
  const runCount = options.runCount ?? MINIMUM_RUN_COUNT;
  if (!Number.isInteger(runCount) || runCount < MINIMUM_RUN_COUNT) {
    invalidInput(
      `The v1 profile requires at least ${MINIMUM_RUN_COUNT} runs; received ${String(options.runCount)}.`,
    );
  }
  const controls = options.controls ?? DEFAULT_VERIFICATION_CONTROLS;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  // Subject identity: re-seal the parsed record. Sealing is a pure JCS-once
  // function, so this reproduces the record's identity bytes -- provided the
  // caller parsed exact bytes, which C1's parser enforces.
  const recordBytes = sealEnvironmentRecord(record);
  const recordDigestValue = PrefixedSha256Schema.parse(
    environmentRecordDigest(recordBytes),
  ) as Sha256Digest;

  const startedAt = toRfc3339Utc(deps.clock.now());
  const observation = await observe(deps, record, {
    runCount,
    controls,
    timeoutSeconds,
    signal: options.signal,
  });
  const endedAt = toRfc3339Utc(deps.clock.now());

  const predicate = observation.kind === "error"
    ? buildErrorPredicate(deps, { startedAt, endedAt }, controls, timeoutSeconds, observation)
    : await buildRunsPredicate(
      deps,
      { startedAt, endedAt },
      controls,
      timeoutSeconds,
      observation.runs,
      options.signal,
    );

  const statement = buildEnvironmentVerificationStatement({
    recordDigest: recordDigestValue,
    imageManifestDigest: record.image.manifestDigest as Sha256Digest,
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
    containerIds: observation.kind === "error"
      ? observation.containerIds
      : observation.runs.map((run) => run.containerId),
  };
}

interface ObserveOptions {
  readonly runCount: number;
  readonly controls: VerificationControls;
  readonly timeoutSeconds: number;
  readonly signal: AbortSignal | undefined;
}

async function observe(
  deps: VerificationDeps,
  record: EnvironmentRecord,
  options: ObserveOptions,
): Promise<Observation> {
  const manifestDigest = record.image.manifestDigest as Sha256Digest;

  // Step 1: resolve and pull by digest. `reference` is advisory only.
  let pulled;
  try {
    pulled = await deps.containerRuntime.pullByDigest({
      manifestDigest,
      platform: record.image.platform,
      ...(record.image.reference === undefined ? {} : { reference: record.image.reference }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    return {
      kind: "error",
      reason: "image-unresolvable",
      detail: describeCause(cause),
      containerIds: [],
    };
  }
  if (pulled.resolvedManifestDigest !== manifestDigest) {
    return {
      kind: "error",
      reason: "image-digest-mismatch",
      detail: `registry resolved ${pulled.resolvedManifestDigest}`,
      containerIds: [],
    };
  }

  // Steps 2-4: K runs, each in a fresh container from the same image, install
  // commands first (Findings F-C2-2), outcomes parsed by the pinned parser.
  const env = controlsToEnv(options.controls);
  const runs: RunRecord[] = [];
  const containerIds: string[] = [];
  for (let index = 0; index < options.runCount; index += 1) {
    let result: ContainerRunResult;
    try {
      result = await deps.containerRuntime.runContainer({
        manifestDigest,
        platform: record.image.platform,
        workspace: record.workspace,
        installCommands: record.invocations.install ?? [],
        testCommands: record.invocations.test,
        parser: record.parser,
        env,
        network: "none",
        timeoutSeconds: options.timeoutSeconds,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      return {
        kind: "error",
        reason: "run-command-failed",
        detail: `run ${index}: ${describeCause(cause)}`,
        containerIds,
      };
    }
    containerIds.push(result.containerId);

    if (result.timedOut) {
      return {
        kind: "error",
        reason: "runtime-timeout",
        detail: `run ${index} exceeded ${options.timeoutSeconds}s`,
        containerIds,
      };
    }
    const failedInstall = result.installExitCodes.findIndex((code) => code !== 0);
    if (failedInstall >= 0) {
      return {
        kind: "error",
        reason: "install-command-failed",
        detail: `run ${index}: install command ${failedInstall} exited ${result.installExitCodes[failedInstall]}`,
        containerIds,
      };
    }
    // A non-zero *test* exit code is not a failure: expected-fail baselines are
    // first-class (design §5.2). Only an empty outcome set is a protocol error.
    if (Object.keys(result.outcomes).length === 0) {
      return {
        kind: "error",
        reason: "parser-produced-no-outcomes",
        detail: `run ${index} produced no parsed outcomes`,
        containerIds,
      };
    }

    runs.push({
      outcomes: result.outcomes,
      digest: outcomeSetDigest(result.outcomes),
      observation: {
        outcomeSetDigest: outcomeSetDigest(result.outcomes),
        wallSeconds: result.wallSeconds,
      },
      containerId: result.containerId,
    });
  }

  return { kind: "runs", runs };
}

function buildErrorPredicate(
  deps: VerificationDeps,
  window: { startedAt: string; endedAt: string },
  controls: VerificationControls,
  timeoutSeconds: number,
  observation: Extract<Observation, { kind: "error" }>,
): EnvironmentVerificationPredicate {
  return {
    protocol: ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    result: "error",
    window,
    controls,
    runtime: { timeoutSeconds },
    verifier: deps.verifier,
    failure: {
      stage: stageForFailureReason(observation.reason),
      reason: observation.reason,
      ...(observation.detail === undefined ? {} : { detail: observation.detail }),
    },
  } as EnvironmentVerificationPredicate;
}

async function buildRunsPredicate(
  deps: VerificationDeps,
  window: { startedAt: string; endedAt: string },
  controls: VerificationControls,
  timeoutSeconds: number,
  runs: readonly RunRecord[],
  signal: AbortSignal | undefined,
): Promise<EnvironmentVerificationPredicate> {
  const reference = runs[0]!;
  // Step 5: compare. Set equality over (test id -> status); timing never enters.
  const divergent = runs
    .map((run, index) => ({ run, index }))
    .filter(({ run }) => !outcomeSetsEqual(run.outcomes, reference.outcomes));

  const baselineDescriptor = await storeOutcomes(deps.artifactStore, reference.outcomes, signal);
  const tally = tallyOutcomeSet(reference.outcomes);
  const wallSeconds = runs.map((run) => run.observation.wallSeconds);
  const base = {
    protocol: ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    window,
    runs: {
      count: runs.length,
      outcomeSetDigest: reference.digest,
      perRun: runs.map((run) => run.observation),
    },
    baseline: { ...tally, outcomes: baselineDescriptor },
    controls,
    runtime: {
      minSeconds: Math.min(...wallSeconds),
      maxSeconds: Math.max(...wallSeconds),
      timeoutSeconds,
    },
    verifier: deps.verifier,
  };

  if (divergent.length === 0) {
    return { ...base, result: "stable" } as EnvironmentVerificationPredicate;
  }

  const divergentRuns = [];
  for (const { run, index } of divergent) {
    divergentRuns.push({
      index,
      outcomeSetDigest: run.digest,
      outcomes: await storeOutcomes(deps.artifactStore, run.outcomes, signal),
    });
  }
  return {
    ...base,
    result: "unstable",
    failure: {
      stage: "compare",
      reason: "outcome-set-divergence",
      detail: `${divergentRuns.length} of ${runs.length} runs diverged from run 0`,
      divergence: {
        referenceRunIndex: 0,
        referenceOutcomeSetDigest: reference.digest,
        divergentRuns,
      },
    },
  } as EnvironmentVerificationPredicate;
}
