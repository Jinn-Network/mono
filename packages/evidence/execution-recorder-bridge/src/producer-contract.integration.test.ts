// SPDX-License-Identifier: Apache-2.0
//
// Drives the shared `@jinn-network/execution-recorder` producer conformance
// harness through the Recorder Bridge's real stream protocol: every driver
// operation is JSON-serialized, sent through `serveExecutionRecorderBridge`,
// parsed back out of its JSON response, and correlated by request ID. See
// `bridge.test.ts`'s file header for why this uses `InMemoryEvidenceRepository`
// rather than the filesystem Repository (`/fs` is reserved for `cli.ts`).

import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import type {
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import type {
  ExecutionId,
  FinalizedExecutionReceipt,
  FinalizeExecutionResult,
} from "@jinn-network/execution-recorder";
import {
  describeExecutionProducerContract,
  type ExecutionProducerContractDriver,
  type ExecutionProducerContractFinalizationInterruption,
  type ExecutionProducerContractFinalizedObservation,
  type ExecutionProducerContractFinalizedScenario,
  type ExecutionProducerContractScenario,
  type InterruptedFinalizationExecutionProducerContractObservation,
} from "@jinn-network/execution-recorder/testing";

import {
  RECORDER_BRIDGE_PROTOCOL,
  type RecorderBridgeResponse,
} from "./protocol.js";
import { serveExecutionRecorderBridge } from "./server.js";

const CAPTURE_STARTED_AT = "2026-07-24T09:59:59.900Z";
const EXECUTOR_STARTED_AT = "2026-07-24T10:00:00Z";
const ENDED_AT = "2026-07-24T10:00:01Z";
const PRODUCER_ID = "https://producer.example/bridge-contract-driver";
const ORIGIN = {
  kind: "producer-observed",
  observer: PRODUCER_ID,
} as const;

const EXECUTION_IDS = {
  completed: "urn:uuid:55555555-5555-4555-8555-555555555555",
  failed: "urn:uuid:66666666-6666-4666-8666-666666666666",
  abandoned: "urn:uuid:77777777-7777-4777-8777-777777777777",
  "interrupted-finalization":
    "urn:uuid:88888888-8888-4888-8888-888888888888",
} as const satisfies Record<ExecutionProducerContractScenario, string>;

interface ProducerContractFixtures {
  readonly task: Uint8Array;
  readonly trace: Uint8Array;
  readonly result: Uint8Array;
  readonly runtime: Uint8Array;
  readonly runner: Uint8Array;
}

const FIXTURE_SPECIFIERS = {
  task: "@jinn-network/execution-recorder/fixtures/producer-contract-v1/task.md",
  trace:
    "@jinn-network/execution-recorder/fixtures/producer-contract-v1/trace.jsonl",
  result:
    "@jinn-network/execution-recorder/fixtures/producer-contract-v1/result.txt",
  runtime:
    "@jinn-network/execution-recorder/fixtures/producer-contract-v1/runtime.json",
  runner:
    "@jinn-network/execution-recorder/fixtures/producer-contract-v1/runner.mjs",
} as const;

async function loadFixtures(): Promise<ProducerContractFixtures> {
  const entries = await Promise.all(
    Object.entries(FIXTURE_SPECIFIERS).map(async ([key, specifier]) => [
      key,
      new Uint8Array(await readFile(new URL(import.meta.resolve(specifier)))),
    ] as const),
  );
  return Object.fromEntries(entries) as unknown as ProducerContractFixtures;
}

function wireBytes(bytes: Uint8Array, mediaType: string, name: string) {
  return {
    kind: "bytes" as const,
    base64: Buffer.from(bytes).toString("base64"),
    mediaType,
    name,
  };
}

function file(entityId: string, bytes: Uint8Array, mediaType: string) {
  return {
    kind: "file" as const,
    entityId,
    source: wireBytes(bytes, mediaType, entityId),
    origin: ORIGIN,
  };
}

function nativeTrace(fixtures: ProducerContractFixtures) {
  return {
    artifact: file("trace.jsonl", fixtures.trace, "application/x-ndjson"),
    format: {
      entityId: "https://example.test/formats/producer-contract-v1",
      name: "Producer contract native trace",
    },
  };
}

function startParams(
  workspaceDir: string,
  executionId: string,
  scenario: string,
  fixtures: ProducerContractFixtures,
) {
  return {
    workspaceDir,
    executionId,
    startedAt: EXECUTOR_STARTED_AT,
    record: {
      name: `Bridge producer contract ${scenario}`,
      description:
        "Execution Evidence generated through the Recorder Bridge.",
      license: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
    task: {
      entityId: "task.md",
      name: "Producer contract task",
      source: wireBytes(fixtures.task, "text/markdown", "task.md"),
      origin: ORIGIN,
    },
    executor: {
      entityId: "https://executor.example/bridge-contract-driver",
      kind: "software",
      name: "Producer contract executor",
      softwareVersion: "1.0.0",
      origin: ORIGIN,
    },
    runtime: {
      entityId: "runtime.json",
      specification: wireBytes(fixtures.runtime, "application/json", "runtime.json"),
      name: "Producer contract runtime",
      softwareVersion: "1.0.0",
      origin: ORIGIN,
      components: [
        {
          kind: "controlled" as const,
          artifact: file("runner.mjs", fixtures.runner, "text/javascript"),
        },
      ],
    },
    producer: {
      entityId: PRODUCER_ID,
      kind: "software",
      name: "Recorder Bridge contract driver",
      softwareVersion: "1.0.0",
      origin: ORIGIN,
    },
  };
}

class BridgeTestClientError extends Error {
  override readonly name = "BridgeTestClientError";

  constructor(
    readonly domain: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface PendingBridgeRequest {
  readonly resolve: (response: RecorderBridgeResponse) => void;
  readonly reject: (error: unknown) => void;
}

interface WireMutationResult {
  readonly executionId: ExecutionId;
  readonly status: string;
  readonly receipt?: FinalizedExecutionReceipt;
}

/**
 * Speaks the Recorder Bridge's newline-delimited JSON protocol against an
 * in-process `serveExecutionRecorderBridge` session, exposing only
 * Recorder-shaped helper calls (`start`, `resume`, `finalize`) to the
 * conformance driver below.
 */
class BridgeTestClient {
  readonly #input = new PassThrough();
  readonly #served: Promise<void>;
  readonly #pending = new Map<string, PendingBridgeRequest>();
  #nextId = 0;

  constructor(repository: EvidenceRepository) {
    const output = new PassThrough();
    const reader = createInterface({ input: output, crlfDelay: Infinity });
    reader.on("line", (line) => {
      this.#handleLine(line);
    });
    this.#served = serveExecutionRecorderBridge({
      repository,
      input: this.#input,
      output,
    });
  }

  #failAllPending(error: Error): void {
    for (const waiter of this.#pending.values()) waiter.reject(error);
    this.#pending.clear();
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#failAllPending(
        new Error(
          `Bridge test client received a non-protocol standard output line: ${line}`,
        ),
      );
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { protocol?: unknown }).protocol !== RECORDER_BRIDGE_PROTOCOL ||
      typeof (parsed as { id?: unknown }).id !== "string"
    ) {
      this.#failAllPending(
        new Error(
          `Bridge test client received a non-protocol standard output line: ${line}`,
        ),
      );
      return;
    }
    const response = parsed as RecorderBridgeResponse;
    const waiter = this.#pending.get(response.id);
    if (waiter === undefined) {
      this.#failAllPending(
        new Error(
          `Bridge test client received an unexpected or duplicate response id: ${response.id}`,
        ),
      );
      return;
    }
    this.#pending.delete(response.id);
    waiter.resolve(response);
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    this.#nextId += 1;
    const id = `bridge-contract-driver-${this.#nextId}`;
    const response = await new Promise<RecorderBridgeResponse>(
      (resolve, reject) => {
        this.#pending.set(id, { resolve, reject });
        this.#input.write(
          `${JSON.stringify({
            protocol: RECORDER_BRIDGE_PROTOCOL,
            id,
            method,
            params,
          })}\n`,
        );
      },
    );
    if (!response.ok) {
      throw new BridgeTestClientError(
        response.error.domain,
        response.error.code,
        response.error.message,
      );
    }
    return response.result;
  }

  async start(params: unknown): Promise<WireMutationResult> {
    return (await this.#request("start", params)) as WireMutationResult;
  }

  async resume(workspaceDir: string): Promise<WireMutationResult> {
    return (await this.#request("resume", { workspaceDir })) as WireMutationResult;
  }

  async finalize(
    target: { readonly workspaceDir: string; readonly executionId: string },
    input: Record<string, unknown>,
  ): Promise<FinalizeExecutionResult> {
    return (await this.#request("finalize", {
      target,
      ...input,
    })) as FinalizeExecutionResult;
  }

  async close(): Promise<void> {
    this.#input.end();
    await this.#served;
  }
}

async function temporaryWorkspace(
  prefix: string,
): Promise<{ readonly workspaceDir: string; readonly cleanup: () => Promise<void> }> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(parent, { recursive: true, force: true });
  };
  return { workspaceDir: join(parent, "recording"), cleanup };
}

async function finalizeScenario(
  scenario: ExecutionProducerContractFinalizedScenario,
  fixtures: ProducerContractFixtures,
): Promise<ExecutionProducerContractFinalizedObservation> {
  const repository = new InMemoryEvidenceRepository();
  const client = new BridgeTestClient(repository);
  const { workspaceDir, cleanup } = await temporaryWorkspace(
    `jinn-bridge-contract-${scenario}-`,
  );

  try {
    const startResult = await client.start(
      startParams(workspaceDir, EXECUTION_IDS[scenario], scenario, fixtures),
    );
    const target = { workspaceDir, executionId: startResult.executionId };

    const finalizeResult = await client.finalize(target, {
      outcome: scenario,
      endedAt: ENDED_AT,
      ...(scenario === "completed"
        ? { results: [file("result.txt", fixtures.result, "text/plain")] }
        : {}),
      nativeTrace: nativeTrace(fixtures),
    });
    if (!finalizeResult.finalized) {
      throw new Error(
        `Bridge producer contract scenario was incomplete: ${JSON.stringify(
          finalizeResult.diagnostics,
        )}`,
      );
    }
    await client.close();

    const common = {
      executionId: target.executionId,
      workspaceDir,
      captureStartedAt: CAPTURE_STARTED_AT,
      executorStartedAt: EXECUTOR_STARTED_AT,
      expectedTaskBytes: fixtures.task,
      expectedTraceBytes: fixtures.trace,
      repository,
      receipt: finalizeResult.receipt,
      cleanup,
    };
    return scenario === "completed"
      ? { ...common, scenario, expectedResultBytes: fixtures.result }
      : { ...common, scenario };
  } catch (error) {
    await client.close().catch(() => undefined);
    await cleanup();
    throw error;
  }
}

interface InterruptedContext {
  readonly workspaceDir: string;
  readonly repository: EvidenceRepository;
  readonly cleanup: () => Promise<void>;
}

async function bridgeProducerContractDriver(): Promise<ExecutionProducerContractDriver> {
  const fixtures = await loadFixtures();
  let interrupted: InterruptedContext | undefined;

  return {
    run: (scenario) => finalizeScenario(scenario, fixtures),

    async runUntilFinalizationInterrupted(
      interruptFinalization: ExecutionProducerContractFinalizationInterruption,
    ): Promise<never> {
      const backing = new InMemoryEvidenceRepository();
      let capturedInterruption: unknown;
      const throwingRepository: EvidenceRepository = {
        capabilities: backing.capabilities,
        putArtifact: (...args) => backing.putArtifact(...args),
        getArtifact: (...args) => backing.getArtifact(...args),
        getRecord: (...args) => backing.getRecord(...args),
        putRecord: (...args) => {
          try {
            return interruptFinalization();
          } catch (error) {
            // The callback runs in-process (there is no wire boundary
            // between the test's repository double and the test itself),
            // so the exact thrown reference is captured here and
            // re-thrown below — preserving the object identity the shared
            // conformance harness asserts on, even though the response
            // that actually crosses the bridge's stdio protocol is a
            // sanitized, unrelated error payload.
            capturedInterruption = error;
            throw error;
          }
        },
      };

      const { workspaceDir, cleanup } = await temporaryWorkspace(
        "jinn-bridge-contract-interrupted-",
      );
      const client = new BridgeTestClient(throwingRepository);

      try {
        const startResult = await client.start(
          startParams(
            workspaceDir,
            EXECUTION_IDS["interrupted-finalization"],
            "interrupted-finalization",
            fixtures,
          ),
        );
        const target = { workspaceDir, executionId: startResult.executionId };
        await client.finalize(target, {
          outcome: "completed",
          endedAt: ENDED_AT,
          results: [file("result.txt", fixtures.result, "text/plain")],
          nativeTrace: nativeTrace(fixtures),
        });
        await client.close();
        await cleanup();
        throw new Error(
          "Injected finalization interruption was not observed.",
        );
      } catch (error) {
        await client.close().catch(() => undefined);
        if (capturedInterruption === undefined) {
          await cleanup();
          throw error;
        }
        interrupted = { workspaceDir, repository: backing, cleanup };
        throw capturedInterruption;
      }
    },

    async recoverFinalization(): Promise<InterruptedFinalizationExecutionProducerContractObservation> {
      if (interrupted === undefined) {
        throw new Error(
          "No interrupted finalization is available to recover.",
        );
      }
      const { workspaceDir, repository, cleanup } = interrupted;
      try {
        const recoveryClient = new BridgeTestClient(repository);
        const resumeResult = await recoveryClient.resume(workspaceDir);
        await recoveryClient.close();
        if (resumeResult.receipt === undefined) {
          throw new Error(
            "Resume did not recover a finalized receipt.",
          );
        }
        interrupted = undefined;
        return {
          scenario: "interrupted-finalization",
          executionId: resumeResult.executionId,
          workspaceDir,
          captureStartedAt: CAPTURE_STARTED_AT,
          executorStartedAt: EXECUTOR_STARTED_AT,
          expectedTaskBytes: fixtures.task,
          expectedTraceBytes: fixtures.trace,
          expectedResultBytes: fixtures.result,
          repository,
          receipt: resumeResult.receipt,
          cleanup,
        };
      } catch (error) {
        await cleanup();
        interrupted = undefined;
        throw error;
      }
    },
  };
}

describeExecutionProducerContract(bridgeProducerContractDriver);
