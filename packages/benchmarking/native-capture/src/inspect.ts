// SPDX-License-Identifier: Apache-2.0

import {
  serializeCanonicalJson,
  type DigestBearingResourceDescriptor,
  type JsonValue,
} from "@jinn-network/benchmarking-protocol";
import { recordDigest } from "@jinn-network/evidence-protocol";
import type {
  ExecutionEvidenceArtifactSource,
  ExecutionEvidenceFileArtifact,
} from "@jinn-network/execution-evidence-builder";

import type {
  AtomizeContext,
  FixedNativeInvocation,
  NativeAdapterProbe,
  NativeExecutionAdapter,
  NativeRunInventory,
  NativeSnapshot,
} from "./types.js";

export interface InspectAtomicArtifact {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly origin: "native-emitted" | "aggregate-extracted";
}

export interface InspectProjectedSample {
  readonly evalId: string;
  readonly taskId: string;
  readonly sampleId: string;
  readonly epoch: number;
  readonly retry?: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly status: "success" | "error" | "cancelled";
  readonly evaluator: {
    readonly id: `${string}:${string}`;
    readonly name: string;
    readonly version?: string;
  };
  readonly task: InspectAtomicArtifact;
  readonly result?: InspectAtomicArtifact;
  readonly trace: InspectAtomicArtifact;
  readonly runtime: InspectAtomicArtifact;
  readonly truthMaterialPresent: boolean;
  readonly scores: readonly {
    readonly name: string;
    readonly value: string | number | boolean | null;
  }[];
}

export interface InspectOfficialProjection {
  readonly inspectVersion: string;
  readonly runId: string;
  readonly sourceFormat: string;
  readonly samples: readonly InspectProjectedSample[];
  readonly limitations: readonly string[];
}

/** Implemented by the isolated official `read_eval_log` worker. It must not import task,
 * solver, scorer, or model code while projecting a completed log. */
export interface InspectOfficialProjectionReader {
  read(snapshot: NativeSnapshot): InspectOfficialProjection;
}

export interface InspectNativeAdapterOptions {
  readonly adapterVersion: string;
  readonly mappingVersion: string;
  readonly executable: {
    readonly path: string;
    readonly descriptor: DigestBearingResourceDescriptor;
    readonly bytes: Uint8Array;
  };
  readonly launch?: Omit<FixedNativeInvocation, "executable" | "runtimeClosure">;
  readonly producer: {
    readonly id: `${string}:${string}`;
    readonly name: string;
    readonly version: string;
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unitKey(sample: InspectProjectedSample): string {
  return [
    sample.evalId,
    sample.taskId,
    sample.sampleId,
    String(sample.epoch),
    String(sample.retry ?? 0),
  ].map(encodeURIComponent).join("/");
}

function bytes(value: unknown): Uint8Array {
  return serializeCanonicalJson(value as JsonValue);
}

function source(artifact: InspectAtomicArtifact): ExecutionEvidenceArtifactSource {
  return {
    digest: recordDigest(artifact.bytes),
    size: artifact.bytes.byteLength,
    mediaType: artifact.mediaType,
    name: artifact.name,
  };
}

function deterministicExecutionId(sample: InspectProjectedSample): `urn:uuid:${string}` {
  const hex = recordDigest(bytes({
    evalId: sample.evalId,
    taskId: sample.taskId,
    sampleId: sample.sampleId,
    epoch: sample.epoch,
    retry: sample.retry ?? 0,
  })).slice(7);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function captureOrigin(context: AtomizeContext, producer: `${string}:${string}`) {
  return context.mode === "prospective"
    ? { kind: "external-observed", observer: "urn:software:inspect-ai", capturedBy: producer } as const
    : { kind: "executor-reported", reporter: "urn:software:inspect-ai", capturedBy: producer } as const;
}

export function createInspectNativeAdapter(
  reader: InspectOfficialProjectionReader,
  options: InspectNativeAdapterOptions,
): NativeExecutionAdapter {
  const identity = {
    id: "urn:jinn:native-adapter:inspect" as const,
    version: options.adapterVersion,
    mappingVersion: options.mappingVersion,
  };
  const probe = (snapshot: NativeSnapshot): NativeAdapterProbe => {
    const projection = reader.read(snapshot);
    return {
      compatible: projection.samples.length > 0,
      adapter: identity,
      runtimeClosure: [options.executable.descriptor],
      expectedScope: {
        unitKind: "inspect-eval-sample-epoch",
        nativeGroupId: { scheme: "urn:inspect:eval-id", value: projection.runId },
        expectedUnitCount: projection.samples.length,
        scope: snapshot.root,
      },
      limitations: projection.samples.length > 0
        ? projection.limitations
        : ["Inspect projection contains no EvalSample epoch units"],
    };
  };
  return {
    probe,
    ...(options.launch === undefined ? {} : {
      prepareLaunch: (): FixedNativeInvocation => ({
        executable: { path: options.executable.path, artifact: options.executable.descriptor },
        argv: options.launch!.argv,
        environment: options.launch!.environment,
        workingDirectoryPolicy: options.launch!.workingDirectoryPolicy,
        runtimeClosure: [options.executable.descriptor],
      }),
    }),
    inventory(snapshot): NativeRunInventory {
      const projection = reader.read(snapshot);
      return {
        nativeGroup: { scheme: "urn:inspect:eval-id", value: projection.runId },
        units: projection.samples.map((sample) => ({
          unitKey: unitKey(sample),
          identifiers: [
            { scheme: "urn:inspect:epoch", value: String(sample.epoch) },
            { scheme: "urn:inspect:eval-id", value: sample.evalId },
            ...(sample.retry === undefined ? [] : [{ scheme: "urn:inspect:retry", value: String(sample.retry) }]),
            { scheme: "urn:inspect:sample-id", value: sample.sampleId },
            { scheme: "urn:inspect:task-id", value: sample.taskId },
          ].sort((left, right) => compare(`${left.scheme}\u0000${left.value}`, `${right.scheme}\u0000${right.value}`)),
        })).sort((left, right) => compare(left.unitKey, right.unitKey)),
        limitations: projection.limitations,
      };
    },
    atomize(snapshot, coordinate, context) {
      const projection = reader.read(snapshot);
      const sample = projection.samples.find((candidate) => unitKey(candidate) === coordinate.unitKey);
      if (sample === undefined) {
        return {
          unitKey: coordinate.unitKey,
          status: "tombstone",
          artifacts: [],
          projectedEvaluations: [],
          limitations: ["projected EvalSample disappeared before atomization"],
        };
      }
      if (sample.truthMaterialPresent) {
        return {
          unitKey: coordinate.unitKey,
          status: "excluded",
          artifacts: [],
          projectedEvaluations: [],
          limitations: ["automated evaluator Task contains truth/reference material and was refused"],
        };
      }
      const atomicArtifacts = [sample.task, ...(sample.result === undefined ? [] : [sample.result]), sample.trace, sample.runtime];
      if (atomicArtifacts.some(({ origin }) => origin !== "native-emitted")) {
        return {
          unitKey: coordinate.unitKey,
          status: "failed",
          artifacts: [],
          projectedEvaluations: [],
          limitations: [
            "aggregate-only EvalLog extraction cannot fill exact Task/Result/trace roles under Evidence Protocol v1",
          ],
        };
      }
      const taskSource = source(sample.task);
      const resultSource = sample.result === undefined ? undefined : source(sample.result);
      const traceSource = source(sample.trace);
      const runtimeSource = source(sample.runtime);
      const executableSource: ExecutionEvidenceArtifactSource = {
        digest: `sha256:${options.executable.descriptor.digest.sha256}`,
        size: options.executable.bytes.byteLength,
        mediaType: options.executable.descriptor.mediaType ?? "application/octet-stream",
        name: options.executable.descriptor.name,
      };
      const origin = captureOrigin(context, options.producer.id);
      const file = (entityId: string, artifactSource: ExecutionEvidenceArtifactSource): ExecutionEvidenceFileArtifact => ({
        kind: "file",
        entityId,
        source: artifactSource,
        origin,
      });
      return {
        unitKey: coordinate.unitKey,
        status: "captured",
        projectedEvaluations: [],
        limitations: [],
        artifacts: [
          { source: taskSource, bytes: sample.task.bytes },
          ...(sample.result === undefined ? [] : [{ source: resultSource!, bytes: sample.result.bytes }]),
          { source: traceSource, bytes: sample.trace.bytes },
          { source: runtimeSource, bytes: sample.runtime.bytes },
          { source: executableSource, bytes: options.executable.bytes },
        ],
        evidence: {
          recording: {
            executionId: deterministicExecutionId(sample),
            startedAt: sample.startedAt,
            record: {
              name: `Inspect ${sample.taskId}/${sample.sampleId} epoch ${sample.epoch}`,
              description: "One native Inspect EvalSample epoch mapped to Evidence Protocol v1.",
              license: "https://creativecommons.org/publicdomain/zero/1.0/",
              executionIdentifiers: coordinate.identifiers.map(({ scheme, value }) => ({
                propertyId: scheme as `${string}:${string}`,
                value,
              })),
            },
            task: {
              entityId: "task/evaluator-request",
              name: sample.task.name,
              source: taskSource,
              origin,
              identifiers: [
                { propertyId: "urn:inspect:sample-id", value: sample.sampleId },
                { propertyId: "urn:inspect:task-id", value: sample.taskId },
              ],
            },
            initialInputs: [],
            executor: {
              entityId: sample.evaluator.id,
              kind: "software",
              name: sample.evaluator.name,
              ...(sample.evaluator.version === undefined ? {} : { softwareVersion: sample.evaluator.version }),
              origin,
            },
            runtime: {
              entityId: "runtime/inspect",
              specification: runtimeSource,
              name: "Inspect evaluator runtime",
              softwareVersion: projection.inspectVersion,
              origin,
              components: [{
                kind: "controlled",
                artifact: file("runtime/inspect-executable", executableSource),
              }],
            },
            producer: {
              entityId: options.producer.id,
              kind: "software",
              name: options.producer.name,
              softwareVersion: options.producer.version,
              origin: { kind: "producer-observed", observer: options.producer.id },
            },
          },
          additionalInputs: [],
          runtimeObservations: [],
          outcome: sample.status === "success" ? "completed" : sample.status === "cancelled" ? "abandoned" : "failed",
          endedAt: sample.endedAt,
          finalizedAt: snapshot.capturedAt,
          results: resultSource === undefined ? [] : [file("results/judge-response", resultSource)],
          nativeTrace: {
            artifact: file("trace/inspect-call", traceSource),
            format: {
              entityId: "https://inspect.aisi.org.uk/formats/eval-sample-trace",
              name: "Inspect per-call trace",
            },
          },
        },
      };
    },
  };
}
