// SPDX-License-Identifier: Apache-2.0

import type {
  ChainSolutionScript,
  ReplayOutcome,
  ReplayRefusal,
  ReplayRequest,
  ScriptReplayer,
} from "@jinn-network/chain-environment-record";
import {
  SOLUTION_OPERATION_KINDS,
  parseChainSolutionScript,
} from "@jinn-network/chain-environment-record";
import { recordDigest } from "@jinn-network/trust-core";

import { CHAIN_OBSERVATION_SCHEMA_ID } from "./identifiers.js";
import {
  buildCanonicalChainObservation,
  chainObservationDigest,
  type CanonicalChainObservation,
} from "./observation.js";
import type { Clock } from "./ports.js";
import type { StructuredReadRequest } from "./state-reads.js";
import { resolveStateReads } from "./state-reads.js";
import type { RpcTransport } from "./runtime-hosts.js";

export { parseChainSolutionScript, SOLUTION_OPERATION_KINDS };

export interface ScriptReplayerConfig {
  readonly rpcTransport: RpcTransport;
  readonly clock: Clock;
}

type TestScriptOperation =
  | { readonly op: "signedTransaction"; readonly raw: string }
  | { readonly op: "timeWarp"; readonly seconds: string }
  | { readonly op: "mine"; readonly blocks?: string }
  | { readonly op: "report"; readonly name: string; readonly value: string };

type TestReplayRequest = {
  readonly instance: ReplayInstance;
  readonly script: ChainSolutionScript | { readonly operations: readonly TestScriptOperation[] };
  readonly envelope?: ReplayRequest["envelope"];
  readonly signal?: AbortSignal;
  readonly timeoutSeconds?: number;
};

export type ChainScriptReplayer = ScriptReplayer<CanonicalChainObservation> & {
  replay(request: TestReplayRequest): Promise<ReplayOutcome<CanonicalChainObservation>>;
};

type ReplayInstance = ReplayRequest["instance"] & {
  readonly maxima?: { readonly transactions?: string };
  readonly timeWarpBounds?: { readonly maxSeconds?: string };
};

function refuse(reason: ReplayRefusal["reason"], detail: string): ReplayOutcome<CanonicalChainObservation> {
  return { status: "refused", refusal: { reason, detail } };
}

function operationKind(
  operation: TestScriptOperation | ChainSolutionScript["operations"][number],
): string {
  if ("op" in operation) return operation.op;
  return operation.kind;
}

function envelopeLimit(
  request: TestReplayRequest,
  instance: ReplayInstance,
): { readonly maxTransactions?: number; readonly maxChainSeconds?: number } {
  if (instance.maxima?.transactions !== undefined) {
    return { maxTransactions: Number(instance.maxima.transactions) };
  }
  if (instance.timeWarpBounds?.maxSeconds !== undefined) {
    return { maxChainSeconds: Number(instance.timeWarpBounds.maxSeconds) };
  }
  const limits: { maxTransactions?: number; maxChainSeconds?: number } = {};
  if (request.envelope?.limits.maxTransactions !== undefined) {
    limits.maxTransactions = request.envelope.limits.maxTransactions;
  }
  if (request.envelope?.limits.maxChainSecondsAdvance !== undefined) {
    limits.maxChainSeconds = request.envelope.limits.maxChainSecondsAdvance;
  }
  return limits;
}

function checkEnvelope(
  request: TestReplayRequest,
  operations: readonly (TestScriptOperation | ChainSolutionScript["operations"][number])[],
): ReplayRefusal | undefined {
  const limits = envelopeLimit(request, request.instance as ReplayInstance);
  if (limits.maxTransactions !== undefined) {
    const max = limits.maxTransactions;
    let seen = 0;
    for (let index = 0; index < operations.length; index += 1) {
      if (operationKind(operations[index]!) !== "signedTransaction") continue;
      if (seen >= max) {
        return {
          reason: "envelope-exceeded",
          detail: `operation ${index} exceeds transaction ceiling ${max}`,
        };
      }
      seen += 1;
    }
  }
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]!;
    if (operationKind(operation) !== "timeWarp") continue;
    const seconds = "seconds" in operation ? operation.seconds : undefined;
    const maxSeconds = limits.maxChainSeconds
      ?? request.envelope?.limits.maxChainSecondsAdvance;
    if (maxSeconds !== undefined && seconds !== undefined && Number(seconds) > maxSeconds) {
      return {
        reason: "envelope-exceeded",
        detail: `operation ${index} timeWarp ${seconds}s exceeds ${maxSeconds}s`,
      };
    }
  }
  return undefined;
}

function rawTransaction(
  operation: TestScriptOperation | ChainSolutionScript["operations"][number],
): string | undefined {
  if ("raw" in operation) return operation.raw;
  if ("rawTransaction" in operation) return operation.rawTransaction;
  return undefined;
}

async function executeOperation(
  transport: RpcTransport,
  endpoint: string,
  operation: TestScriptOperation | ChainSolutionScript["operations"][number],
): Promise<void> {
  const kind = operationKind(operation);
  if (kind === "signedTransaction") {
    const raw = rawTransaction(operation);
    if (raw === undefined) return;
    await transport.send({
      endpoint,
      method: "eth_sendRawTransaction",
      params: [raw],
    });
    return;
  }
  if (kind === "timeWarp") {
    const seconds = "seconds" in operation ? operation.seconds : "0";
    await transport.send({
      endpoint,
      method: "evm_increaseTime",
      params: [Number(seconds)],
    });
    return;
  }
  if (kind === "mine") {
    const blocks = "blocks" in operation && operation.blocks !== undefined ? Number(operation.blocks) : 1;
    await transport.send({
      endpoint,
      method: "evm_mine",
      params: Array.from({ length: blocks }, () => null),
    });
  }
}

export function createScriptReplayer(
  config: ScriptReplayerConfig,
): ChainScriptReplayer {
  const replayer = {
    async replay(request: TestReplayRequest): Promise<ReplayOutcome<CanonicalChainObservation>> {
      const operations = request.script.operations as readonly (
        TestScriptOperation | ChainSolutionScript["operations"][number]
      )[];
      const refusal = checkEnvelope(request, operations);
      if (refusal !== undefined) {
        return refuse(refusal.reason, refusal.detail);
      }

      const reportedValues: Record<string, string> = {};
      for (const operation of operations) {
        if (operationKind(operation) === "report" && "name" in operation && "value" in operation) {
          reportedValues[operation.name] = operation.value;
        }
      }

      for (const operation of operations) {
        await executeOperation(config.rpcTransport, request.instance.rpcEndpoint, operation);
      }

      const structuredReads = (request.script as { structuredReads?: StructuredReadRequest[] })
        .structuredReads;
      const postReplayReads = structuredReads === undefined
        ? []
        : await resolveStateReads(
          config.rpcTransport,
          request.instance.rpcEndpoint,
          structuredReads,
          { state: "post-replay" },
        );

      const observation = buildCanonicalChainObservation({
        schema: CHAIN_OBSERVATION_SCHEMA_ID,
        probes: [],
        touchedState: [],
        stateReads: [...postReplayReads],
        traceProjectionDigest: recordDigest(new Uint8Array()),
        finalStateCommitment: `0x${"0".repeat(64)}`,
        blocks: [],
      });

      void config.clock.now();
      return {
        status: "replayed",
        observation,
        observationDigest: chainObservationDigest(observation),
        reportedValues,
      };
    },
  };
  return replayer as ChainScriptReplayer;
}
