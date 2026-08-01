// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ChainVerificationError } from "./errors.js";
import { CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI } from "./identifiers.js";
import {
  ChainEnvironmentVerificationPredicateSchema,
  parseChainEnvironmentVerificationPredicate,
} from "./predicate.js";

const OBSERVATION = `sha256:${"1".repeat(64)}`;
const OBSERVATION_HEX = "1".repeat(64);

function perRun(count: number, digest = OBSERVATION) {
  return Array.from({ length: count }, (_unused, index) => ({
    instanceId: `instance-${index}`,
    observationDigest: digest,
    wallSeconds: 3 + index,
  }));
}

const CLOSED = {
  protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  scope: "component",
  outcome: "closed-reproducible",
  window: { startedAt: "2026-07-31T09:00:00.000Z", endedAt: "2026-07-31T09:04:00.000Z" },
  verifier: { id: "https://example.test/verifier", version: "0.1.0", digest: `sha256:${"7".repeat(64)}` },
  materials: [{ name: "state-artifact", digest: { sha256: "2".repeat(64) } }],
  environment: {
    closureClass: "closed-state",
    fidelityClass: "anchored-subset",
    anchor: {
      caip2: "eip155:1",
      chainId: 1,
      blockNumber: "20000000",
      blockHash: `0x${"3".repeat(64)}`,
      stateRoot: `0x${"4".repeat(64)}`,
      timestamp: "1900000000",
      finalityPolicy: "finalized",
      authenticity: "declared",
    },
    runtime: {
      family: "anvil",
      version: "1.4.2",
      imageManifestDigest: `sha256:${"5".repeat(64)}`,
      platform: "linux/amd64",
      binaryDigest: `sha256:${"6".repeat(64)}`,
      reportedVersion: "anvil 1.4.2",
      evmConfigurationDigest: `sha256:${"8".repeat(64)}`,
      chainId: 1,
    },
    postFixtureCommitment: `0x${"9".repeat(64)}`,
    controls: { miningMode: "manual", prevrandao: "0x00", initialTimestamp: "1900000000" },
    envelope: {
      rpcAllowlist: { read: ["eth_call"], stateChanging: ["eth_sendRawTransaction"] },
      signerRoles: ["agent"],
      permittedChainId: 1,
      maxima: { transactions: "8", aggregateGas: "4000000" },
      egressPolicyId: "blackhole/1.0",
    },
    coverage: { proofCovered: 12, fixtureDeclared: 3, uncovered: 0, mutatesSourceProtocolState: true },
  },
  runs: {
    count: 5,
    observationDigest: OBSERVATION,
    perRun: perRun(5),
    allObservationsEqual: true,
    freshInstances: true,
  },
  baseline: {
    commitment: `0x${"a".repeat(64)}`,
    observation: { name: "observation", digest: { sha256: OBSERVATION_HEX } },
  },
  isolation: {
    networkPolicy: { egress: "denied", dns: "absent", archiveRpc: "unreachable", forkBackend: "absent" },
    closureEvidenceMode: "sealed-boundary",
    boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: true },
    egressAttempts: [],
    forbiddenProbes: [{ method: "anvil_setBalance", expectedClass: "method-not-allowed", observedClass: "method-not-allowed", passed: true }],
    signerScope: { declaredRoles: ["agent"], exposedAccounts: ["0x00000000000000000000000000000000000000aa"], unexpectedAccounts: [] },
    resolutionLog: { name: "resolution-log", digest: { sha256: "b".repeat(64) } },
  },
  cost: { artifactBytes: 4096, artifactCount: 3, wallSeconds: 21 },
} as const;

function reject(mutation: Record<string, unknown>, note: string): void {
  const candidate = { ...CLOSED, ...mutation };
  expect(
    ChainEnvironmentVerificationPredicateSchema.safeParse(candidate).success,
    note,
  ).toBe(false);
}

describe("chain environment verification predicate", () => {
  it("accepts the reference closed-reproducible predicate", () => {
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse(CLOSED).success).toBe(true);
  });

  it("requires the window on every outcome and rejects an inverted one", () => {
    const { window: _window, ...withoutWindow } = CLOSED;
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse(withoutWindow).success)
      .toBe(false);
    reject(
      { window: { startedAt: "2026-07-31T09:04:00.000Z", endedAt: "2026-07-31T09:00:00.000Z" } },
      "endedAt must not precede startedAt",
    );
  });

  it("carries runs and baseline iff the outcome is run-bearing", () => {
    const { runs: _runs, baseline: _baseline, ...withoutRuns } = CLOSED;
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse(withoutRuns).success)
      .toBe(false);
    // A non-run-bearing outcome carrying runs is the forged-repetition case.
    reject(
      {
        outcome: "artifact-unavailable",
        failure: { stage: "resolve", reason: "resource-unresolvable" },
      },
      "artifact-unavailable must not carry runs",
    );
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse({
      ...withoutRuns,
      outcome: "artifact-unavailable",
      failure: { stage: "resolve", reason: "resource-unresolvable", detail: "gone" },
    }).success).toBe(true);
  });

  it("requires every per-run observation digest to equal the canonical one", () => {
    const divergent = perRun(5);
    divergent[2] = { ...divergent[2]!, observationDigest: `sha256:${"c".repeat(64)}` };
    reject(
      { runs: { ...CLOSED.runs, perRun: divergent } },
      "closed-reproducible with a divergent per-run digest",
    );
  });

  it("keeps allObservationsEqual honest against the per-run digests", () => {
    const divergent = perRun(5);
    divergent[3] = { ...divergent[3]!, observationDigest: `sha256:${"c".repeat(64)}` };
    reject(
      {
        outcome: "probe-divergence",
        runs: { ...CLOSED.runs, perRun: divergent, allObservationsEqual: true },
        failure: {
          stage: "compare",
          reason: "probe-observation-divergence",
          divergence: {
            referenceRunIndex: 0,
            referenceObservationDigest: OBSERVATION,
            divergentRuns: [{
              index: 3,
              instanceId: "instance-3",
              observationDigest: `sha256:${"c".repeat(64)}`,
              observation: { digest: { sha256: "c".repeat(64) } },
            }],
          },
        },
      },
      "allObservationsEqual must be computed, not asserted",
    );
  });

  it("requires K to be at least the declared floor", () => {
    reject(
      { runs: { ...CLOSED.runs, count: 4, perRun: perRun(4) } },
      "K below the floor",
    );
    reject({ runs: { ...CLOSED.runs, count: 6 } }, "count must equal perRun.length");
  });

  it("requires fresh instance ids when freshInstances is claimed", () => {
    const repeated = perRun(5).map((run) => ({ ...run, instanceId: "instance-0" }));
    reject(
      { runs: { ...CLOSED.runs, perRun: repeated } },
      "a fresh-instantiation claim needs distinct instance ids",
    );
  });

  it("binds the baseline artifact to the canonical observation digest", () => {
    reject(
      { baseline: { ...CLOSED.baseline, observation: { digest: { sha256: "d".repeat(64) } } } },
      "baseline must name the canonical observation",
    );
  });

  it("keeps the closure evidence mode consistent with the fork backend", () => {
    reject(
      {
        isolation: {
          ...CLOSED.isolation,
          networkPolicy: { ...CLOSED.isolation.networkPolicy, forkBackend: "present" },
        },
      },
      "a present fork backend is the fork-backend-refusal mode",
    );
  });

  it("requires a refused fetch attempt in fork-backend mode", () => {
    const forkBacked = {
      ...CLOSED.isolation,
      networkPolicy: { ...CLOSED.isolation.networkPolicy, forkBackend: "present" },
      closureEvidenceMode: "fork-backend-refusal",
      boundaryProbe: undefined,
      egressAttempts: [],
    };
    reject(
      { isolation: forkBacked },
      "fork-backend closure evidence is the refusal, so an attempt must be recorded",
    );
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse({
      ...CLOSED,
      isolation: {
        ...forkBacked,
        egressAttempts: [{ target: "https://archive.example.test", outcome: "refused" }],
      },
    }).success).toBe(true);
  });

  it("requires the boundary probe in sealed mode, and refuses it in the other", () => {
    reject(
      { isolation: { ...CLOSED.isolation, boundaryProbe: undefined } },
      "sealed closure needs the boundary-rule probe, not the absence of errors",
    );
    reject(
      {
        isolation: {
          ...CLOSED.isolation,
          boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: false },
        },
      },
      "an out-of-slice read that is not empty is not closure",
    );
  });

  it("refuses a closed-reproducible outcome whose egress attempt succeeded", () => {
    reject(
      {
        isolation: {
          ...CLOSED.isolation,
          egressAttempts: [{ target: "https://archive.example.test", outcome: "succeeded" }],
        },
      },
      "a successful egress is offline-dependency-detected, never closed-reproducible",
    );
  });

  it("ties the failure reason to its outcome and stage", () => {
    reject(
      {
        outcome: "source-coverage-incomplete",
        runs: undefined,
        baseline: undefined,
        failure: { stage: "compare", reason: "artifact-entry-uncovered" },
      },
      "the stage must be the reason's stage",
    );
    reject(
      {
        outcome: "capability-mismatch",
        runs: undefined,
        baseline: undefined,
        failure: { stage: "provenance", reason: "artifact-entry-uncovered" },
      },
      "the outcome must be the reason's outcome",
    );
  });

  it("requires the anchor and coverage blocks exactly when fidelity is not local", () => {
    const { anchor: _anchor, coverage: _coverage, ...localEnvironment } = CLOSED.environment;
    reject({ environment: { ...CLOSED.environment, fidelityClass: "local" } },
      "a local record claims no anchor");
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse({
      ...CLOSED,
      environment: { ...localEnvironment, fidelityClass: "local" },
    }).success).toBe(true);
    reject({ environment: { ...CLOSED.environment, coverage: undefined } },
      "E13 coverage is computed for anchored-subset and full-state");
  });

  it("refuses RPC cost observations on a closed-state run", () => {
    reject({ cost: { ...CLOSED.cost, rpcCalls: 12 } },
      "a closed run that made RPC calls is a contradiction");
  });

  it("requires providers for archive-observed and forbids them for closed-reproducible", () => {
    reject({ providers: [{
      id: "provider-a",
      observedAt: "2026-07-31T09:02:00.000Z",
      rpcCalls: 40,
      rpcBytes: 900,
      observationDigest: OBSERVATION,
    }] }, "a closed-reproducible attestation names no providers");
  });

  it("requires composition iff the scope is composite", () => {
    reject({ scope: "composite" }, "a composite attestation carries the composition block");
  });

  it("throws a pathed error from the parser", () => {
    expect(() => parseChainEnvironmentVerificationPredicate({ ...CLOSED, outcome: "nope" }))
      .toThrow(ChainVerificationError);
  });
});
