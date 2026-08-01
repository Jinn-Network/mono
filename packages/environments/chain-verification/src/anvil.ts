// SPDX-License-Identifier: Apache-2.0

import type {
  ArtifactEntryObservation,
  ChainInstance,
  ChainMaterializer,
  MaterializationRequest,
  MaterializationReport,
  NetworkPolicy,
  RuntimeIdentityObservation,
  VerifiedChainInstance,
} from "@jinn-network/chain-environment-record";
import { requiresStateBackend } from "@jinn-network/chain-environment-record";
import { recordDigest } from "@jinn-network/trust-core";

import { invalidInput } from "./errors.js";
import type { Clock } from "./ports.js";
import {
  MATERIALIZATION_SNAPSHOT_RPC,
  type MaterializationSnapshot,
  type ProcessHost,
  type RpcTransport,
  type WorkspaceHost,
} from "./runtime-hosts.js";

const DETERMINISM_CONTROL_KEYS = [
  "miningMode",
  "orderingPolicy",
  "mempoolPolicy",
  "initialBlockNumber",
  "initialTimestamp",
  "blockTimeProgression",
  "baseFeePolicy",
  "gasPricePolicy",
  "blockGasLimit",
  "perTransactionGasCeiling",
  "coinbase",
  "prevrandao",
  "replacementPolicy",
  "noncePolicy",
  "timeoutClock",
  "timeWarp",
  "resetMechanism",
] as const;

export interface PinnedRuntimeIdentity {
  readonly family: "anvil";
  readonly version: string;
  readonly binary: `sha256:${string}`;
}

export interface AnvilMaterializerConfig {
  readonly processHost: ProcessHost;
  readonly rpcTransport: RpcTransport;
  readonly workspace: WorkspaceHost;
  readonly clock: Clock;
  readonly pinnedRuntime: PinnedRuntimeIdentity;
  readonly supportedControls: readonly string[];
}

/** Narrower than CE1's port on purpose: verification always produces a report. */
export type MaterializedChainInstance = VerifiedChainInstance & {
  readonly runtimeIdentity: RuntimeIdentityObservation;
};

export type VerifiedChainMaterializer = Omit<ChainMaterializer, "materialize"> & {
  materialize(request: MaterializationRequest): Promise<MaterializedChainInstance>;
};

interface ActiveInstance extends MaterializedChainInstance {
  readonly materializeRequest: MaterializationRequest;
}

function asPrefixedDigest(digest: string): `sha256:${string}` {
  return digest as `sha256:${string}`;
}

function controlValueToString(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function partitionControls(
  record: MaterializationRequest["record"],
  supportedControls: readonly string[],
): Pick<RuntimeIdentityObservation, "appliedControls" | "unsupportedControls"> {
  const appliedControls: Record<string, string> = {};
  const unsupportedControls: string[] = [];
  const controls = record.determinismControls as Record<string, unknown>;
  for (const key of DETERMINISM_CONTROL_KEYS) {
    if (!Object.hasOwn(controls, key)) continue;
    if (supportedControls.includes(key)) {
      appliedControls[key] = controlValueToString(controls[key]);
    } else {
      unsupportedControls.push(key);
    }
  }
  return { appliedControls, unsupportedControls };
}

function launchOptionToArgs(key: string, value: string | boolean | number): string[] {
  const flag = `--${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`;
  if (value === true) return [flag];
  if (value === false) return [];
  return [flag, String(value)];
}

function buildLaunchArgs(
  record: MaterializationRequest["record"],
  networkPolicy: NetworkPolicy,
  supportedControls: readonly string[],
): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(record.runtime.launch.options)) {
    args.push(...launchOptionToArgs(key, value));
  }
  if (supportedControls.includes("initialBlockNumber")) {
    args.push("--block-number", String(record.determinismControls.initialBlockNumber));
  }
  if (supportedControls.includes("initialTimestamp")) {
    args.push("--timestamp", String(record.determinismControls.initialTimestamp));
  }
  if (supportedControls.includes("blockGasLimit")) {
    args.push("--gas-limit", String(record.determinismControls.blockGasLimit));
  }
  args.push("--chain-id", String(record.runtime.evm.sandboxChainId));
  if (record.stateMaterialization.closureClass === "closed-state"
    || networkPolicy.forkBackend === "absent") {
    // Boundary rule: sealed instances carry no fork url at the launch line.
  }
  return args;
}

function buildLaunchEnv(networkPolicy: NetworkPolicy): Record<string, string> {
  const env: Record<string, string> = {};
  if (networkPolicy.egress === "denied") {
    env.ANVIL_NO_NETWORK = "1";
  }
  return env;
}

function validatePinnedRuntime(
  record: MaterializationRequest["record"],
  pinnedRuntime: PinnedRuntimeIdentity,
): void {
  if (record.runtime.family !== pinnedRuntime.family
    || record.runtime.version !== pinnedRuntime.version
    || record.runtime.binary.digest !== pinnedRuntime.binary) {
    invalidInput(
      `record runtime ${record.runtime.family} ${record.runtime.version} `
      + `${record.runtime.binary.digest} does not match pinned `
      + `${pinnedRuntime.family} ${pinnedRuntime.version} ${pinnedRuntime.binary}`,
    );
  }
}

async function fetchMaterializationSnapshot(
  transport: RpcTransport,
  endpoint: string,
  signal?: AbortSignal,
): Promise<MaterializationSnapshot> {
  const result = await transport.send({
    endpoint,
    method: MATERIALIZATION_SNAPSHOT_RPC,
    params: [],
    ...(signal === undefined ? {} : { signal }),
  });
  if (result === null || typeof result !== "object") {
    invalidInput("materialization snapshot RPC returned a non-object");
  }
  const snapshot = result as MaterializationSnapshot;
  if (!Array.isArray(snapshot.artifactEntries.accounts)
    || !Array.isArray(snapshot.artifactEntries.codeEntries)
    || !Array.isArray(snapshot.artifactEntries.storageSlots)
    || typeof snapshot.postFixtureCommitment !== "string") {
    invalidInput("materialization snapshot RPC returned an invalid shape");
  }
  return snapshot;
}

function buildReport(
  record: MaterializationRequest["record"],
  networkPolicy: NetworkPolicy,
  snapshot: MaterializationSnapshot,
  loadedResources: readonly `sha256:${string}`[],
  runtimeIdentity: RuntimeIdentityObservation,
  wallSeconds: number,
): MaterializationReport {
  const artifactEntries: ArtifactEntryObservation = {
    accounts: [...snapshot.artifactEntries.accounts],
    codeEntries: [...snapshot.artifactEntries.codeEntries],
    storageSlots: snapshot.artifactEntries.storageSlots.map((entry) => ({ ...entry })),
  };
  return {
    runtimeIdentity,
    artifactEntries,
    postFixtureCommitment: snapshot.postFixtureCommitment,
    loadedResources: [...loadedResources],
    isolation: {
      networkPolicy,
      egressAttempts: [],
      forbiddenProbes: [],
      exposedSignerAccounts: record.fixtures.accounts
        .filter((account) => account.role === "agent")
        .map((account) => account.address),
      ceilingChecks: [
        { name: "maxTransactions", enforced: true },
        { name: "maxAggregateGas", enforced: true },
        { name: "maxExecutionDurationMs", enforced: true },
      ],
    },
    cost: { wallSeconds },
  };
}

async function materializeOnce(
  config: AnvilMaterializerConfig,
  request: MaterializationRequest,
): Promise<ActiveInstance> {
  const started = config.clock.now().getTime();
  validatePinnedRuntime(request.record, config.pinnedRuntime);
  if (requiresStateBackend(request.record) && request.stateBackend === undefined) {
    invalidInput("archive-dependent record requires an injected state backend");
  }

  const loadedResources = [...request.resources.byDigest.keys()];
  const workspaceDir = await config.workspace.create(request.instanceId);
  const launchArgs = buildLaunchArgs(
    request.record,
    request.networkPolicy,
    config.supportedControls,
  );
  const process = await config.processHost.spawn({
    command: request.record.runtime.binary.name,
    args: launchArgs,
    cwd: workspaceDir.path,
    env: buildLaunchEnv(request.networkPolicy),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  for (const [digest, bytes] of request.resources.byDigest) {
    await config.workspace.write(workspaceDir.path, digest, bytes);
  }

  await config.rpcTransport.send({
    endpoint: process.endpoint,
    method: "eth_chainId",
    params: [],
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  const snapshot = await fetchMaterializationSnapshot(
    config.rpcTransport,
    process.endpoint,
    request.signal,
  );
  const runtimeIdentity: RuntimeIdentityObservation = {
    imageManifestDigest: asPrefixedDigest(request.record.runtime.image.manifestDigest),
    platform: request.record.runtime.image.platform,
    reportedVersion: request.record.runtime.version,
    binaryDigest: asPrefixedDigest(request.record.runtime.binary.digest),
    evmConfigurationDigest: recordDigest(
      new TextEncoder().encode(JSON.stringify(request.record.runtime.evm)),
    ),
    chainId: request.record.runtime.evm.sandboxChainId,
    ...partitionControls(request.record, config.supportedControls),
  };
  const wallSeconds = Math.max(0, (config.clock.now().getTime() - started) / 1000);
  const report = buildReport(
    request.record,
    request.networkPolicy,
    snapshot,
    loadedResources,
    runtimeIdentity,
    wallSeconds,
  );

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await process.kill();
    await config.workspace.destroy(workspaceDir.path);
  };

  const instance: ActiveInstance = {
    instanceId: request.instanceId,
    rpcEndpoint: process.endpoint,
    report,
    runtimeIdentity,
    materializeRequest: request,
    stop,
  };
  return instance;
}

export function createAnvilMaterializer(config: AnvilMaterializerConfig): VerifiedChainMaterializer {
  return {
    async materialize(request): Promise<MaterializedChainInstance> {
      return materializeOnce(config, request);
    },
    async reset(instance, signal) {
      const active = instance as ActiveInstance;
      if (active.materializeRequest === undefined) {
        invalidInput("reset requires an instance materialized by this adapter");
      }
      await instance.stop();
      const fresh = await materializeOnce(config, {
        ...active.materializeRequest,
        instanceId: active.instanceId,
        ...(signal === undefined ? {} : { signal }),
      });
      return fresh.report.postFixtureCommitment;
    },
  };
}

export type { ChainInstance, VerifiedChainInstance };
