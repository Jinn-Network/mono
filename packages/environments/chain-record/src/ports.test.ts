// The ports are TYPES. This suite compiles against them and asserts the module contributes no
// runtime surface — a value here would make four consumers depend on an implementation.
//
// It is also the **compile-time pin** for the widened shapes settled by coordinator ruling CR3.
// The verification capability's stop-and-report clears when this file typechecks: every fact
// §5.1 steps 2-6 and 9 read is constructed below, at the spelling it is declared with, so a
// silent narrowing of any member fails `yarn typecheck` here rather than in a downstream plan.
import { describe, expect, test } from "vitest";

import type {
  ArtifactEntryObservation,
  ChainInstance,
  ChainMaterializer,
  ChainStateBackend,
  IsolationObservation,
  MaterializationCost,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
  ProbeExecutor,
  ReplayOutcome,
  RuntimeIdentityObservation,
  ScriptReplayer,
  VerifiedChainInstance,
} from "./ports.js";
import * as ports from "./ports.js";

interface FakeObservation { readonly finalStateCommitment: string }

const BLACKHOLE: NetworkPolicy = {
  egress: "denied",
  dns: "absent",
  archiveRpc: "unreachable",
  forkBackend: "absent",
};

const runtimeIdentity: RuntimeIdentityObservation = {
  imageManifestDigest: `sha256:${"1".repeat(64)}`,
  platform: "linux/amd64",
  reportedVersion: "1.3.7",
  binaryDigest: `sha256:${"2".repeat(64)}`,
  evmConfigurationDigest: `sha256:${"3".repeat(64)}`,
  chainId: 1,
  appliedControls: { miningMode: "manual", prevrandao: `0x${"9".repeat(64)}` },
  unsupportedControls: [],
};

const artifactEntries: ArtifactEntryObservation = {
  accounts: [`0x${"a1".repeat(20)}`],
  codeEntries: [`0x${"d0".repeat(20)}`],
  storageSlots: [{ address: `0x${"d0".repeat(20)}`, slot: `0x${"0".repeat(64)}` }],
};

const isolation: IsolationObservation = {
  networkPolicy: BLACKHOLE,
  egressAttempts: [{ target: "https://archive.example.test", outcome: "refused" }],
  forbiddenProbes: [{ method: "anvil_reset", expectedClass: "method-not-found", observedClass: "method-not-found" }],
  exposedSignerAccounts: [`0x${"a1".repeat(20)}`],
  ceilingChecks: [{ name: "maxTransactions", enforced: true }],
};

const cost: MaterializationCost = { wallSeconds: 3.2, cpuSeconds: 2.1, maxMemoryBytes: 512_000_000 };

const report: MaterializationReport = {
  runtimeIdentity,
  artifactEntries,
  postFixtureCommitment: `0x${"7".repeat(64)}`,
  loadedResources: [`sha256:${"5".repeat(64)}`],
  isolation,
  cost,
};

const instance: ChainInstance = {
  instanceId: "run-1",
  rpcEndpoint: "http://127.0.0.1:8545",
  report,
  stop: async () => {},
};

/** A solver's local runner: the floor, and nothing it does not need. */
const localRunnerInstance: ChainInstance = {
  instanceId: "local-1",
  rpcEndpoint: "http://127.0.0.1:8546",
  stop: async () => {},
};

/** A plain-JSON-RPC backend: no `eth_getProof`, so no storage root, and absence is expressible. */
const stateBackend: ChainStateBackend = {
  getAccount: async (address) =>
    address === `0x${"00".repeat(20)}`
      ? undefined
      : { nonce: "0", balanceWei: "0", codeHash: `0x${"0".repeat(64)}` },
  getCode: async () => "0x",
  getStorageAt: async () => `0x${"0".repeat(64)}`,
  getBlockHeader: async () => ({ hash: `0x${"e".repeat(64)}`, stateRoot: `0x${"f".repeat(64)}`, timestamp: 1_735_689_600 }),
};

const materializer: ChainMaterializer = {
  materialize: async () => instance,
  reset: async () => `0x${"7".repeat(64)}`,
};

const executor: ProbeExecutor<FakeObservation> = {
  execute: async () => ({
    observation: { finalStateCommitment: `0x${"1".repeat(64)}` },
    observationDigest: `sha256:${"2".repeat(64)}`,
  }),
};

const replayer: ScriptReplayer<FakeObservation> = {
  replay: async (): Promise<ReplayOutcome<FakeObservation>> => ({
    status: "replayed",
    observation: { finalStateCommitment: `0x${"3".repeat(64)}` },
    observationDigest: `sha256:${"4".repeat(64)}`,
    reportedValues: { supplyRateBps: "412" },
  }),
};

describe("port declarations", () => {
  test("the module exports no runtime value: consumers depend on contracts, not capability", () => {
    expect(Object.keys(ports)).toEqual([]);
  });

  test("a materializer hands back a stoppable instance with a runner-local endpoint", async () => {
    const request: MaterializationRequest = {
      record: {} as never,
      resources: { byDigest: new Map() },
      instanceId: "run-1",
      networkPolicy: BLACKHOLE,
    };
    const handle = await materializer.materialize(request);
    expect(handle.rpcEndpoint.startsWith("http://127.0.0.1")).toBe(true);
    expect(handle.instanceId).toBe(request.instanceId);
    await handle.stop();
  });

  // Coordinator ruling CR3: every fact §5.1 steps 2-6 and 9 read is on the report, at the
  // spelling the record uses, so the comparison in step 5 needs no conversion.
  test("the report carries every fact the verification protocol reads", () => {
    expect(report.runtimeIdentity.unsupportedControls).toEqual([]);
    expect(report.artifactEntries.accounts.length
      + report.artifactEntries.codeEntries.length
      + report.artifactEntries.storageSlots.length).toBe(3);
    expect(report.postFixtureCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(report.loadedResources[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.isolation.networkPolicy.egress).toBe("denied");
    expect(report.isolation.egressAttempts[0]?.outcome).toBe("refused");
    expect(report.cost.wallSeconds).toBeGreaterThan(0);
  });

  test("reset returns the post-reset commitment, in the record's own spelling", async () => {
    expect(await materializer.reset(instance)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("a verifying handle narrows the floor rather than forking it", () => {
    const verified: VerifiedChainInstance = { ...instance, report };
    expect(verified.report.postFixtureCommitment).toBe(report.postFixtureCommitment);
    // The floor is what a solver's local runner pays for: no report, no isolation evidence.
    expect(localRunnerInstance.report).toBeUndefined();
  });

  test("a state backend is a caller-supplied capability, never a locator the runtime dials", async () => {
    const request: MaterializationRequest = {
      record: {} as never,
      resources: { byDigest: new Map() },
      instanceId: "archive-1",
      networkPolicy: { ...BLACKHOLE, archiveRpc: "unreachable", forkBackend: "present" },
      stateBackend,
    };
    expect(await request.stateBackend?.getCode(`0x${"d0".repeat(20)}`, 21_000_000)).toBe("0x");
  });

  // A backend serving plain reads has no storage root to give, and an absent account is an
  // answer rather than a failure — the same answer a sealed world gives outside its slice.
  test("a plain-JSON-RPC backend needs no eth_getProof and can report absence", async () => {
    const present = await stateBackend.getAccount(`0x${"d0".repeat(20)}`, 21_000_000);
    expect(present?.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(present?.storageRoot).toBeUndefined();
    expect(await stateBackend.getAccount(`0x${"00".repeat(20)}`, 21_000_000)).toBeUndefined();
  });

  test("a probe executor returns the observation and the digest the verifier compares", async () => {
    const result = await executor.execute({ instance, probeSuite: new Uint8Array([1]) });
    expect(result.observationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.observation.finalStateCommitment).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("a replay either replays or refuses; an envelope violation is not a judgement call", async () => {
    const replayed = await replayer.replay({
      instance,
      script: { mediaType: "application/vnd.jinn.chain-solution.v1+json", environmentRecordDigest: `sha256:${"5".repeat(64)}`, operations: [] },
      envelope: {} as never,
    });
    expect(replayed.status).toBe("replayed");

    const refused: ReplayOutcome<FakeObservation> = {
      status: "refused",
      refusal: { reason: "envelope-exceeded", detail: "transaction 26 exceeds maxTransactions=25" },
    };
    expect(refused.status).toBe("refused");
  });
});
