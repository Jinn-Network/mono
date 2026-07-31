// SPDX-License-Identifier: Apache-2.0

import { parseDsseEnvelope, recordDigest } from "@jinn-network/trust-core";
import type { DsseSigner, Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { buildConformanceRecord } from "./import-source.js";
import { canonicalOutcomeSetBytes, outcomeSetDigest, type OutcomeSet } from "./outcome-set.js";
import type { ArtifactStore, Clock, ContainerRuntime } from "./ports.js";
import type { VerifierIdentity } from "./predicate.js";
import { verifyEnvironment } from "./verify.js";

const RECORD = buildConformanceRecord();
export const IMAGE_DIGEST = RECORD.image.manifestDigest as Sha256Digest;

const OUTCOMES: OutcomeSet = {
  "tests/test_a.py::test_one": "pass",
  "tests/test_b.py::test_two": "fail",
};

const VERIFIER: VerifierIdentity = {
  id: "https://example.test/verifier",
  version: "0.1.0",
  digest: `sha256:${"d".repeat(64)}`,
};

function scriptedRuntime(outcomesPerRun: readonly OutcomeSet[]): ContainerRuntime & {
  readonly containerIds: string[];
} {
  const containerIds: string[] = [];
  let index = 0;
  return {
    containerIds,
    async pullByDigest(request) {
      return { resolvedManifestDigest: request.manifestDigest };
    },
    async runContainer() {
      const containerId = `container-${index}`;
      containerIds.push(containerId);
      const outcomes = outcomesPerRun[index] ?? outcomesPerRun[outcomesPerRun.length - 1]!;
      index += 1;
      return {
        containerId,
        installExitCodes: [],
        testExitCodes: [1],
        outcomes,
        wallSeconds: 10 + index,
        timedOut: false,
      };
    },
  };
}

function memoryStore(): ArtifactStore & { readonly bytes: Map<string, Uint8Array> } {
  const bytes = new Map<string, Uint8Array>();
  return {
    bytes,
    async putArtifact(input) {
      const digest = recordDigest(input);
      bytes.set(digest, input);
      return { digest, size: input.length };
    },
  };
}

function fixedClock(): Clock {
  const instants = [
    new Date("2026-07-31T09:00:00.000Z"),
    new Date("2026-07-31T09:25:00.000Z"),
  ];
  let index = 0;
  return { now: () => instants[Math.min(index++, instants.length - 1)]! };
}

/** Deterministic, non-cryptographic stand-in. Real keys arrive in T12 via
 * trust-testing's `createEoaTestSigner`. */
const signer: DsseSigner = async (request) => [{
  keyid: "test-key",
  signature: new Uint8Array(new TextEncoder().encode(recordDigest(request.preAuthEncoding))),
}];

describe("verifyEnvironment — stable path", () => {
  it("runs K fresh containers and seals a stable attestation", async () => {
    const runtime = scriptedRuntime([OUTCOMES]);
    const artifactStore = memoryStore();
    const attestation = await verifyEnvironment(
      { containerRuntime: runtime, artifactStore, signer, clock: fixedClock(), verifier: VERIFIER },
      RECORD,
    );

    const { predicate } = attestation.statement;
    expect(predicate.result).toBe("stable");
    expect(predicate.runs?.count).toBe(5);
    expect(predicate.runs?.outcomeSetDigest).toBe(outcomeSetDigest(OUTCOMES));
    expect(predicate.baseline).toEqual({
      passing: 1,
      failing: 1,
      skipped: 0,
      outcomes: {
        name: "outcomes",
        mediaType: "application/json",
        digest: { sha256: outcomeSetDigest(OUTCOMES).slice("sha256:".length) },
      },
    });
    expect(predicate.window).toEqual({
      startedAt: "2026-07-31T09:00:00.000Z",
      endedAt: "2026-07-31T09:25:00.000Z",
    });
    expect(predicate.failure).toBeUndefined();

    // Fresh container per run, one pull.
    expect(new Set(runtime.containerIds).size).toBe(5);
    // The outcome map is stored, byte-for-byte canonical.
    expect(artifactStore.bytes.get(outcomeSetDigest(OUTCOMES)))
      .toEqual(canonicalOutcomeSetBytes(OUTCOMES));

    const envelope = parseDsseEnvelope(attestation.envelopeBytes);
    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(attestation.attestationDigest).toBe(recordDigest(attestation.envelopeBytes));
  });

  it("refuses K below the profile minimum before touching any port", async () => {
    const runtime = scriptedRuntime([OUTCOMES]);
    await expect(verifyEnvironment(
      {
        containerRuntime: runtime,
        artifactStore: memoryStore(),
        signer,
        clock: fixedClock(),
        verifier: VERIFIER,
      },
      RECORD,
      { runCount: 4 },
    )).rejects.toThrow(/at least 5 runs/u);
    expect(runtime.containerIds).toHaveLength(0);
  });

  it("fails closed when the artifact store returns a digest it did not compute", async () => {
    const lying: ArtifactStore = {
      async putArtifact(bytes) {
        return { digest: `sha256:${"f".repeat(64)}`, size: bytes.length };
      },
    };
    await expect(verifyEnvironment(
      {
        containerRuntime: scriptedRuntime([OUTCOMES]),
        artifactStore: lying,
        signer,
        clock: fixedClock(),
        verifier: VERIFIER,
      },
      RECORD,
    )).rejects.toThrow(/Artifact store returned/u);
  });
});

describe("verifyEnvironment — negative attestations are first-class", () => {
  const DIVERGENT: OutcomeSet = {
    "tests/test_a.py::test_one": "pass",
    "tests/test_b.py::test_two": "pass",
  };

  function deps(runtime: ContainerRuntime, artifactStore = memoryStore()) {
    return { containerRuntime: runtime, artifactStore, signer, clock: fixedClock(), verifier: VERIFIER };
  }

  it("signs an unstable attestation when run 3 of 5 diverges", async () => {
    const runtime = scriptedRuntime([OUTCOMES, OUTCOMES, DIVERGENT, OUTCOMES, OUTCOMES]);
    const store = memoryStore();
    const attestation = await verifyEnvironment(deps(runtime, store), RECORD);
    const { predicate } = attestation.statement;

    expect(predicate.result).toBe("unstable");
    expect(predicate.failure?.stage).toBe("compare");
    expect(predicate.failure?.reason).toBe("outcome-set-divergence");
    expect(predicate.failure?.divergence?.referenceRunIndex).toBe(0);
    expect(predicate.failure?.divergence?.divergentRuns).toEqual([{
      index: 2,
      outcomeSetDigest: outcomeSetDigest(DIVERGENT),
      outcomes: {
        name: "outcomes",
        mediaType: "application/json",
        digest: { sha256: outcomeSetDigest(DIVERGENT).slice("sha256:".length) },
      },
    }]);
    // Both outcome sets are retrievable, so a third party can re-compare them.
    expect(store.bytes.has(outcomeSetDigest(OUTCOMES))).toBe(true);
    expect(store.bytes.has(outcomeSetDigest(DIVERGENT))).toBe(true);
    expect(predicate.runs?.count).toBe(5);
  });

  it("signs an error attestation when the image has vanished", async () => {
    const runtime: ContainerRuntime = {
      async pullByDigest() {
        throw new Error("manifest unknown");
      },
      async runContainer() {
        throw new Error("unreachable");
      },
    };
    const attestation = await verifyEnvironment(deps(runtime), RECORD);
    const { predicate } = attestation.statement;

    expect(predicate.result).toBe("error");
    expect(predicate.failure).toEqual({
      stage: "acquire",
      reason: "image-unresolvable",
      detail: "manifest unknown",
    });
    expect(predicate.runs).toBeUndefined();
    expect(predicate.baseline).toBeUndefined();
    expect(predicate.runtime).toEqual({ timeoutSeconds: 1800 });
    expect(predicate.window.startedAt).toBe("2026-07-31T09:00:00.000Z");
    expect(attestation.containerIds).toEqual([]);
  });

  it("signs an error attestation when the registry resolves a different digest", async () => {
    const runtime: ContainerRuntime = {
      async pullByDigest() {
        return { resolvedManifestDigest: `sha256:${"9".repeat(64)}` as Sha256Digest };
      },
      async runContainer() {
        throw new Error("unreachable");
      },
    };
    const { predicate } = (await verifyEnvironment(deps(runtime), RECORD)).statement;
    expect(predicate.result).toBe("error");
    expect(predicate.failure?.reason).toBe("image-digest-mismatch");
    expect(predicate.failure?.stage).toBe("acquire");
  });

  it("signs an error attestation for an install failure and for an empty outcome set", async () => {
    const installFailure: ContainerRuntime = {
      async pullByDigest(request) {
        return { resolvedManifestDigest: request.manifestDigest };
      },
      async runContainer() {
        return {
          containerId: "container-0",
          installExitCodes: [0, 127],
          testExitCodes: [],
          outcomes: {},
          wallSeconds: 1,
          timedOut: false,
        };
      },
    };
    const install = (await verifyEnvironment(deps(installFailure), RECORD)).statement;
    expect(install.predicate.failure?.reason).toBe("install-command-failed");
    expect(install.predicate.failure?.stage).toBe("install");

    const emptyOutcomes: ContainerRuntime = {
      async pullByDigest(request) {
        return { resolvedManifestDigest: request.manifestDigest };
      },
      async runContainer() {
        return {
          containerId: "container-0",
          installExitCodes: [],
          testExitCodes: [0],
          outcomes: {},
          wallSeconds: 1,
          timedOut: false,
        };
      },
    };
    const empty = (await verifyEnvironment(deps(emptyOutcomes), RECORD)).statement;
    expect(empty.predicate.failure?.reason).toBe("parser-produced-no-outcomes");
    expect(empty.predicate.failure?.stage).toBe("run");
  });

  it("never throws for an environment fact — every path returns a signed envelope", async () => {
    for (const runtime of [
      scriptedRuntime([OUTCOMES, DIVERGENT, OUTCOMES, OUTCOMES, OUTCOMES]),
      {
        async pullByDigest() { throw new Error("gone"); },
        async runContainer() { throw new Error("unreachable"); },
      } as ContainerRuntime,
    ]) {
      const attestation = await verifyEnvironment(deps(runtime), RECORD);
      expect(parseDsseEnvelope(attestation.envelopeBytes).signatures).toHaveLength(1);
    }
  });
});
