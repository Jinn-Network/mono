// SPDX-License-Identifier: Apache-2.0

// The published conformance kit. `node:fs/promises` appears here (fixture
// loading only) and is allowlisted for this file in the tree guard.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  dssePreAuthEncoding,
  parseDsseEnvelope,
  recordDigest,
  type DsseSigner,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { buildConformanceRecord } from "./import-source.js";
import { canonicalOutcomeSetBytes, outcomeSetDigest, type OutcomeSet } from "./outcome-set.js";
import type { ArtifactStore, Clock, ContainerRunRequest, ContainerRuntime } from "./ports.js";
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
  /** Every run request, in run order. Recorded so the kit can check that the
   * signed controls are the controls the runs actually received. */
  readonly runRequests: readonly ContainerRunRequest[];
  readonly pullCount: number;
}

/**
 * A fake container runtime with scripted outcomes. It touches nothing: no
 * registry, no container engine, no disk.
 */
export function createScriptedContainerRuntime(
  scenario: ScriptedScenario,
): ScriptedContainerRuntime {
  const containerIds: string[] = [];
  const runRequests: ContainerRunRequest[] = [];
  let pullCount = 0;
  let runIndex = 0;

  return {
    get containerIds() {
      return containerIds;
    },
    get runRequests() {
      return runRequests;
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
    async runContainer(request) {
      runRequests.push(request);
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

export interface DsseSignatureCheck {
  /** Re-derived by the kit from the sealed envelope, never taken on trust. */
  readonly preAuthEncoding: Uint8Array;
  readonly signature: Uint8Array;
  readonly keyid?: string;
}

export interface EnvironmentVerificationConformanceOptions {
  /** The host's signer. The kit holds no key material of its own. */
  readonly signer: DsseSigner;
  /**
   * Verifies one signature for the host's key type. Supplying it turns on the
   * DSSE verification leg of design §5.5: the kit re-derives the
   * pre-authentication encoding from the sealed envelope, asserts every
   * signature verifies over it, and asserts a one-byte payload edit no longer
   * does. The algorithm is the host's -- this package holds no key material and
   * cannot know it.
   */
  readonly verifySignature?: (check: DsseSignatureCheck) => boolean;
  readonly verifyOptions?: VerifyEnvironmentOptions;
}

/** Base64 -> bytes, for the signature the sealed envelope carries as text. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

    it("verifies every signature against the re-derived pre-authentication encoding",
      async function verifiesSignatures() {
        const { verifySignature } = options;
        if (verifySignature === undefined) return;
        const { attestation } = await run({ kind: "stable" });
        const envelope = parseDsseEnvelope(attestation.envelopeBytes);
        const preAuthEncoding = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);

        for (const signature of envelope.signatures) {
          expect(verifySignature({
            preAuthEncoding,
            signature: decodeBase64(signature.sig),
            ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
          })).toBe(true);
        }

        // The same signature over a one-byte-different payload must not verify:
        // otherwise the check above proves nothing about what was signed.
        const tampered = new Uint8Array(envelope.payloadBytes);
        tampered[tampered.length - 1] = (tampered[tampered.length - 1]! + 1) % 256;
        const tamperedEncoding = dssePreAuthEncoding(envelope.payloadType, tampered);
        for (const signature of envelope.signatures) {
          expect(verifySignature({
            preAuthEncoding: tamperedEncoding,
            signature: decodeBase64(signature.sig),
            ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
          })).toBe(false);
        }
      });

    it("applies the declared controls to every run request", async () => {
      const { attestation, containerRuntime } = await run({ kind: "stable" });
      const { controls } = attestation.statement.predicate;
      expect(containerRuntime.runRequests).toHaveLength(5);
      for (const request of containerRuntime.runRequests) {
        expect(request.network).toBe(controls.network);
        expect(request.order).toBe(controls.order);
        expect(request.env["LC_ALL"]).toBe(controls.locale);
        expect(request.env["LANG"]).toBe(controls.locale);
        expect(request.env["TZ"]).toBe(controls.tz);
        for (const [name, value] of Object.entries(controls.seeds)) {
          expect(request.env[name]).toBe(value);
        }
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
