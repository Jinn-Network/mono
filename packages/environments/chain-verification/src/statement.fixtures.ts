// SPDX-License-Identifier: Apache-2.0

// Predicate builders for the statement suite. Deliberately a second spelling of the T5
// fixture: if the predicate schema changes, both suites must be updated, and a change that
// only one of them tolerates is caught here.

import { CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI } from "./identifiers.js";
import type { ChainEnvironmentVerificationPredicate } from "./predicate.js";

const DIGEST = (fill: string): `sha256:${string}` => `sha256:${fill.repeat(64)}`;

function base(): Omit<ChainEnvironmentVerificationPredicate, "scope" | "composition"> {
  return {
    protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    outcome: "closed-reproducible",
    window: { startedAt: "2026-07-31T09:00:00.000Z", endedAt: "2026-07-31T09:04:00.000Z" },
    verifier: { id: "https://example.test/verifier", version: "0.1.0", digest: DIGEST("7") },
    materials: [{ name: "state-artifact", digest: { sha256: "2".repeat(64) } }],
    environment: {
      closureClass: "closed-state",
      fidelityClass: "local",
      runtime: {
        family: "anvil",
        version: "1.4.2",
        imageManifestDigest: DIGEST("5"),
        platform: "linux/amd64",
        binaryDigest: DIGEST("6"),
        reportedVersion: "anvil 1.4.2",
        evmConfigurationDigest: DIGEST("8"),
        chainId: 31337,
      },
      postFixtureCommitment: `0x${"9".repeat(64)}`,
      controls: { miningMode: "manual" },
      envelope: {
        rpcAllowlist: { read: ["eth_call"], stateChanging: ["eth_sendRawTransaction"] },
        signerRoles: ["agent"],
        permittedChainId: 31337,
        maxima: { transactions: "8" },
        egressPolicyId: "blackhole/1.0",
      },
    },
    runs: {
      count: 5,
      observationDigest: DIGEST("1"),
      perRun: Array.from({ length: 5 }, (_unused, index) => ({
        instanceId: `instance-${index}`,
        observationDigest: DIGEST("1"),
        wallSeconds: 3 + index,
      })),
      allObservationsEqual: true,
      freshInstances: true,
    },
    baseline: {
      commitment: `0x${"a".repeat(64)}`,
      observation: { name: "observation", digest: { sha256: "1".repeat(64) } },
    },
    isolation: {
      networkPolicy: {
        egress: "denied", dns: "absent", archiveRpc: "unreachable", forkBackend: "absent",
      },
      closureEvidenceMode: "sealed-boundary",
      boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: true },
      egressAttempts: [],
      forbiddenProbes: [],
      signerScope: { declaredRoles: ["agent"], exposedAccounts: [], unexpectedAccounts: [] },
      resolutionLog: { name: "resolution-log", digest: { sha256: "b".repeat(64) } },
    },
    cost: { artifactBytes: 4096, artifactCount: 3, wallSeconds: 21 },
  };
}

export function closedPredicate(): ChainEnvironmentVerificationPredicate {
  return { ...base(), scope: "component" };
}

export function compositePredicate(
  options: { readonly chainWorld: `sha256:${string}` },
): ChainEnvironmentVerificationPredicate {
  return {
    ...base(),
    scope: "composite",
    composition: {
      routing: [],
      collisions: [],
      missPolicy: "declared-miss-response",
      allowlistedOrigins: [],
      requestBudget: { requests: 0, bytes: 0, enforced: true },
      components: [{ role: "chain-world", record: options.chainWorld }],
      wholeWorldOfflineBoot: true,
    },
  };
}
