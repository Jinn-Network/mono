// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import {
  createExecutionRecorder,
  type ExecutionId,
  type ExecutionRecording,
} from "@jinn-network/execution-recorder";
import type { EvidenceRepository } from "@jinn-network/evidence-repository";

import { RecorderBridgeError, toRecorderBridgeErrorPayload } from "./errors.js";
import {
  COMPATIBLE_RECORDER_VERSION,
  RECORDER_BRIDGE_METHODS,
  RECORDER_BRIDGE_PROTOCOL,
  RECORDER_BRIDGE_VERSION,
  type HelloResult,
  type RecorderBridgeMethod,
  type RecorderBridgeMutationResult,
  type RecorderBridgeResponse,
  type RecorderBridgeTarget,
} from "./protocol.js";
import {
  decodeFinalizeInput,
  decodeInputCapture,
  decodeNativeTrace,
  decodeRuntimeObservation,
  decodeStartInput,
} from "./wire.js";

export interface ExecutionRecorderBridge {
  dispatch(request: unknown): Promise<RecorderBridgeResponse>;
}

function isRecorderBridgeMethod(value: unknown): value is RecorderBridgeMethod {
  return (
    typeof value === "string" &&
    (RECORDER_BRIDGE_METHODS as readonly string[]).includes(value)
  );
}

function requireParamsObject(rawParams: unknown): Record<string, unknown> {
  if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
    throw new RecorderBridgeError(
      "INVALID_REQUEST",
      "Request params must be a JSON object.",
    );
  }
  return rawParams as Record<string, unknown>;
}

function requireWorkspaceDir(rawParams: unknown): string {
  const params = requireParamsObject(rawParams);
  const workspaceDir = params.workspaceDir;
  if (typeof workspaceDir !== "string" || workspaceDir.length === 0) {
    throw new RecorderBridgeError(
      "INVALID_REQUEST",
      "workspaceDir must be a non-empty string.",
    );
  }
  return workspaceDir;
}

function extractTarget(rawParams: unknown): RecorderBridgeTarget {
  const params = requireParamsObject(rawParams);
  const target = params.target;
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    throw new RecorderBridgeError(
      "INVALID_REQUEST",
      "target must be a JSON object.",
    );
  }
  const { workspaceDir, executionId } = target as Record<string, unknown>;
  if (typeof workspaceDir !== "string" || workspaceDir.length === 0) {
    throw new RecorderBridgeError(
      "INVALID_REQUEST",
      "target.workspaceDir must be a non-empty string.",
    );
  }
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new RecorderBridgeError(
      "INVALID_REQUEST",
      "target.executionId must be a non-empty string.",
    );
  }
  return { workspaceDir, executionId: executionId as ExecutionId };
}

function requestId(rawRequest: unknown): string {
  if (
    typeof rawRequest === "object" &&
    rawRequest !== null &&
    !Array.isArray(rawRequest) &&
    typeof (rawRequest as { id?: unknown }).id === "string"
  ) {
    return (rawRequest as { id: string }).id;
  }
  return "";
}

export function createExecutionRecorderBridge(options: {
  readonly repository: EvidenceRepository;
}): ExecutionRecorderBridge {
  const recorder = createExecutionRecorder({ repository: options.repository });
  const handles = new Map<string, ExecutionRecording>();
  const queues = new Map<string, Promise<unknown>>();

  function runQueued<T>(workspaceDir: string, run: () => Promise<T>): Promise<T> {
    const key = resolve(workspaceDir);
    const previous = queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, tail);
    return operation.finally(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
  }

  function attach(workspaceDir: string, recording: ExecutionRecording): void {
    handles.set(resolve(workspaceDir), recording);
  }

  function resolveAttached(target: RecorderBridgeTarget): ExecutionRecording {
    const recording = handles.get(resolve(target.workspaceDir));
    if (recording === undefined) {
      throw new RecorderBridgeError(
        "RECORDING_NOT_ATTACHED",
        "No execution recording is attached at this workspace.",
      );
    }
    if (recording.executionId !== target.executionId) {
      throw new RecorderBridgeError(
        "EXECUTION_ID_MISMATCH",
        "Execution ID does not match the attached recording.",
      );
    }
    return recording;
  }

  function mutationResult(
    recording: ExecutionRecording,
  ): RecorderBridgeMutationResult {
    return {
      executionId: recording.executionId,
      status: recording.status,
      ...(recording.receipt === undefined ? {} : { receipt: recording.receipt }),
    };
  }

  function helloResult(): HelloResult {
    return {
      bridgeVersion: RECORDER_BRIDGE_VERSION,
      recorderVersion: COMPATIBLE_RECORDER_VERSION,
      protocol: RECORDER_BRIDGE_PROTOCOL,
    };
  }

  async function dispatchMethod(
    method: RecorderBridgeMethod,
    rawParams: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "hello":
        return helloResult();

      case "start": {
        const input = decodeStartInput(rawParams);
        return runQueued(input.workspaceDir, async () => {
          const recording = await recorder.start(input);
          attach(input.workspaceDir, recording);
          return mutationResult(recording);
        });
      }

      case "resume": {
        const workspaceDir = requireWorkspaceDir(rawParams);
        return runQueued(workspaceDir, async () => {
          const recording = await recorder.resume({ workspaceDir });
          attach(workspaceDir, recording);
          return mutationResult(recording);
        });
      }

      case "captureInput": {
        const target = extractTarget(rawParams);
        const params = requireParamsObject(rawParams);
        const input = decodeInputCapture(params.input);
        return runQueued(target.workspaceDir, async () => {
          const recording = resolveAttached(target);
          await recording.captureInput(input);
          return mutationResult(recording);
        });
      }

      case "captureRuntimeObservation": {
        const target = extractTarget(rawParams);
        const params = requireParamsObject(rawParams);
        const observation = decodeRuntimeObservation(params.observation);
        return runQueued(target.workspaceDir, async () => {
          const recording = resolveAttached(target);
          await recording.captureRuntimeObservation(observation);
          return mutationResult(recording);
        });
      }

      case "attachNativeTrace": {
        const target = extractTarget(rawParams);
        const params = requireParamsObject(rawParams);
        const trace = decodeNativeTrace(params.trace);
        return runQueued(target.workspaceDir, async () => {
          const recording = resolveAttached(target);
          await recording.attachNativeTrace(trace);
          return mutationResult(recording);
        });
      }

      case "finalize": {
        const target = extractTarget(rawParams);
        const input = decodeFinalizeInput(rawParams);
        return runQueued(target.workspaceDir, async () => {
          const recording = resolveAttached(target);
          return recording.finalize(input);
        });
      }
    }
  }

  async function dispatch(rawRequest: unknown): Promise<RecorderBridgeResponse> {
    const id = requestId(rawRequest);
    try {
      if (
        typeof rawRequest !== "object" ||
        rawRequest === null ||
        Array.isArray(rawRequest)
      ) {
        throw new RecorderBridgeError(
          "INVALID_REQUEST",
          "Request must be a JSON object.",
        );
      }
      const envelope = rawRequest as Record<string, unknown>;
      if (envelope.protocol !== RECORDER_BRIDGE_PROTOCOL) {
        throw new RecorderBridgeError(
          "UNSUPPORTED_PROTOCOL",
          "Unsupported Recorder Bridge protocol.",
        );
      }
      if (typeof envelope.id !== "string" || envelope.id.length === 0) {
        throw new RecorderBridgeError(
          "INVALID_REQUEST",
          "Request id must be a non-empty string.",
        );
      }
      if (!isRecorderBridgeMethod(envelope.method)) {
        throw new RecorderBridgeError(
          "METHOD_NOT_FOUND",
          `Unknown Recorder Bridge method: ${String(envelope.method)}`,
        );
      }

      const result = await dispatchMethod(envelope.method, envelope.params);
      return { protocol: RECORDER_BRIDGE_PROTOCOL, id, ok: true, result };
    } catch (error) {
      return {
        protocol: RECORDER_BRIDGE_PROTOCOL,
        id,
        ok: false,
        error: toRecorderBridgeErrorPayload(error),
      };
    }
  }

  return { dispatch };
}
