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
  NativeUnitCoordinate,
} from "./types.js";

export interface NativeSnapshotEntry {
  readonly path: string;
  readonly kind: "file";
  readonly size: number;
}

export interface NativeSnapshotReader {
  list(snapshot: NativeSnapshot): readonly NativeSnapshotEntry[];
  read(snapshot: NativeSnapshot, path: string): Uint8Array;
}

export interface HarborNativeAdapterOptions {
  readonly adapterVersion: string;
  readonly mappingVersion: string;
  readonly harborVersion: string;
  readonly executable: {
    readonly path: string;
    readonly descriptor: DigestBearingResourceDescriptor;
    readonly bytes: Uint8Array;
  };
  readonly launch?: Omit<FixedNativeInvocation, "executable" | "runtimeClosure"> & {
    readonly argv: readonly string[];
  };
  readonly producer: {
    readonly id: `${string}:${string}`;
    readonly name: string;
    readonly version: string;
  };
}

interface HarborTrial {
  readonly directory: string;
  readonly configPath: string;
  readonly resultPath: string;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safePath(path: string): boolean {
  return path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function entries(reader: NativeSnapshotReader, snapshot: NativeSnapshot): NativeSnapshotEntry[] {
  const listed = [...reader.list(snapshot)].sort((left, right) => compare(left.path, right.path));
  const seen = new Set<string>();
  for (const entry of listed) {
    if (!safePath(entry.path)) throw new HarborNativeAdapterError("UNSAFE_ARCHIVE_PATH", entry.path);
    if (seen.has(entry.path)) throw new HarborNativeAdapterError("DUPLICATE_ARCHIVE_PATH", entry.path);
    seen.add(entry.path);
  }
  return listed;
}

function trials(listed: readonly NativeSnapshotEntry[]): HarborTrial[] {
  const paths = new Set(listed.map(({ path }) => path));
  return listed.flatMap(({ path }) => {
    const match = /^([^/]+)\/config\.json$/u.exec(path);
    if (match === null) return [];
    const directory = match[1]!;
    const resultPath = `${directory}/result.json`;
    return paths.has(resultPath)
      ? [{ directory, configPath: path, resultPath }]
      : [];
  }).sort((left, right) => compare(left.directory, right.directory));
}

function parseObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HarborNativeAdapterError("MALFORMED_NATIVE_JSON", label);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarborNativeAdapterError("MALFORMED_NATIVE_JSON", label);
  }
  return value as Record<string, unknown>;
}

function source(bytes: Uint8Array, mediaType: string, name?: string): ExecutionEvidenceArtifactSource {
  return {
    digest: recordDigest(bytes),
    size: bytes.byteLength,
    mediaType,
    ...(name === undefined ? {} : { name }),
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return serializeCanonicalJson(value as JsonValue);
}

function text(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function object(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nativeId(record: Record<string, unknown>, fallback: string): string {
  return text(record, "id", "trial_id", "job_id") ?? fallback;
}

function selectPath(
  paths: ReadonlySet<string>,
  candidates: readonly string[],
): string | undefined {
  return candidates.find((candidate) => paths.has(candidate));
}

function origin(context: AtomizeContext, producer: `${string}:${string}`) {
  return context.mode === "prospective"
    ? { kind: "external-observed", observer: "urn:software:harbor", capturedBy: producer } as const
    : { kind: "executor-reported", reporter: "urn:software:harbor", capturedBy: producer } as const;
}

function iriComponent(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "-");
}

function deterministicExecutionId(jobId: string, trialId: string): `urn:uuid:${string}` {
  const hex = recordDigest(jsonBytes({ jobId, trialId })).slice(7);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type HarborNativeAdapterErrorCode =
  | "UNSAFE_ARCHIVE_PATH"
  | "DUPLICATE_ARCHIVE_PATH"
  | "MALFORMED_NATIVE_JSON";

export class HarborNativeAdapterError extends Error {
  constructor(readonly code: HarborNativeAdapterErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "HarborNativeAdapterError";
  }
}

export function createHarborNativeAdapter(
  reader: NativeSnapshotReader,
  options: HarborNativeAdapterOptions,
): NativeExecutionAdapter {
  const adapterIdentity = {
    id: "urn:jinn:native-adapter:harbor" as const,
    version: options.adapterVersion,
    mappingVersion: options.mappingVersion,
  };

  const probe = (snapshot: NativeSnapshot): NativeAdapterProbe => {
    const listed = entries(reader, snapshot);
    const paths = new Set(listed.map(({ path }) => path));
    const units = trials(listed);
    const compatible = paths.has("config.json") && paths.has("result.json") && units.length > 0;
    return {
      compatible,
      adapter: adapterIdentity,
      runtimeClosure: [options.executable.descriptor],
      expectedScope: {
        unitKind: "harbor-trial",
        expectedUnitCount: units.length,
        scope: snapshot.root,
      },
      limitations: compatible ? [] : ["Harbor Job root requires config.json, result.json, and at least one Trial"],
    };
  };

  const inventory = (snapshot: NativeSnapshot): NativeRunInventory => {
    const listed = entries(reader, snapshot);
    const jobResult = parseObject(reader.read(snapshot, "result.json"), "result.json");
    const jobId = nativeId(jobResult, snapshot.root.digest.sha256);
    return {
      nativeGroup: { scheme: "urn:harbor:job-id", value: jobId },
      units: trials(listed).map((trial): NativeUnitCoordinate => {
        const trialResult = parseObject(reader.read(snapshot, trial.resultPath), trial.resultPath);
        const trialConfig = parseObject(reader.read(snapshot, trial.configPath), trial.configPath);
        const identifiers = [
          { scheme: "urn:harbor:job-id", value: jobId },
          { scheme: "urn:harbor:trial-id", value: nativeId(trialResult, trial.directory) },
          ...(text(trialConfig, "source_trial") === undefined ? [] : [{
            scheme: "urn:harbor:source-trial-id",
            value: text(trialConfig, "source_trial")!,
          }]),
          ...(typeof trialConfig.attempt_number !== "number" ? [] : [{
            scheme: "urn:harbor:attempt-number",
            value: String(trialConfig.attempt_number),
          }]),
        ].sort((left, right) => compare(`${left.scheme}\u0000${left.value}`, `${right.scheme}\u0000${right.value}`));
        return { unitKey: trial.directory, identifiers };
      }),
      limitations: [],
    };
  };

  return {
    probe,
    inventory,
    ...(options.launch === undefined ? {} : {
      prepareLaunch: (): FixedNativeInvocation => ({
        executable: { path: options.executable.path, artifact: options.executable.descriptor },
        argv: options.launch!.argv,
        environment: options.launch!.environment,
        workingDirectoryPolicy: options.launch!.workingDirectoryPolicy,
        runtimeClosure: [options.executable.descriptor],
      }),
    }),
    atomize(snapshot, coordinate, context) {
      const listed = entries(reader, snapshot);
      const pathSet = new Set(listed.map(({ path }) => path));
      const trial = trials(listed).find(({ directory }) => directory === coordinate.unitKey);
      if (trial === undefined) {
        return {
          unitKey: coordinate.unitKey,
          status: "tombstone",
          artifacts: [],
          projectedEvaluations: [],
          limitations: ["inventory Trial disappeared before atomization"],
        };
      }
      const jobConfigBytes = reader.read(snapshot, "config.json");
      const trialConfigBytes = reader.read(snapshot, trial.configPath);
      const trialResultBytes = reader.read(snapshot, trial.resultPath);
      const jobConfig = parseObject(jobConfigBytes, "config.json");
      const trialConfig = parseObject(trialConfigBytes, trial.configPath);
      const trialResult = parseObject(trialResultBytes, trial.resultPath);
      const startedAt = text(trialResult, "started_at", "startedAt", "start_time", "startTime");
      const endedAt = text(trialResult, "ended_at", "endedAt", "end_time", "endTime");
      if (startedAt === undefined || endedAt === undefined) {
        return {
          unitKey: coordinate.unitKey,
          status: "failed",
          artifacts: [],
          projectedEvaluations: [],
          limitations: ["Trial lacks exact start/end timestamps; no Execution Evidence was fabricated"],
        };
      }

      const taskPath = selectPath(pathSet, [
        `${trial.directory}/task.json`,
        `${trial.directory}/task.md`,
        `${trial.directory}/prompt.txt`,
        "task.json",
        "task.md",
      ]);
      const taskBytes = taskPath === undefined
        ? jsonBytes(object(trialConfig, "task") ?? { task: trialConfig.task ?? null })
        : reader.read(snapshot, taskPath);
      const taskMediaType = taskPath?.endsWith(".md") || taskPath?.endsWith(".txt")
        ? "text/plain"
        : "application/json";
      const resultPath = selectPath(pathSet, [
        `${trial.directory}/artifacts/answer.txt`,
        `${trial.directory}/artifacts/prediction.json`,
        `${trial.directory}/agent/final_answer.txt`,
        trial.resultPath,
      ])!;
      const resultBytes = reader.read(snapshot, resultPath);
      const tracePath = selectPath(pathSet, [
        `${trial.directory}/agent/trajectory.json`,
        `${trial.directory}/agent/recording.cast`,
        `${trial.directory}/trace.jsonl`,
      ]);
      if (tracePath === undefined) {
        return {
          unitKey: coordinate.unitKey,
          status: "failed",
          artifacts: [],
          projectedEvaluations: [],
          limitations: ["Trial lacks an exact native trace; no Execution Evidence was fabricated"],
        };
      }
      const traceBytes = reader.read(snapshot, tracePath);
      const runtimeBytes = jsonBytes({
        harborVersion: options.harborVersion,
        job: jobConfig,
        trialAgent: object(trialConfig, "agent") ?? trialConfig.agent ?? null,
      });
      const agentBytes = jsonBytes(object(trialConfig, "agent") ?? { agent: trialConfig.agent ?? null });
      const taskSource = source(taskBytes, taskMediaType, taskPath ?? "task-summary.json");
      const resultSource = source(
        resultBytes,
        resultPath.endsWith(".json") ? "application/json" : "text/plain",
        resultPath,
      );
      const traceSource = source(
        traceBytes,
        tracePath.endsWith(".json") ? "application/json" : "application/octet-stream",
        tracePath,
      );
      const runtimeSource = source(runtimeBytes, "application/json", "harbor-runtime.json");
      const agentSource = source(agentBytes, "application/json", "harbor-agent.json");
      const executableSource: ExecutionEvidenceArtifactSource = {
        digest: `sha256:${options.executable.descriptor.digest.sha256}`,
        size: options.executable.bytes.byteLength,
        mediaType: options.executable.descriptor.mediaType ?? "application/octet-stream",
        name: options.executable.descriptor.name,
      };
      const captureOrigin = origin(context, options.producer.id);
      const file = (
        entityId: string,
        artifactSource: ExecutionEvidenceArtifactSource,
      ): ExecutionEvidenceFileArtifact => ({
        kind: "file",
        entityId,
        source: artifactSource,
        origin: captureOrigin,
      });
      const trialId = nativeId(trialResult, trial.directory);
      const jobResult = parseObject(reader.read(snapshot, "result.json"), "result.json");
      const jobId = nativeId(jobResult, snapshot.root.digest.sha256);
      const limitations = [
        ...(taskPath === undefined ? ["Task is an exact projection from Trial config; original task package bytes are absent"] : []),
        ...(resultPath === trial.resultPath ? ["Candidate answer artifact is unavailable; Result is the exact Harbor Trial result document"] : []),
      ].sort(compare);
      return {
        unitKey: coordinate.unitKey,
        status: "captured",
        projectedEvaluations: [],
        limitations,
        artifacts: [
          { source: taskSource, bytes: taskBytes },
          { source: resultSource, bytes: resultBytes },
          { source: traceSource, bytes: traceBytes },
          { source: runtimeSource, bytes: runtimeBytes },
          { source: agentSource, bytes: agentBytes },
          { source: executableSource, bytes: options.executable.bytes },
        ],
        evidence: {
          recording: {
            executionId: deterministicExecutionId(jobId, trialId),
            startedAt,
            record: {
              name: `Harbor Trial ${trialId}`,
              description: "One native Harbor Trial mapped to Evidence Protocol v1.",
              license: "https://creativecommons.org/publicdomain/zero/1.0/",
              executionIdentifiers: coordinate.identifiers.map(({ scheme, value }) => ({
                propertyId: scheme as `${string}:${string}`,
                value,
              })),
            },
            task: {
              entityId: "task/subject",
              name: taskPath ?? "Harbor Task projection",
              source: taskSource,
              origin: captureOrigin,
              identifiers: [{ propertyId: "urn:harbor:task-id", value: text(object(trialConfig, "task") ?? {}, "name", "id") ?? "unknown" }],
            },
            initialInputs: [],
            executor: {
              entityId: `urn:harbor:agent:${iriComponent(text(object(trialConfig, "agent") ?? {}, "name", "id") ?? agentSource.digest.slice(7))}`,
              kind: "software",
              name: text(object(trialConfig, "agent") ?? {}, "name", "id") ?? "Harbor Agent",
              origin: captureOrigin,
            },
            runtime: {
              entityId: "runtime/harbor",
              specification: runtimeSource,
              name: "Harbor native runtime",
              softwareVersion: options.harborVersion,
              origin: captureOrigin,
              components: [
                { kind: "controlled", artifact: file("runtime/harbor-executable", executableSource) },
                { kind: "controlled", artifact: file("runtime/agent-config.json", agentSource) },
              ],
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
          outcome: text(trialResult, "status") === "success" ? "completed" : "failed",
          endedAt,
          finalizedAt: snapshot.capturedAt,
          results: [file("results/candidate", resultSource)],
          nativeTrace: {
            artifact: file("trace/native", traceSource),
            format: {
              entityId: tracePath.endsWith("trajectory.json")
                ? "https://harborframework.com/formats/atif"
                : "https://harborframework.com/formats/native-trace",
              name: "Harbor Trial native trace",
            },
          },
        },
      };
    },
  };
}
