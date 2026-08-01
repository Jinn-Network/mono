// SPDX-License-Identifier: Apache-2.0

import { recordDigest } from "@jinn-network/trust-core";

import { CHAIN_OBSERVATION_SCHEMA_ID } from "./identifiers.js";
import {
  buildCanonicalChainObservation,
  chainObservationDigest,
} from "./observation.js";
import type { ChainProbeExecutionRequest, ChainProbeExecutionResult, Clock } from "./ports.js";
import type { StructuredReadRequest } from "./state-reads.js";
import { resolveStateReads } from "./state-reads.js";
import type { RpcTransport } from "./runtime-hosts.js";

export interface ProbeExecutorConfig {
  readonly rpcTransport: RpcTransport;
  readonly clock: Clock;
}

const PROBE_OBSERVATION_RPC = "jinn_probeObservation" as const;

function parseProbeSuite(bytes: Uint8Array): {
  readonly probes: readonly unknown[];
  readonly structuredReads?: readonly StructuredReadRequest[];
} {
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text) as {
    probes?: unknown[];
    structuredReads?: StructuredReadRequest[];
  };
  const result: {
    probes: unknown[];
    structuredReads?: StructuredReadRequest[];
  } = {
    probes: Array.isArray(parsed.probes) ? parsed.probes : [],
  };
  if (parsed.structuredReads !== undefined) {
    result.structuredReads = parsed.structuredReads;
  }
  return result;
}

export function createProbeExecutor(config: ProbeExecutorConfig): {
  execute(request: ChainProbeExecutionRequest): Promise<ChainProbeExecutionResult>;
} {
  return {
    async execute(request) {
      const started = config.clock.now().getTime();
      const suite = parseProbeSuite(request.probeSuiteBytes);
      const baselineReads = suite.structuredReads === undefined
        ? []
        : await resolveStateReads(
          config.rpcTransport,
          request.instance.rpcEndpoint,
          suite.structuredReads,
          { state: "baseline" },
        );

      const raw = await config.rpcTransport.send({
        endpoint: request.instance.rpcEndpoint,
        method: PROBE_OBSERVATION_RPC,
        params: [{
          probes: suite.probes,
          comparatorBytes: Array.from(request.comparatorBytes),
          timeoutSeconds: request.timeoutSeconds,
        }],
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      const observation = buildCanonicalChainObservation({
        schema: CHAIN_OBSERVATION_SCHEMA_ID,
        probes: [],
        touchedState: [],
        traceProjectionDigest: recordDigest(new Uint8Array()),
        finalStateCommitment: `0x${"0".repeat(64)}`,
        blocks: [],
        ...(typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {}),
        stateReads: baselineReads,
      });
      const wallSeconds = Math.max(0, (config.clock.now().getTime() - started) / 1000);
      return {
        observation,
        observationDigest: chainObservationDigest(observation),
        timedOut: false,
        cost: { wallSeconds },
      };
    },
  };
}
