// SPDX-License-Identifier: Apache-2.0

import {
  BENCHMARKING_PROTOCOL_V2,
  EXECUTION_BATCH_CAPTURE_RECORD_KIND,
  EXECUTION_BATCH_INTENT_RECORD_KIND,
  parseExecutionBatchCapture,
  parseExecutionBatchIntent,
  sealExecutionBatchCapture,
  sealExecutionBatchIntent,
  type DigestBearingResourceDescriptor,
  type EvidenceRecordReference,
  type ExecutionBatchCapture,
  type SealedRecord,
} from "@jinn-network/benchmarking-protocol";
import { recordDigest, validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import { buildExecutionEvidence } from "@jinn-network/execution-evidence-builder";

import type {
  CaptureAssurance,
  CaptureClock,
  IdempotentNativeLauncher,
  ImportNativeCaptureInput,
  NativeAdapterProbe,
  NativeCaptureSession,
  NativeCaptureStore,
  NativeCaptureVerification,
  NativeExecutionAdapter,
  NativeRunInventory,
  NativeSnapshot,
  NativeSnapshotPort,
  PlanNativeCaptureInput,
} from "./types.js";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function descriptor(name: string, record: SealedRecord): DigestBearingResourceDescriptor {
  return { name, digest: { sha256: record.digest.slice(7) } };
}

function sortedUnique<T>(values: readonly T[], key: (value: T) => string): T[] {
  const sorted = [...values].sort((left, right) => compare(key(left), key(right)));
  if (sorted.some((value, index) => index > 0 && key(sorted[index - 1]!) === key(value))) {
    throw new NativeCaptureError("DUPLICATE_NATIVE_UNIT", "native inventory contains duplicate coordinates");
  }
  return sorted;
}

function evidenceKey(reference: EvidenceRecordReference): string {
  return `${reference.family}\u0000${reference.record.digest.sha256}`;
}

function adapterKey(probe: NativeAdapterProbe, snapshot: NativeSnapshot, unitKey: string): string {
  return [
    probe.adapter.id,
    probe.adapter.version,
    probe.adapter.mappingVersion,
    snapshot.root.digest.sha256,
    unitKey,
  ].join("\u0000");
}

function counts(units: readonly { readonly status: string }[]) {
  return {
    capturedCount: units.filter(({ status }) => status === "captured").length,
    failedCount: units.filter(({ status }) => status === "failed").length,
    tombstoneCount: units.filter(({ status }) => status === "tombstone").length,
    excludedCount: units.filter(({ status }) => status === "excluded").length,
  };
}

function assurance(
  mode: "prospective" | "retrospective",
  units: readonly { readonly status: string }[],
  limitations: readonly string[],
): CaptureAssurance {
  const complete = units.every(({ status }) => status === "captured");
  return {
    origin: mode === "prospective" ? "native-direct" : "historical-sparse-import",
    timing: mode === "prospective" ? "prospective-native-observed" : "retrospective-artifacts-only",
    closure: complete ? "complete-relative-to-sealed-source" : "partial",
    availability: "digest-only",
    limitations: sortedUnique(limitations, (value) => value),
  };
}

export type NativeCaptureErrorCode =
  | "UNKNOWN_ADAPTER"
  | "INCOMPATIBLE_SOURCE"
  | "LAUNCH_UNSUPPORTED"
  | "SESSION_EXISTS"
  | "SESSION_NOT_FOUND"
  | "SESSION_PHASE_INVALID"
  | "DUPLICATE_NATIVE_UNIT"
  | "ATOM_COORDINATE_MISMATCH"
  | "ARTIFACT_DESCRIPTOR_MISMATCH"
  | "CAPTURE_NONCONFORMING";

export class NativeCaptureError extends Error {
  constructor(readonly code: NativeCaptureErrorCode, message: string) {
    super(message);
    this.name = "NativeCaptureError";
  }
}

export class NativeCaptureCoordinator {
  private readonly adapters: ReadonlyMap<string, NativeExecutionAdapter>;

  constructor(
    adapters: Readonly<Record<string, NativeExecutionAdapter>>,
    private readonly snapshots: NativeSnapshotPort,
    private readonly launcher: IdempotentNativeLauncher,
    private readonly store: NativeCaptureStore,
    private readonly clock: CaptureClock,
  ) {
    this.adapters = new Map(Object.entries(adapters));
  }

  private adapter(adapterId: string): NativeExecutionAdapter {
    const adapter = this.adapters.get(adapterId);
    if (adapter === undefined) {
      throw new NativeCaptureError("UNKNOWN_ADAPTER", `unknown native adapter ${adapterId}`);
    }
    return adapter;
  }

  plan(input: PlanNativeCaptureInput): NativeCaptureSession & { readonly phase: "planned" } {
    if (this.store.loadSession(input.sessionId) !== undefined) {
      throw new NativeCaptureError("SESSION_EXISTS", `session ${input.sessionId} already exists`);
    }
    const adapter = this.adapter(input.adapterId);
    const sourceSnapshot = this.snapshots.snapshot(input.source, input.policy);
    const probe = adapter.probe(sourceSnapshot);
    if (!probe.compatible) {
      throw new NativeCaptureError("INCOMPATIBLE_SOURCE", probe.limitations.join("; ") || "source is incompatible");
    }
    if (adapter.prepareLaunch === undefined) {
      throw new NativeCaptureError("LAUNCH_UNSUPPORTED", `${input.adapterId} does not support native launch`);
    }
    const invocation = adapter.prepareLaunch(sourceSnapshot, probe);
    const intent = sealExecutionBatchIntent({
      protocol: BENCHMARKING_PROTOCOL_V2,
      owner: input.owner,
      adapter: probe.adapter,
      invocation,
      source: sourceSnapshot.root,
      expectedScope: probe.expectedScope,
      privacy: input.privacy,
      ...(input.publicRegistration === undefined ? {} : { publicRegistration: input.publicRegistration }),
      sealedAt: this.clock.now(),
    });
    const intentReference = this.store.putRecord(
      EXECUTION_BATCH_INTENT_RECORD_KIND,
      `${input.sessionId}.intent.json`,
      intent,
    );
    const session = {
      sessionId: input.sessionId,
      revision: 0,
      phase: "planned",
      owner: input.owner,
      adapterId: input.adapterId,
      sourceSnapshot,
      intent,
      intentReference,
      invocation,
      policy: input.policy,
    } as const;
    this.store.saveSession(session, undefined);
    return session;
  }

  capture(sessionId: string): NativeCaptureSession & { readonly phase: "complete" } {
    const session = this.store.loadSession(sessionId);
    if (session === undefined) {
      throw new NativeCaptureError("SESSION_NOT_FOUND", `session ${sessionId} does not exist`);
    }
    if (session.phase === "complete") return session;
    if (session.phase === "ingesting") return this.ingest(session);
    const launching = session.phase === "planned" ? this.authorizeLaunch(session) : session;
    this.snapshots.assertUnchanged(launching.sourceSnapshot);
    this.launcher.ensureStarted(launching.launchId, launching.invocation);
    const result = this.launcher.wait(launching.launchId);
    const resultSnapshot = this.snapshots.snapshot(result.resultSource, launching.policy);
    const ingesting = {
      sessionId: launching.sessionId,
      revision: launching.revision + 1,
      phase: "ingesting",
      mode: "prospective",
      owner: launching.owner,
      adapterId: launching.adapterId,
      resultSnapshot,
      policy: launching.policy,
      launchLimitations: [
        ...result.limitations,
        ...(result.exitCode === 0 ? [] : [`native process exited with status ${result.exitCode}`]),
      ],
      intent: launching.intent,
      intentReference: launching.intentReference,
    } as const;
    this.store.saveSession(ingesting, launching.revision);
    return this.ingest(ingesting);
  }

  private authorizeLaunch(
    session: NativeCaptureSession & { readonly phase: "planned" },
  ): NativeCaptureSession & { readonly phase: "launching" } {
    const launching = {
      ...session,
      phase: "launching",
      revision: session.revision + 1,
      launchId: `${session.sessionId}/native-launch`,
    } as const;
    // The durable launch authorization is written before any process-spawn call.
    this.store.saveSession(launching, session.revision);
    return launching;
  }

  import(input: ImportNativeCaptureInput): NativeCaptureSession & { readonly phase: "complete" } {
    if (this.store.loadSession(input.sessionId) !== undefined) {
      throw new NativeCaptureError("SESSION_EXISTS", `session ${input.sessionId} already exists`);
    }
    const resultSnapshot = this.snapshots.snapshot(input.source, input.policy);
    const probe = this.adapter(input.adapterId).probe(resultSnapshot);
    if (!probe.compatible) {
      throw new NativeCaptureError("INCOMPATIBLE_SOURCE", probe.limitations.join("; ") || "source is incompatible");
    }
    const ingesting = {
      sessionId: input.sessionId,
      revision: 0,
      phase: "ingesting",
      mode: "retrospective",
      owner: input.owner,
      adapterId: input.adapterId,
      resultSnapshot,
      policy: input.policy,
      launchLimitations: ["historical occurrence is source-reported; Colophon did not observe execution"],
    } as const;
    this.store.saveSession(ingesting, undefined);
    return this.ingest(ingesting);
  }

  resume(sessionId: string): NativeCaptureSession & { readonly phase: "complete" } {
    return this.capture(sessionId);
  }

  private ingest(
    session: NativeCaptureSession & { readonly phase: "ingesting" },
  ): NativeCaptureSession & { readonly phase: "complete" } {
    const adapter = this.adapter(session.adapterId);
    this.snapshots.assertUnchanged(session.resultSnapshot);
    const probe = adapter.probe(session.resultSnapshot);
    if (!probe.compatible) {
      throw new NativeCaptureError("INCOMPATIBLE_SOURCE", probe.limitations.join("; ") || "source is incompatible");
    }
    const inventory = adapter.inventory(session.resultSnapshot);
    const units = this.atomize(session, probe, inventory);
    this.snapshots.assertUnchanged(session.resultSnapshot);
    const unitCounts = counts(units);
    const limitations = [
      ...session.launchLimitations,
      ...probe.limitations,
      ...inventory.limitations,
      ...units.flatMap((unit) => unit.limitations),
    ];
    const capture = sealExecutionBatchCapture({
      protocol: BENCHMARKING_PROTOCOL_V2,
      ...(session.intent === undefined ? {} : {
        intent: descriptor(`${session.sessionId}.intent.json`, session.intent),
      }),
      owner: session.owner,
      adapter: probe.adapter,
      source: session.resultSnapshot.root,
      ...(inventory.nativeGroup === undefined ? {} : { nativeGroup: inventory.nativeGroup }),
      units,
      closure: {
        inventoryCount: units.length,
        ...unitCounts,
        checks: [
          { name: "all-inventory-units-accounted", status: "pass" },
          { name: "source-unchanged-through-atomization", status: "pass" },
        ],
      },
      assurance: assurance(session.mode, units, limitations),
      capturedAt: this.clock.now(),
    });
    const captureReference = this.store.putRecord(
      EXECUTION_BATCH_CAPTURE_RECORD_KIND,
      `${session.sessionId}.capture.json`,
      capture,
    );
    const complete = {
      sessionId: session.sessionId,
      revision: session.revision + 1,
      phase: "complete",
      owner: session.owner,
      adapterId: session.adapterId,
      capture,
      captureReference,
      ...(session.intent === undefined ? {} : { intent: session.intent }),
      ...(session.intentReference === undefined ? {} : { intentReference: session.intentReference }),
    } as const;
    this.store.saveSession(complete, session.revision);
    return complete;
  }

  private atomize(
    session: NativeCaptureSession & { readonly phase: "ingesting" },
    probe: NativeAdapterProbe,
    inventory: NativeRunInventory,
  ): ExecutionBatchCapture["units"] {
    const coordinates = sortedUnique(inventory.units, ({ unitKey }) => unitKey);
    return coordinates.map((coordinate) => {
      const draft = this.adapter(session.adapterId).atomize(
        session.resultSnapshot,
        coordinate,
        {
          mode: session.mode,
          owner: session.owner,
          ...(session.intent === undefined ? {} : {
            intent: descriptor(`${session.sessionId}.intent.json`, session.intent),
          }),
        },
      );
      if (draft.unitKey !== coordinate.unitKey) {
        throw new NativeCaptureError(
          "ATOM_COORDINATE_MISMATCH",
          `adapter returned ${draft.unitKey} for inventory unit ${coordinate.unitKey}`,
        );
      }
      const projectedEvaluations = sortedUnique(draft.projectedEvaluations, evidenceKey);
      const limitations = sortedUnique(draft.limitations, (value) => value);
      if (draft.status !== "captured") {
        return {
          unitKey: coordinate.unitKey,
          identifiers: sortedUnique(coordinate.identifiers, ({ scheme, value }) => `${scheme}\u0000${value}`),
          status: draft.status,
          projectedEvaluations,
          limitations,
        };
      }
      if (draft.evidence === undefined) {
        throw new NativeCaptureError("CAPTURE_NONCONFORMING", `captured unit ${coordinate.unitKey} has no evidence input`);
      }
      for (const artifact of draft.artifacts) {
        const digest = recordDigest(artifact.bytes);
        if (digest !== artifact.source.digest || artifact.bytes.byteLength !== artifact.source.size) {
          throw new NativeCaptureError(
            "ARTIFACT_DESCRIPTOR_MISMATCH",
            `artifact bytes for ${coordinate.unitKey} do not match the declared digest and size`,
          );
        }
        this.store.putArtifact(artifact.source, artifact.bytes);
      }
      const bytes = buildExecutionEvidence(draft.evidence);
      const executionEvidence = this.store.putExecution(
        adapterKey(probe, session.resultSnapshot, coordinate.unitKey),
        bytes,
      );
      return {
        unitKey: coordinate.unitKey,
        identifiers: sortedUnique(coordinate.identifiers, ({ scheme, value }) => `${scheme}\u0000${value}`),
        status: "captured",
        executionEvidence,
        projectedEvaluations,
        limitations,
      };
    });
  }

  verify(sessionId: string): NativeCaptureVerification {
    const session = this.store.loadSession(sessionId);
    if (session === undefined) {
      throw new NativeCaptureError("SESSION_NOT_FOUND", `session ${sessionId} does not exist`);
    }
    if (session.phase !== "complete") {
      throw new NativeCaptureError("SESSION_PHASE_INVALID", `session ${sessionId} is ${session.phase}`);
    }
    const diagnostics: string[] = [];
    let intent;
    let capture;
    try {
      if (session.intent !== undefined) intent = parseExecutionBatchIntent(session.intent.bytes);
      capture = parseExecutionBatchCapture(session.capture.bytes);
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : "batch record is invalid");
      return { conforms: false, diagnostics };
    }
    for (const unit of capture.units) {
      if (unit.executionEvidence === undefined) continue;
      let bytes: Uint8Array;
      try {
        bytes = this.store.resolveEvidence(unit.executionEvidence);
      } catch (error) {
        diagnostics.push(error instanceof Error ? error.message : `missing ${unit.unitKey}`);
        continue;
      }
      if (recordDigest(bytes).slice(7) !== unit.executionEvidence.record.digest.sha256) {
        diagnostics.push(`${unit.unitKey}: execution evidence digest mismatch`);
        continue;
      }
      const report = validateExecutionEvidence(bytes);
      if (!report.conforms) diagnostics.push(`${unit.unitKey}: execution evidence is nonconforming`);
    }
    return { conforms: diagnostics.length === 0, intent, capture, diagnostics };
  }
}
