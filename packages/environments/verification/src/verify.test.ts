// SPDX-License-Identifier: Apache-2.0

import { parseDsseEnvelope, recordDigest } from "@jinn-network/trust-core";
import type { DsseSigner, Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { canonicalOutcomeSetBytes, outcomeSetDigest, type OutcomeSet } from "./outcome-set.js";
import type { ArtifactStore, Clock, ContainerRuntime } from "./ports.js";
import type { VerifierIdentity } from "./predicate.js";
import { verifyEnvironment } from "./verify.js";

export const IMAGE_DIGEST = `sha256:${"c".repeat(64)}` as Sha256Digest;

const OUTCOMES: OutcomeSet = {
  "tests/test_a.py::test_one": "pass",
  "tests/test_b.py::test_two": "fail",
};

const VERIFIER: VerifierIdentity = {
  id: "https://example.test/verifier",
  version: "0.1.0",
  digest: `sha256:${"d".repeat(64)}`,
};

function stubRecord() {
  return {
    kind: "https://jinn.network/records/environment/1.0",
    source: {
      repo: "owner/name",
      repoUrl: "https://github.com/owner/name",
      commit: "0".repeat(40),
    },
    image: {
      manifestDigest: IMAGE_DIGEST,
      platform: "linux/amd64",
      reference: `registry.test/owner/name@${IMAGE_DIGEST}`,
    },
    workspace: "/testbed",
    invocations: {
      test: [{ bin: "pytest", args: ["-q", "tests"] }],
    },
    parser: {
      id: "pytest",
      version: "1.0.0",
      digest: `sha256:${"e".repeat(64)}`,
      uri: "https://example.test/parsers/pytest-1.0.0.tar.gz",
    },
    build: { reproducibilityTier: 0 },
    rights: { sourceLicense: "MIT", basis: "upstream-permissive-filter" },
  };
}

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
      stubRecord() as never,
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
      stubRecord() as never,
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
      stubRecord() as never,
    )).rejects.toThrow(/Artifact store returned/u);
  });
});
