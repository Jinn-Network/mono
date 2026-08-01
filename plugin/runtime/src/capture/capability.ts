// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  LocalEvidenceIndexingOutcome,
  LocalEvidenceRuntime,
} from "@jinn-network/evidence-local-runtime";
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import {
  TRAJECTORY_VOCABULARY_PROFILE,
  buildTrajectoryDerivationStatement,
  documentDigest,
  sealTrajectoryDerivationAttestation,
} from "@jinn-network/evidence-trajectory";
import {
  type CaptureDiagnostic,
  type ExecutionId,
  createExecutionRecorder,
} from "@jinn-network/execution-recorder";
import type { DsseSigner } from "@jinn-network/trust-core";

import type { CapabilityContext, RuntimeCapability } from "../capability.js";
import type { RuntimeConfig } from "../config.js";
import { PluginRuntimeError } from "../errors.js";
import type { HealthCheck } from "../health.js";
import type { RuntimeLogger } from "../logger.js";
import {
  type CaptureAssemblyInput,
  buildFinalizeInput,
  buildStartInput,
  resolveSessionOutcome,
} from "./assemble.js";
import { withCaptureArchive } from "./archive.js";
import { parseSessionFeed } from "./feed.js";
import {
  PRODUCER_IRI,
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  TRAJECTORY_BUILDER_ID,
  TRAJECTORY_BUILDER_VERSION,
} from "./identity.js";
import {
  type TrajectoryDerivationAttestationLink,
  writeTrajectoryDerivationAttestationLink,
} from "./link.js";
import {
  type CapturePaths,
  assertSafeSessionId,
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  resolveCapturePaths,
  sessionDirectory,
  sessionFeedPath,
  workspaceDirectory,
} from "./paths.js";
import {
  type CaptureRetentionReport,
  SEAL_MARKER_FILENAME,
  listStrandedSessionIds,
  readRetentionWatermark,
  sweepCaptureRetention,
} from "./retention.js";
import { buildTrajectoryRecord } from "./trajectory.js";

/** At most this many stranded feeds are sealed per `openSession`, oldest first. */
const OPEN_SESSION_RECOVERY_LIMIT = 3;

/**
 * How long `openSession` waits for a busy archive before skipping recovery entirely. Short
 * by design: a session start must never feel like a hang, and a skipped recovery costs
 * nothing — the feed stays staged and the next open tries again.
 */
const OPEN_SESSION_RECOVERY_BUDGET_MS = 1_000;

const EMPTY_RETENTION: CaptureRetentionReport = {
  cutoff: "",
  sweptSessions: 0,
  sweptWorkspaces: 0,
  retainedSessions: 0,
  recoveredSessions: 0,
  droppedUnsealedSessions: 0,
  droppedRecoverableSessions: 0,
  sealedBeforeCutoff: 0,
  sealedCountTruncated: false,
};

export interface OpenSessionInput {
  readonly sessionId?: string;
}

export interface OpenSessionResult {
  readonly sessionId: string;
  readonly feedPath: string;
}

export interface SealSessionInput {
  readonly sessionId: string;
  readonly outcome?: "completed" | "failed" | "abandoned";
  readonly endedAt?: string;
  readonly signal?: AbortSignal;
}

export interface SealedCapture {
  readonly executionId: ExecutionId;
  readonly record: EvidenceRecordReference;
  readonly recordBytes: Uint8Array;
  readonly artifacts: readonly EvidenceArtifactReference[];
  readonly nativeTrace: {
    readonly reference: EvidenceArtifactReference;
    readonly formatIri: string;
    readonly mediaType: string;
  };
  readonly trajectory: {
    readonly reference: EvidenceArtifactReference;
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly traceId: string;
  };
  readonly derivationAttestation: {
    readonly reference: EvidenceArtifactReference;
    readonly digest: `sha256:${string}`;
    readonly envelopeBytes: Uint8Array;
    readonly derivedAt: string;
  };
  readonly indexed: LocalEvidenceIndexingOutcome;
  readonly retention: CaptureRetentionReport;
}

export type SealSessionResult =
  | { readonly sealed: true; readonly capture: SealedCapture }
  | { readonly sealed: false; readonly diagnostics: readonly CaptureDiagnostic[] };

export interface CaptureCapability extends RuntimeCapability {
  openSession(input?: OpenSessionInput): Promise<OpenSessionResult>;
  sealSession(input: SealSessionInput): Promise<SealSessionResult>;
  abandonSession(sessionId: string): Promise<void>;
}

export interface CreateCaptureCapabilityOptions {
  readonly producerVersion: string;
  readonly signer: DsseSigner;
  readonly now?: () => Date;
  readonly newSessionId?: () => string;
  readonly withArchive?: typeof withCaptureArchive;
}

interface Started {
  readonly config: RuntimeConfig;
  readonly paths: CapturePaths;
  readonly log: RuntimeLogger;
}

export function createCaptureCapability(
  options: CreateCaptureCapabilityOptions,
): CaptureCapability {
  const now = options.now ?? (() => new Date());
  const newSessionId = options.newSessionId ?? (() => randomUUID());
  const withArchive = options.withArchive ?? withCaptureArchive;

  let started: Started | undefined;
  const sealing = new Set<string>();

  function requireStarted(): Started {
    if (started === undefined) {
      throw new PluginRuntimeError(
        "capture-not-started",
        "The capture capability has not been started.",
      );
    }
    return started;
  }

  async function readFeed(paths: CapturePaths, sessionId: string): Promise<Uint8Array> {
    const path = sessionFeedPath(paths, sessionId);
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      throw new PluginRuntimeError(
        "capture-feed-missing",
        `No session feed exists at ${path}.`,
        { cause: error },
      );
    }
  }

  /**
   * Seals one session using an archive the caller already holds.
   *
   * Split out from `sealSession` so retention's stranded-feed recovery can reuse the open
   * runtime: a nested `withCaptureArchive` would block on the exclusive lock this very call
   * is holding (`packages/evidence/local-runtime/src/lock.ts`).
   */
  async function sealInto(
    state: Started,
    runtime: LocalEvidenceRuntime,
    input: SealSessionInput,
  ): Promise<SealSessionResult> {
    const feedBytes = await readFeed(state.paths, input.sessionId);
    const feed = parseSessionFeed(feedBytes);
    const outcome = resolveSessionOutcome(feed, {
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
    });
    const trajectory = buildTrajectoryRecord(feed, feedBytes);
    const nativeTraceDigest = documentDigest(feedBytes);

    const assembly: CaptureAssemblyInput = {
      feed,
      feedPath: sessionFeedPath(state.paths, input.sessionId),
      workspaceDir: workspaceDirectory(state.paths, input.sessionId),
      producerVersion: options.producerVersion,
      outcome,
      trajectoryDigest: trajectory.digest,
    };

    await ensureOwnerOnlyDirectory(assembly.workspaceDir);

    // Trajectory artifact exists before the record that names it, never after.
    const trajectoryReceipt = await runtime.repository.putArtifact(trajectory.bytes, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const recorder = createExecutionRecorder({ repository: runtime.repository });
    const recording = await recorder.start(buildStartInput(assembly));
    const finalizeInput = buildFinalizeInput(assembly);

    // Bind the exact feed bytes and their declared format before finalizing.
    await recording.attachNativeTrace(finalizeInput.nativeTrace!, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const finalized = await recording.finalize(
      {
        outcome: finalizeInput.outcome,
        endedAt: finalizeInput.endedAt,
        results: finalizeInput.results!,
      },
      { ...(input.signal === undefined ? {} : { signal: input.signal }) },
    );
    if (!finalized.finalized) {
      return { sealed: false, diagnostics: finalized.diagnostics };
    }

    const executionDigest = finalized.receipt.record.digest;
    const derivedAt = outcome.endedAt;

    const statement = buildTrajectoryDerivationStatement({
      producerId: PRODUCER_IRI,
      executionDigest,
      trajectoryDigest: trajectory.digest,
      nativeTraceDigest,
      formatIri: SESSION_FEED_FORMAT_IRI,
      decoderId: TRAJECTORY_BUILDER_ID,
      decoderVersion: TRAJECTORY_BUILDER_VERSION,
      vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
      timebase: "source-epoch-ns",
      linkageMode: "forward-linked",
      derivedAt,
    });
    const attestation = await sealTrajectoryDerivationAttestation({
      statement,
      signer: options.signer,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const attestationReceipt = await runtime.repository.putArtifact(attestation.envelopeBytes, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const derivationLink: TrajectoryDerivationAttestationLink = {
      version: 1,
      executionDigest,
      trajectoryDigest: trajectory.digest,
      attestationDigest: attestation.digest,
      nativeTraceDigest,
      derivedAt,
    };
    await writeTrajectoryDerivationAttestationLink(state.paths, derivationLink);

    const recordBytes = await runtime.repository.getRecord(finalized.receipt.record);
    if (recordBytes === null) {
      throw new PluginRuntimeError(
        "capture-record-missing",
        `The sealed record ${finalized.receipt.record.digest} is not readable from the archive.`,
      );
    }
    const indexed = await runtime.awaitIndexed(finalized.receipt.record, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const capture: Omit<SealedCapture, "retention"> = {
      executionId: finalized.receipt.executionId,
      record: finalized.receipt.record,
      recordBytes,
      artifacts: finalized.receipt.artifacts,
      nativeTrace: {
        reference: { digest: nativeTraceDigest },
        formatIri: SESSION_FEED_FORMAT_IRI,
        mediaType: SESSION_FEED_MEDIA_TYPE,
      },
      trajectory: {
        reference: trajectoryReceipt.reference,
        bytes: trajectory.bytes,
        digest: trajectory.digest,
        traceId: trajectory.traceId,
      },
      derivationAttestation: {
        reference: attestationReceipt.reference,
        digest: attestation.digest,
        envelopeBytes: attestation.envelopeBytes,
        derivedAt,
      },
      indexed,
    };

    const markerPath = join(
      sessionDirectory(state.paths, input.sessionId),
      SEAL_MARKER_FILENAME,
    );
    await writeFile(
      markerPath,
      `${JSON.stringify({
        executionId: capture.executionId,
        record: capture.record,
        trajectory: capture.trajectory.digest,
        nativeTrace: capture.nativeTrace.reference.digest,
        derivationAttestation: capture.derivationAttestation.digest,
        sealedAt: now().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    await ensureOwnerOnlyFile(markerPath);

    return { sealed: true, capture: { ...capture, retention: EMPTY_RETENTION } };
  }

  /**
   * Runs the retention sweep against an archive the caller already holds, wiring recovery of
   * stranded feeds to `sealInto` on that same runtime. Shared by `sealSession` (which sweeps
   * after its own seal) and `openSession` (which sweeps to recover what nothing else owns).
   */
  async function sweepWithRecovery(
    state: Started,
    runtime: LocalEvidenceRuntime,
    options: {
      readonly keepSessionIds: readonly string[];
      readonly maxRecoveries?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<CaptureRetentionReport> {
    const report = await sweepCaptureRetention({
      paths: state.paths,
      retentionDays: state.config.captureRetentionDays,
      now: now(),
      keepSessionIds: options.keepSessionIds,
      catalog: runtime.catalog,
      ...(options.maxRecoveries === undefined ? {} : { maxRecoveries: options.maxRecoveries }),
      recover: async (sessionId) => {
        if (sealing.has(sessionId)) return false;
        sealing.add(sessionId);
        try {
          const recovered = await sealInto(state, runtime, { sessionId });
          if (!recovered.sealed) {
            state.log.warn("capture recovery produced diagnostics", {
              sessionId,
              diagnostics: recovered.diagnostics.map((entry) => entry.code),
            });
          }
          return recovered.sealed;
        } finally {
          sealing.delete(sessionId);
        }
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (report.droppedUnsealedSessions > 0) {
      state.log.warn("capture retention dropped unsealed session feeds", {
        count: report.droppedUnsealedSessions,
        cutoff: report.cutoff,
      });
    }
    return report;
  }

  /**
   * Best-effort recovery of feeds no live session owns, run at session start.
   *
   * Costs no archive access when there is nothing to recover, and never throws: a busy
   * archive means a sibling instance is working, so the right answer is to skip and let the
   * next open try again (the same skip-if-held shape the mirror sync uses).
   */
  async function recoverStrandedSessions(state: Started, exclude: string): Promise<void> {
    const stranded = await listStrandedSessionIds(state.paths, [exclude]).catch(
      () => [] as readonly string[],
    );
    if (stranded.length === 0) return;

    try {
      const report = await withArchive(
        {
          rootDir: state.config.archiveDirectory,
          busyTimeoutMs: OPEN_SESSION_RECOVERY_BUDGET_MS,
        },
        async (runtime) =>
          sweepWithRecovery(state, runtime, {
            keepSessionIds: [exclude],
            maxRecoveries: OPEN_SESSION_RECOVERY_LIMIT,
          }),
      );
      if (report.recoveredSessions > 0) {
        state.log.info("recovered stranded capture sessions", {
          recovered: report.recoveredSessions,
          remaining: Math.max(0, stranded.length - report.recoveredSessions),
        });
      }
    } catch (error) {
      state.log.debug("skipped stranded-capture recovery", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    name: "capture",

    async start(context: CapabilityContext): Promise<void> {
      const paths = resolveCapturePaths(context.config);
      await ensureOwnerOnlyDirectory(paths.captureDirectory);
      await ensureOwnerOnlyDirectory(paths.sessionsDirectory);
      await ensureOwnerOnlyDirectory(paths.workspacesDirectory);
      await ensureOwnerOnlyDirectory(paths.derivationLinksDirectory);
      started = { config: context.config, paths, log: context.log };
    },

    async stop(): Promise<void> {
      started = undefined;
    },

    async healthChecks(): Promise<readonly HealthCheck[]> {
      const state = requireStarted();
      const staging = await stat(state.paths.sessionsDirectory).then(
        (entry) => ({ present: entry.isDirectory(), mode: entry.mode & 0o777 }),
        () => ({ present: false, mode: 0 }),
      );
      const ownerOnly = process.platform === "win32" || (staging.mode & 0o077) === 0;
      const checks: HealthCheck[] = [
        {
          name: "capture-staging",
          ok: staging.present && ownerOnly,
          detail: !staging.present
            ? `Capture staging is missing at ${state.paths.sessionsDirectory}.`
            : ownerOnly
              ? `Session feeds stage owner-only at ${state.paths.sessionsDirectory}.`
              : `Capture staging at ${state.paths.sessionsDirectory} is readable by others ` +
                `(mode ${staging.mode.toString(8)}).`,
          remedy: !staging.present
            ? "Restart the plugin runtime to recreate capture staging."
            : ownerOnly
              ? null
              : `Run: chmod -R go-rwx ${state.paths.captureDirectory}`,
        },
      ];

      const watermark = await readRetentionWatermark(state.paths);
      if (watermark !== null && watermark.droppedUnsealedSessions > 0) {
        const recoverable = watermark.droppedRecoverableSessions;
        const unsealable = watermark.droppedUnsealedSessions - recoverable;
        checks.push(
          recoverable > 0
            ? {
                name: "capture-stranded",
                ok: false,
                detail:
                  `${String(recoverable)} session feed(s) that could have been sealed passed ` +
                  `the ${String(watermark.retentionDays)}-day retention window unrecovered ` +
                  `and were deleted (swept ${watermark.sweptAt}).`,
                remedy:
                  "Recovery runs at session start and seals at most three feeds per session, " +
                  "so a large backlog — or an archive held by another session at every " +
                  "start — can outpace it. Start sessions more often until the backlog " +
                  "clears, or raise JINN_PLUGIN_CAPTURE_RETENTION_DAYS to widen the window.",
              }
            : {
                name: "capture-stranded",
                ok: true,
                detail:
                  `${String(unsealable)} session feed(s) ended without an end record — cut ` +
                  `short mid-session — so they could not be sealed, and were deleted after ` +
                  `the ${String(watermark.retentionDays)}-day window (swept ${watermark.sweptAt}).`,
                remedy: null,
              },
        );
      }
      return checks;
    },

    async openSession(input?: OpenSessionInput): Promise<OpenSessionResult> {
      const state = requireStarted();
      const sessionId = input?.sessionId ?? newSessionId();
      assertSafeSessionId(sessionId);
      await ensureOwnerOnlyDirectory(sessionDirectory(state.paths, sessionId));
      const feedPath = sessionFeedPath(state.paths, sessionId);
      await ensureOwnerOnlyFile(feedPath);
      await recoverStrandedSessions(state, sessionId);
      return { sessionId, feedPath };
    },

    async abandonSession(sessionId: string): Promise<void> {
      const state = requireStarted();
      assertSafeSessionId(sessionId);
      await rm(sessionDirectory(state.paths, sessionId), { recursive: true, force: true });
      await rm(workspaceDirectory(state.paths, sessionId), { recursive: true, force: true });
    },

    async sealSession(input: SealSessionInput): Promise<SealSessionResult> {
      const state = requireStarted();
      assertSafeSessionId(input.sessionId);
      if (sealing.has(input.sessionId)) {
        throw new PluginRuntimeError(
          "capture-session-busy",
          `Session ${input.sessionId} is already being sealed by this runtime.`,
        );
      }
      sealing.add(input.sessionId);
      try {
        return await withArchive(
          {
            rootDir: state.config.archiveDirectory,
            busyTimeoutMs: state.config.captureArchiveBusyTimeoutMs,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          },
          async (runtime) => {
            const result = await sealInto(state, runtime, input);
            const retention = await sweepWithRecovery(state, runtime, {
              keepSessionIds: [input.sessionId],
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
            return result.sealed
              ? { sealed: true, capture: { ...result.capture, retention } }
              : result;
          },
        );
      } finally {
        sealing.delete(input.sessionId);
      }
    },
  };
}
