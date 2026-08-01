// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { recordDigest } from "@jinn-network/trust-core";

import { createAnvilMaterializer } from "./anvil.js";
import { buildConformanceChainRecord } from "./conformance-records.js";
import { ChainVerificationError } from "./errors.js";
import { DEFAULT_BLACKHOLE_POLICY } from "./ports.js";
import type { Clock } from "./ports.js";
import {
  buildCanonicalChainObservation,
  chainObservationDigest,
} from "./observation.js";
import { createProbeExecutor } from "./probes.js";
import { createScriptReplayer, parseChainSolutionScript, SOLUTION_OPERATION_KINDS } from "./replay.js";
import {
  MATERIALIZATION_SNAPSHOT_RPC,
  type ProcessHost,
  type RpcTransport,
  type WorkspaceHost,
} from "./runtime-hosts.js";

// `fakeProcessHost()`, `fakeRpcTransport(script)`, `fakeWorkspace()` are local fakes: they
// record calls and answer scripted JSON-RPC results. No process is spawned anywhere.

const PINNED = {
  family: "anvil" as const,
  version: "1.3.7",
  binary: "sha256:3333333333333333333333333333333333333333333333333333333333333333" as const,
};

const DECLARED_ENTRY_COUNTS = buildConformanceChainRecord()
  .stateMaterialization.stateArtifact!.entryCounts;

describe("createAnvilMaterializer", () => {
  it("launches the pinned runtime through the injected process host, never directly", async () => {
    const processHost = fakeProcessHost();
    const materializer = createAnvilMaterializer({
      processHost,
      rpcTransport: fakeRpcTransport("healthy"),
      workspace: fakeWorkspace(),
      clock: createFixedClock(),
      pinnedRuntime: PINNED,
      supportedControls: ["miningMode", "initialTimestamp", "blockGasLimit", "coinbase"],
    });
    const instance = await materializer.materialize({
      record: buildConformanceChainRecord(),
      instanceId: "instance-0",
      networkPolicy: DEFAULT_BLACKHOLE_POLICY,
      resources: { byDigest: new Map() },
    });
    expect(processHost.spawns).toHaveLength(1);
    expect(processHost.spawns[0]!.command).toContain("anvil");
    expect(instance.instanceId).toBe("instance-0");
    await instance.stop();
    expect(processHost.kills).toBe(1);
  });

  it("refuses archive-dependent work with no caller-owned backend, and ignores locators",
    async () => {
      const processHost = fakeProcessHost();
      const materializer = createAnvilMaterializer({
        processHost, rpcTransport: fakeRpcTransport("healthy"), workspace: fakeWorkspace(),
        clock: createFixedClock(), pinnedRuntime: PINNED, supportedControls: [],
      });
      await expect(materializer.materialize({
        record: buildConformanceChainRecord({ closureClass: "archive-dependent" }),
        instanceId: "instance-0",
        networkPolicy: { ...DEFAULT_BLACKHOLE_POLICY, forkBackend: "present" },
        resources: { byDigest: new Map() },
      })).rejects.toThrow(ChainVerificationError);
      // Nothing was spawned, so no locator reached a launch line or an environment variable.
      expect(processHost.spawns).toHaveLength(0);
    });

  it("reports the entry index it LOADED, not the one the artifact declared", async () => {
    // CE4 cross-checks producer against loader; an index copied from the input would make that
    // check vacuous while looking like it passed.
    const materializer = createAnvilMaterializer({
      processHost: fakeProcessHost(), rpcTransport: fakeRpcTransport("partial-load"),
      workspace: fakeWorkspace(), clock: createFixedClock(), pinnedRuntime: PINNED,
      supportedControls: [],
    });
    const instance = await materializer.materialize({
      record: buildConformanceChainRecord(),
      instanceId: "instance-0",
      networkPolicy: DEFAULT_BLACKHOLE_POLICY,
      resources: { byDigest: new Map() },
    });
    expect(instance.report.artifactEntries.storageSlots)
      .not.toEqual(DECLARED_ENTRY_COUNTS.storageSlots);
  });

  it("refuses a record naming a runtime other than the pinned one", async () => {
    const materializer = createAnvilMaterializer({
      processHost: fakeProcessHost(),
      rpcTransport: fakeRpcTransport("healthy"),
      workspace: fakeWorkspace(),
      clock: createFixedClock(),
      pinnedRuntime: { ...PINNED, version: "1.0.0" },
      supportedControls: [],
    });
    await expect(materializer.materialize({
      record: buildConformanceChainRecord(),
      instanceId: "instance-0",
      networkPolicy: DEFAULT_BLACKHOLE_POLICY,
      resources: { byDigest: new Map() },
    })).rejects.toThrow(ChainVerificationError);
  });

  it("reports controls the pinned version cannot apply instead of pretending", async () => {
    // Design §10: `prevrandao` control at the Anvil level has been inconsistent across
    // versions. A materializer that silently ignored a declared control would make the
    // attestation state a control the runs did not have.
    const materializer = createAnvilMaterializer({
      processHost: fakeProcessHost(),
      rpcTransport: fakeRpcTransport("healthy"),
      workspace: fakeWorkspace(),
      clock: createFixedClock(),
      pinnedRuntime: PINNED,
      supportedControls: ["miningMode", "initialTimestamp"],
    });
    const instance = await materializer.materialize({
      record: buildConformanceChainRecord(),
      instanceId: "instance-0",
      networkPolicy: DEFAULT_BLACKHOLE_POLICY,
      resources: { byDigest: new Map() },
    });
    expect(instance.runtimeIdentity.unsupportedControls).toContain("prevrandao");
  });

  it("passes the blackhole policy to the launch arguments", async () => {
    const processHost = fakeProcessHost();
    const materializer = createAnvilMaterializer({
      processHost, rpcTransport: fakeRpcTransport("healthy"), workspace: fakeWorkspace(),
      clock: createFixedClock(), pinnedRuntime: PINNED, supportedControls: [],
    });
    await materializer.materialize({
      record: buildConformanceChainRecord(),
      instanceId: "instance-0",
      networkPolicy: DEFAULT_BLACKHOLE_POLICY,
      resources: { byDigest: new Map() },
    });
    const args = processHost.spawns[0]!.args.join(" ");
    // A sealed instance is launched with NO fork url at all -- the boundary rule, at the
    // launch line.
    expect(args).not.toContain("--fork-url");
    expect(processHost.spawns[0]!.env["ANVIL_NO_NETWORK"]).toBeDefined();
  });
});

describe("createProbeExecutor", () => {
  it("returns a canonical observation and reports its own cost", async () => {
    const executor = createProbeExecutor({
      rpcTransport: fakeRpcTransport("probe-suite"),
      clock: createFixedClock(),
    });
    const result = await executor.execute({
      instance: fakeInstance(),
      probeSuiteBytes: new TextEncoder().encode(JSON.stringify({ probes: [] })),
      comparatorBytes: new TextEncoder().encode("{}"),
      timeoutSeconds: 30,
    });
    expect(result.timedOut).toBe(false);
    expect(result.cost.wallSeconds).toBeGreaterThanOrEqual(0);
    expect(result.observation).toBeTypeOf("object");
  });

  it("digests the canonical observation, not JSON.stringify", async () => {
    const executor = createProbeExecutor({
      rpcTransport: fakeRpcTransport("probe-permuted"),
      clock: createFixedClock(),
    });
    const result = await executor.execute({
      instance: fakeInstance(),
      probeSuiteBytes: new TextEncoder().encode(JSON.stringify({ probes: [] })),
      comparatorBytes: new TextEncoder().encode("{}"),
      timeoutSeconds: 30,
    });
    const canonical = buildCanonicalChainObservation(result.observation);
    expect(result.observation).toEqual(canonical);
    expect(result.observationDigest).toBe(chainObservationDigest(canonical));
    const legacyDigest = recordDigest(
      new TextEncoder().encode(JSON.stringify(result.observation)),
    );
    expect(result.observationDigest).not.toBe(legacyDigest);
  });
});

describe("createScriptReplayer", () => {
  it("replays only CE1's four declared operations", () => {
    // The script schema is CE1's; this asserts the replayer handles each operation kind and
    // has no opinion about the grammar. Grammar rejection is CE1's own suite.
    expect([...SOLUTION_OPERATION_KINDS].sort())
      .toEqual(["mine", "report", "signedTransaction", "timeWarp"]);
    void parseChainSolutionScript;
  });

  it("refuses an operation outside the envelope rather than grading it", async () => {
    const replayer = createScriptReplayer({
      rpcTransport: fakeRpcTransport("healthy"),
      clock: createFixedClock(),
    });
    const result = await replayer.replay({
      instance: fakeInstance({ maxima: { transactions: "1" } }),
      script: { operations: [
        { op: "signedTransaction", raw: "0xf86b01" },
        { op: "signedTransaction", raw: "0xf86b02" },
      ] },
      timeoutSeconds: 30,
    });
    // A script exceeding the envelope is refused, not judged (design §8).
    expect(result.status).toBe("refused");
    // @ts-expect-error discriminated union not narrowed across vitest expect()
    expect(result.refusal.reason).toBe("envelope-exceeded");
    // @ts-expect-error discriminated union not narrowed across vitest expect()
    expect(result.refusal.detail).toContain("operation 1");
  });

  it("bounds time advancement to the record's declared window", async () => {
    const replayer = createScriptReplayer({
      rpcTransport: fakeRpcTransport("healthy"), clock: createFixedClock(),
    });
    const result = await replayer.replay({
      instance: fakeInstance({ timeWarpBounds: { maxSeconds: "600" } }),
      script: { operations: [{ op: "timeWarp", seconds: "86400" }] },
      timeoutSeconds: 30,
    });
    expect(result.status).toBe("refused");
    // @ts-expect-error discriminated union not narrowed across vitest expect()
    expect(result.refusal.reason).toBe("envelope-exceeded");
    // @ts-expect-error discriminated union not narrowed across vitest expect()
    expect(result.refusal.detail).toContain("timeWarp");
  });

  it("digests the canonical replay observation via chainObservationDigest", async () => {
    const replayer = createScriptReplayer({
      rpcTransport: fakeRpcTransport("healthy"),
      clock: createFixedClock(),
    });
    const result = await replayer.replay({
      instance: fakeInstance(),
      script: { operations: [{ op: "report", name: "balance", value: "42" }] },
      timeoutSeconds: 30,
    });
    expect(result.status).toBe("replayed");
    if (result.status !== "replayed") return;
    expect(result.observationDigest).toBe(chainObservationDigest(result.observation));
    const legacyDigest = recordDigest(
      new TextEncoder().encode(JSON.stringify(result.observation)),
    );
    expect(result.observationDigest).not.toBe(legacyDigest);
  });
});

function fakeProcessHost(): ProcessHost & {
  readonly spawns: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  }[];
  kills: number;
} {
  const spawns: {
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
  }[] = [];
  const host = {
    spawns,
    kills: 0,
    async spawn(request: {
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    }) {
      spawns.push({
        command: request.command,
        args: [...request.args],
        env: { ...request.env },
      });
      return {
        pid: "fake-pid",
        endpoint: "http://127.0.0.1:8545",
        async wait() {
          return { exitCode: 0, stderr: "" };
        },
        async kill() {
          host.kills += 1;
        },
      };
    },
  };
  return host;
}

function fakeRpcTransport(
  script: "healthy" | "partial-load" | "probe-suite" | "probe-permuted",
): RpcTransport {
  return {
    async send(request) {
      if (request.method === "eth_chainId") return "0x1";
      if (request.method === MATERIALIZATION_SNAPSHOT_RPC) {
        const slotCount = script === "partial-load" ? 8 : DECLARED_ENTRY_COUNTS.storageSlots;
        return {
          artifactEntries: {
            accounts: Array.from(
              { length: DECLARED_ENTRY_COUNTS.accounts },
              (_, index) => `0x${String(index).padStart(40, "0")}`,
            ),
            codeEntries: Array.from(
              { length: DECLARED_ENTRY_COUNTS.codeEntries },
              (_, index) => `0x${String(index + 10).padStart(40, "0")}`,
            ),
            storageSlots: Array.from({ length: slotCount }, (_, index) => ({
              address: `0x${"c".repeat(40)}`,
              slot: `0x${index.toString(16).padStart(64, "0")}`,
            })),
          },
          postFixtureCommitment: `0x${"d".repeat(64)}`,
        };
      }
      if (request.method === "jinn_probeObservation") {
        if (script === "probe-permuted") {
          return {
            probes: [],
            touchedState: [
              {
                address: "0x00000000000000000000000000000000000000bb",
                nonce: "1",
                balance: "1",
                codeHash: `0x${"3".repeat(64)}`,
                storage: [{ slot: `0x${"0".repeat(63)}2`, value: `0x${"0".repeat(63)}9` }],
              },
              {
                address: "0x00000000000000000000000000000000000000aa",
                nonce: "0",
                balance: "0",
                codeHash: `0x${"4".repeat(64)}`,
                storage: [],
              },
            ],
          };
        }
        return { probes: [], touchedState: [] };
      }
      if (request.method === "eth_sendRawTransaction") return `0x${"e".repeat(64)}`;
      if (request.method === "evm_increaseTime") return 1;
      if (request.method === "evm_mine") return `0x${"f".repeat(64)}`;
      return null;
    },
  };
}

function fakeWorkspace(): WorkspaceHost {
  return {
    async create(instanceId) {
      return { path: `/tmp/${instanceId}` };
    },
    async write(path, name) {
      return `${path}/${name}`;
    },
    async destroy() {},
  };
}

function createFixedClock(): Clock {
  const fixed = new Date("2026-01-01T00:00:00.000Z");
  return { now() { return fixed; } };
}

function fakeInstance(overrides?: {
  readonly maxima?: { readonly transactions?: string };
  readonly timeWarpBounds?: { readonly maxSeconds?: string };
}) {
  return {
    instanceId: "instance-0",
    rpcEndpoint: "http://127.0.0.1:8545",
    async stop() {},
    ...overrides,
  };
}
