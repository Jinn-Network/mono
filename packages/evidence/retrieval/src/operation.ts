import type { JsonValue } from "@jinn-network/evidence-discovery";

import {
  DEFAULT_RETRIEVAL_HARD_LIMITS,
  type RetrievalHardLimits,
  type RetrievalOperationOptions,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";

export { DEFAULT_RETRIEVAL_HARD_LIMITS };

export interface OperationContext extends RetrievalHardLimits {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly deadline: number;
  remainingMs(): number;
  timedOut(): boolean;
  consumeRecordBytes(bytes: number): boolean;
  consumeArtifactBytes(bytes: number): boolean;
  recordBytesConsumed(): number;
  artifactBytesConsumed(): number;
  dispose(): void;
}

const encoder = new TextEncoder();

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `${name} must be a non-negative safe integer.`,
    );
  }
  return value;
}

export function resolveHardLimits(
  overrides: Partial<RetrievalHardLimits> = {},
): RetrievalHardLimits {
  const values = { ...DEFAULT_RETRIEVAL_HARD_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(values)) {
    positiveInteger(value, name);
  }
  return Object.freeze(values);
}

export function createOperationContext(
  hardLimits: RetrievalHardLimits,
  options: RetrievalOperationOptions = {},
): OperationContext {
  const timeoutMs = Math.min(
    hardLimits.timeoutMs,
    positiveInteger(options.timeoutMs ?? hardLimits.timeoutMs, "timeoutMs"),
  );
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (options.signal?.aborted) onCallerAbort();

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let deadlineElapsed = false;
  let recordBytes = 0;
  let artifactBytes = 0;
  const timer = setTimeout(() => {
    deadlineElapsed = true;
    controller.abort(new DOMException("Retrieval timed out.", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();

  const operationLimit = (
    requested: number | undefined,
    ceiling: number,
    name: string,
  ) => Math.min(positiveInteger(requested ?? ceiling, name), ceiling);
  const maxTotalRecordBytes = operationLimit(
    options.maxTotalRecordBytes,
    hardLimits.maxTotalRecordBytes,
    "maxTotalRecordBytes",
  );
  const maxTotalArtifactBytes = operationLimit(
    options.maxTotalArtifactBytes,
    hardLimits.maxTotalArtifactBytes,
    "maxTotalArtifactBytes",
  );

  return Object.freeze({
    ...hardLimits,
    timeoutMs,
    maxRecordBytes: operationLimit(
      options.maxRecordBytes,
      hardLimits.maxRecordBytes,
      "maxRecordBytes",
    ),
    maxTotalRecordBytes,
    maxArtifactBytes: operationLimit(
      options.maxArtifactBytes,
      hardLimits.maxArtifactBytes,
      "maxArtifactBytes",
    ),
    maxTotalArtifactBytes,
    maxProviderMetadataBytes: operationLimit(
      options.maxProviderMetadataBytes,
      hardLimits.maxProviderMetadataBytes,
      "maxProviderMetadataBytes",
    ),
    operationId: crypto.randomUUID(),
    signal: controller.signal,
    startedAt,
    deadline,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    timedOut: () => deadlineElapsed,
    consumeRecordBytes: (bytes: number) => {
      nonNegativeInteger(bytes, "record bytes");
      if (recordBytes + bytes > maxTotalRecordBytes) return false;
      recordBytes += bytes;
      return true;
    },
    consumeArtifactBytes: (bytes: number) => {
      nonNegativeInteger(bytes, "artifact bytes");
      if (artifactBytes + bytes > maxTotalArtifactBytes) return false;
      artifactBytes += bytes;
      return true;
    },
    recordBytesConsumed: () => recordBytes,
    artifactBytesConsumed: () => artifactBytes,
    dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    },
  });
}

export function validateQueryBounds(
  resultLimit: number,
  candidateBudget: number,
  limits: RetrievalHardLimits,
): void {
  positiveInteger(resultLimit, "resultLimit");
  positiveInteger(candidateBudget, "candidateBudget");
  if (resultLimit > limits.maxResultLimit) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `resultLimit exceeds host maximum ${limits.maxResultLimit}.`,
    );
  }
  if (candidateBudget > limits.maxCandidateBudget) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `candidateBudget exceeds host maximum ${limits.maxCandidateBudget}.`,
    );
  }
  if (candidateBudget < resultLimit) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "candidateBudget must be greater than or equal to resultLimit.",
    );
  }
}

export function jsonByteLength(value: JsonValue | unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

export function assertBoundedJson(
  value: JsonValue | unknown,
  maximumBytes: number,
  name: string,
): void {
  if (jsonByteLength(value) > maximumBytes) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `${name} exceeds ${maximumBytes} encoded bytes.`,
    );
  }
}

export async function mapBounded<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  map: (input: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> {
  positiveInteger(concurrency, "concurrency");
  const output = new Array<Output>(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const index = next++;
      output[index] = await map(inputs[index]!, index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, inputs.length) },
      () => worker(),
    ),
  );
  return output;
}
