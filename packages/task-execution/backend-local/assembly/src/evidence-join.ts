// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceCatalogReader } from "@jinn-network/evidence-discovery";
import type {
  EvidenceRecordReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import {
  createExecutionRecorder,
  type ExecutionRecording,
  type FinalizedExecutionReceipt,
  type InputCapture,
  type ResultCapture,
  type RuntimeObservationCapture,
} from "@jinn-network/execution-recorder";
import type { AttemptUri } from "@jinn-network/task-execution-backend";
import type { HarvestResult, WorkspacePaths } from "@jinn-network/task-execution-workspace";

export type EvidenceIndexingOutcome =
  | {
      readonly status: "indexed";
      readonly reference: EvidenceRecordReference;
      readonly projection: unknown;
    }
  | {
      readonly status: "failed";
      readonly reference: EvidenceRecordReference;
      readonly failure: unknown;
    }
  | {
      readonly status: "not-announced";
      readonly reference: EvidenceRecordReference;
    };

/** Host-owned concrete bindings. The local-runtime composition fits structurally, but is never imported. */
export interface EvidenceBindingPorts {
  readonly repository: EvidenceRepository;
  readonly catalog: EvidenceCatalogReader;
  readonly awaitIndexed: (
    reference: EvidenceRecordReference,
  ) => Promise<EvidenceIndexingOutcome>;
}

export interface EvidenceJoinOptions {
  readonly ports: EvidenceBindingPorts;
  readonly source: `${string}:${string}`;
  readonly executor: `${string}:${string}`;
  readonly producer?: `${string}:${string}`;
  readonly now?: () => string;
}

export interface StartEvidenceCaptureInput {
  readonly paths: WorkspacePaths;
  readonly attempt: AttemptUri;
  readonly taskDigest: `sha256:${string}`;
  readonly taskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly launchPlanBytes: Uint8Array;
  readonly startedAt: string;
}

export interface FinalizeEvidenceCaptureInput {
  readonly harvest: HarvestResult;
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly endedAt: string;
}

export interface EvidenceCaptureSession {
  readonly executionId: `urn:uuid:${string}`;
  captureRuntimeObservation(observation: RuntimeObservationCapture): Promise<void>;
  finalize(input: FinalizeEvidenceCaptureInput): Promise<FinalizedExecutionReceipt>;
}

export interface EvidenceJoin {
  readonly ports: EvidenceBindingPorts;
  start(input: StartEvidenceCaptureInput): Promise<EvidenceCaptureSession>;
  resume(paths: WorkspacePaths): Promise<EvidenceCaptureSession>;
  awaitIndexed(reference: EvidenceRecordReference): Promise<EvidenceIndexingOutcome>;
}

const TASK_MEDIA_TYPE = "application/vnd.jinn.task-execution.task.v1+json";
const DISPATCH_MEDIA_TYPE =
  "application/vnd.jinn.task-execution.dispatch-context.v1+json";
const origin = {
  kind: "producer-observed",
  observer: "https://jinn.network/software/backend-local",
} as const;

function inputCapture(
  entityId: string,
  bytes: Uint8Array,
  mediaType: string,
): InputCapture {
  return {
    kind: "file",
    entityId,
    source: {
      bytes,
      mediaType,
      name: entityId.split("/").at(-1),
    },
    origin,
  };
}

function results(
  paths: WorkspacePaths,
  harvest: HarvestResult,
): readonly ResultCapture[] {
  if (harvest.manifest.length === 0) {
    return [{
      kind: "file",
      entityId: "results/manifest.json",
      source: {
        bytes: new TextEncoder().encode("[]"),
        mediaType: "application/json",
        name: "manifest.json",
      },
      origin,
    }];
  }
  return harvest.manifest.map((artifact) => ({
    kind: "file" as const,
    entityId: `results/${artifact.path}`,
    source: {
      path: join(realpathSync(paths.out), artifact.path),
      mediaType: artifact.mediaType ?? "application/octet-stream",
      name: artifact.path.split("/").at(-1),
    },
    identifiers: [{
      propertyId: "https://jinn.network/schemes/sha256",
      value: String(artifact.sha256),
    }],
    origin,
  }));
}

class EvidenceCaptureSessionImpl implements EvidenceCaptureSession {
  constructor(
    private readonly recording: ExecutionRecording,
    private readonly paths: WorkspacePaths,
  ) {}

  get executionId(): `urn:uuid:${string}` {
    return this.recording.executionId;
  }

  captureRuntimeObservation(observation: RuntimeObservationCapture): Promise<void> {
    return this.recording.captureRuntimeObservation(observation);
  }

  async finalize(
    input: FinalizeEvidenceCaptureInput,
  ): Promise<FinalizedExecutionReceipt> {
    const result = await this.recording.finalize({
      outcome: input.outcome,
      endedAt: input.endedAt,
      results: results(this.paths, input.harvest),
      nativeTrace: {
        artifact: {
          kind: "file",
          entityId: "trace/supervisor-facts.json",
          source: {
            bytes: new TextEncoder().encode(JSON.stringify({
              outcome: input.outcome,
              endedAt: input.endedAt,
              outputs: input.harvest.manifest.map(({ path, sha256 }) => ({
                path,
                sha256,
              })),
            })),
            mediaType: "application/json",
            name: "supervisor-facts.json",
          },
          origin,
        },
        format: {
          entityId: "https://jinn.network/formats/backend-local-supervisor-facts/v1",
          name: "Jinn backend-local supervisor facts",
        },
      },
    });
    if (!result.finalized) {
      throw new Error(
        `execution evidence finalization incomplete: ${result.diagnostics
          .map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`)
          .join("; ")}`,
      );
    }
    return result.receipt;
  }
}

export function createEvidenceJoin(options: EvidenceJoinOptions): EvidenceJoin {
  const recorder = createExecutionRecorder({
    repository: options.ports.repository,
  });
  const producer = options.producer ?? options.source;

  return {
    ports: options.ports,
    async start(input) {
      const recording = await recorder.start({
        workspaceDir: join(realpathSync(input.paths.meta), "evidence-recording"),
        startedAt: input.startedAt,
        record: {
          name: "Jinn local task execution",
          description: "Execution captured by the embedded Jinn local backend.",
          license: "https://spdx.org/licenses/Apache-2.0.html",
          executionIdentifiers: [{
            propertyId: "https://jinn.network/schemes/task-execution-attempt-uri",
            value: input.attempt,
          }],
        },
        task: {
          entityId: "input/task.sealed",
          name: "Sealed Task",
          source: {
            bytes: input.taskBytes,
            mediaType: TASK_MEDIA_TYPE,
            name: "task.sealed",
          },
          identifiers: [{
            propertyId: "https://jinn.network/schemes/task-digest",
            value: input.taskDigest,
          }],
          origin,
        },
        initialInputs: [
          inputCapture(
            "input/dispatch-context.json",
            input.dispatchContextBytes,
            DISPATCH_MEDIA_TYPE,
          ),
        ],
        executor: {
          entityId: options.executor,
          kind: "software",
          name: "Jinn executor launcher",
          origin,
        },
        runtime: {
          entityId: "runtime/backend-local",
          specification: {
            bytes: input.launchPlanBytes,
            mediaType: "application/json",
            name: "launch-plan.json",
          },
          name: "Jinn backend-local LaunchPlan",
          origin,
          components: [{
            kind: "controlled",
            artifact: {
              kind: "file",
              entityId: "runtime/launch-plan.json",
              source: {
                bytes: input.launchPlanBytes,
                mediaType: "application/json",
                name: "launch-plan.json",
              },
              origin,
            },
          }],
        },
        producer: {
          entityId: producer,
          kind: "software",
          name: "Jinn backend-local",
          origin,
        },
      });
      return new EvidenceCaptureSessionImpl(recording, input.paths);
    },
    async resume(paths) {
      const recording = await recorder.resume({
        workspaceDir: join(realpathSync(paths.meta), "evidence-recording"),
      });
      return new EvidenceCaptureSessionImpl(recording, paths);
    },
    awaitIndexed(reference) {
      return options.ports.awaitIndexed(reference);
    },
  };
}
