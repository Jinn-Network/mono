// SPDX-License-Identifier: Apache-2.0

// The published conformance kit. `node:fs/promises` appears here (fixture
// loading only) and is allowlisted for this file in the tree guard.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  parseDsseEnvelope,
  recordDigest,
  type DsseSigner,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { buildConformanceRecord } from "./import-source.js";
import { canonicalOutcomeSetBytes, outcomeSetDigest, type OutcomeSet } from "./outcome-set.js";
import type { ArtifactStore, Clock, ContainerRuntime } from "./ports.js";
import type { VerifierIdentity } from "./predicate.js";
import { parseEnvironmentVerificationStatement } from "./statement.js";
import { verifyEnvironment, type VerifyEnvironmentOptions } from "./verify.js";

export const CONFORMANCE_OUTCOMES: OutcomeSet = Object.freeze({
  "tests/test_alpha.py::test_one": "pass",
  "tests/test_alpha.py::test_two": "fail",
  "tests/test_beta.py::test_three": "skip",
}) as OutcomeSet;

/** Run 3's outcomes in the flaky scenario: test_two flips to pass. */
export const CONFORMANCE_DIVERGENT_OUTCOMES: OutcomeSet = Object.freeze({
  "tests/test_alpha.py::test_one": "pass",
  "tests/test_alpha.py::test_two": "pass",
  "tests/test_beta.py::test_three": "skip",
}) as OutcomeSet;

export const CONFORMANCE_VERIFIER_IDENTITY: VerifierIdentity = Object.freeze({
  id: "https://jinn.network/environment-verification/conformance-verifier",
  version: "0.1.0",
  digest: `sha256:${"7".repeat(64)}`,
}) as VerifierIdentity;

export type ScriptedScenario =
  | { readonly kind: "stable" }
  | { readonly kind: "flaky-on-run-3" }
  | { readonly kind: "vanishing-image" };

export interface ScriptedContainerRuntime extends ContainerRuntime {
  /** Container ids handed out, in run order. Distinct ids prove each run got a
   * fresh container. */
  readonly containerIds: readonly string[];
  readonly pullCount: number;
}

/**
 * A fake container runtime with scripted outcomes. It touches nothing: no
 * registry, no daemon, no disk.
 */
export function createScriptedContainerRuntime(
  scenario: ScriptedScenario,
): ScriptedContainerRuntime {
  const containerIds: string[] = [];
  let pullCount = 0;
  let runIndex = 0;

  return {
    get containerIds() {
      return containerIds;
    },
    get pullCount() {
      return pullCount;
    },
    async pullByDigest(request) {
      pullCount += 1;
      if (scenario.kind === "vanishing-image") {
        throw new Error("manifest unknown: manifest tagged by digest not found");
      }
      return { resolvedManifestDigest: request.manifestDigest };
    },
    async runContainer() {
      const containerId = `conformance-container-${runIndex}`;
      containerIds.push(containerId);
      const diverges = scenario.kind === "flaky-on-run-3" && runIndex === 2;
      const wallSeconds = 100 + runIndex;
      runIndex += 1;
      return {
        containerId,
        installExitCodes: [],
        testExitCodes: [1],
        outcomes: diverges ? CONFORMANCE_DIVERGENT_OUTCOMES : CONFORMANCE_OUTCOMES,
        wallSeconds,
        timedOut: false,
      };
    },
  };
}

export interface InMemoryArtifactStore extends ArtifactStore {
  readonly artifacts: ReadonlyMap<Sha256Digest, Uint8Array>;
}

export function createInMemoryArtifactStore(): InMemoryArtifactStore {
  const artifacts = new Map<Sha256Digest, Uint8Array>();
  return {
    artifacts,
    async putArtifact(bytes) {
      const digest = recordDigest(bytes);
      artifacts.set(digest, bytes);
      return { digest, size: bytes.length };
    },
  };
}

/** A clock that yields the window's start, then its end, then repeats the end. */
export function createFixedClock(
  startedAt = "2026-07-31T09:00:00.000Z",
  endedAt = "2026-07-31T09:25:00.000Z",
): Clock {
  const instants = [new Date(startedAt), new Date(endedAt)];
  let index = 0;
  return { now: () => instants[Math.min(index++, instants.length - 1)]! };
}

const FIXTURE_ROOT = new URL("../fixtures/", import.meta.url);

export type GoldenStatementName = "stable" | "unstable-divergence" | "error-acquire";

export async function loadGoldenStatement(name: GoldenStatementName): Promise<unknown> {
  const path = fileURLToPath(new URL(`attestations-v1/${name}.json`, FIXTURE_ROOT));
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export interface EnvironmentVerificationConformanceOptions {
  /** The host's signer. The kit holds no key material of its own. */
  readonly signer: DsseSigner;
  readonly verifyOptions?: VerifyEnvironmentOptions;
}

/**
 * Runs the capability against the fake runtime for each scripted scenario and
 * asserts the exact statement it produces, byte-for-byte, against the committed
 * golden. Requires `vitest` (declared as an optional peer) running with
 * `globals: true` -- the suite functions are read off `globalThis` at call time
 * so that importing this module outside a test run (the golden generator does
 * exactly that) never pulls vitest's worker state into a plain Node process.
 */
export function describeEnvironmentVerificationConformance(
  options: EnvironmentVerificationConformanceOptions,
): void {
  const { describe, expect, it } = globalThis as unknown as typeof import("vitest");

  describe("environment verification conformance", () => {
    const record = buildConformanceRecord();

    async function run(scenario: ScriptedScenario) {
      const containerRuntime = createScriptedContainerRuntime(scenario);
      const artifactStore = createInMemoryArtifactStore();
      const attestation = await verifyEnvironment(
        {
          containerRuntime,
          artifactStore,
          signer: options.signer,
          clock: createFixedClock(),
          verifier: CONFORMANCE_VERIFIER_IDENTITY,
        },
        record,
        options.verifyOptions,
      );
      return { attestation, containerRuntime, artifactStore };
    }

    it("stable: five agreeing runs in five fresh containers", async () => {
      const { attestation, containerRuntime, artifactStore } = await run({ kind: "stable" });
      expect(attestation.statement).toEqual(await loadGoldenStatement("stable"));
      expect(new Set(containerRuntime.containerIds).size).toBe(5);
      expect(containerRuntime.pullCount).toBe(1);
      expect(artifactStore.artifacts.get(outcomeSetDigest(CONFORMANCE_OUTCOMES)))
        .toEqual(canonicalOutcomeSetBytes(CONFORMANCE_OUTCOMES));
    });

    it("flaky-on-run-3: an unstable attestation naming the divergent run", async () => {
      const { attestation, artifactStore } = await run({ kind: "flaky-on-run-3" });
      expect(attestation.statement).toEqual(await loadGoldenStatement("unstable-divergence"));
      // Both outcome sets are retrievable, so a third party can re-compare.
      expect(artifactStore.artifacts.has(outcomeSetDigest(CONFORMANCE_OUTCOMES))).toBe(true);
      expect(artifactStore.artifacts.has(outcomeSetDigest(CONFORMANCE_DIVERGENT_OUTCOMES)))
        .toBe(true);
    });

    it("vanishing-image: an error attestation with no runs and no baseline", async () => {
      const { attestation, containerRuntime } = await run({ kind: "vanishing-image" });
      expect(attestation.statement).toEqual(await loadGoldenStatement("error-acquire"));
      expect(containerRuntime.containerIds).toEqual([]);
    });

    it("signs every result: negative attestations are first-class", async () => {
      for (const scenario of [
        { kind: "stable" } as const,
        { kind: "flaky-on-run-3" } as const,
        { kind: "vanishing-image" } as const,
      ]) {
        const { attestation } = await run(scenario);
        const envelope = parseDsseEnvelope(attestation.envelopeBytes);
        expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
        expect(envelope.signatures.length).toBeGreaterThan(0);
        expect(parseEnvironmentVerificationStatement(
          JSON.parse(new TextDecoder().decode(envelope.payloadBytes)),
        )).toEqual(attestation.statement);
        expect(attestation.attestationDigest).toBe(recordDigest(attestation.envelopeBytes));
      }
    });

    it("is stable across repeated runs of the same scenario", async () => {
      const first = await run({ kind: "stable" });
      const second = await run({ kind: "stable" });
      expect(second.attestation.statement).toEqual(first.attestation.statement);
      expect(second.attestation.envelopeBytes).toEqual(first.attestation.envelopeBytes);
    });
  });
}
