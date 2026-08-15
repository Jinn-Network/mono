// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { canonicalJsonBytes, sha256Digest } from "./bytes.js";
import {
  createBuiltinDerivationDetectors,
  normalizeDetectorFindings,
  retainedBuiltinSurfaceCount,
} from "./detectors/index.js";
import {
  builtinDetectorImplementationDigest,
  DETERMINISTIC_PUBLIC_RECIPE,
} from "./detectors/recipe.js";
import type {
  DerivationDetectorDescriptor,
  DerivationFinding,
  DerivationSurface,
} from "./types.js";

const surface = (text: string): DerivationSurface => ({
  surfaceId: "artifact:test:text",
  sourceEntityId: "test",
  role: "other",
  mediaType: "text/plain",
  codec: "text",
  location: "",
  text,
});

const privateConfiguration = {
  schemaVersion: "jinn.private-detector-configuration.v1" as const,
  nonce: "0123456789abcdef0123456789abcdef",
  knownIdentities: ["Ada Example"],
  privateAllowlist: ["operator.internal.example"],
};

describe("built-in detectors", () => {
  test.each([
    ["hello ada@example.invalid", "email"],
    ["path /home/example-user/work", "absolute-path"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz1234567890", "credential"],
    ["https://user:password@example.invalid", "url-credential"],
    [`private key ${"a".repeat(64)}`, "funds-controlling-secret"],
    ["A=one\nB=two\nC=three", "environment-dump"],
    ["Author: Ada Example <ada@example.invalid>", "git-identity"],
    ["Ada Example", "known-identity"],
    [`0x${"a".repeat(40)}`, "wallet-address"],
    ["4111 1111 1111 1111", "payment-instrument"],
    ["connect 8.8.8.8", "ip-address"],
    ["hostname: operator-box", "machine-identity"],
  ])("detects %s as %s", async (text, expectedClass) => {
    const detectors = createBuiltinDerivationDetectors({
      privateConfiguration,
    });
    const findings = (
      await Promise.all(detectors.map((detector) => detector.detect(surface(text))))
    ).flat();
    expect(findings.map((finding) => finding.class)).toContain(expectedClass);
    expect(JSON.stringify(findings)).not.toContain(text);
  });

  test("commits to private configuration without exposing it", () => {
    const [detector] = createBuiltinDerivationDetectors({
      privateConfiguration,
    });
    const serialized = JSON.stringify(detector!.descriptor);
    expect(serialized).not.toContain("Ada Example");
    expect(serialized).not.toContain(privateConfiguration.nonce);
    expect(detector!.descriptor.configurationDigest).toBe(
      sha256Digest(
        canonicalJsonBytes({
          schemaVersion: privateConfiguration.schemaVersion,
          nonce: privateConfiguration.nonce,
          knownIdentities: privateConfiguration.knownIdentities,
          privateAllowlist: privateConfiguration.privateAllowlist,
        }),
      ),
    );
  });

  test("rejects short nonces", () => {
    expect(() =>
      createBuiltinDerivationDetectors({
        privateConfiguration: { ...privateConfiguration, nonce: "too-short" },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_DERIVATION_INPUT" }));
  });

  test.each([
    ["knownIdentities", [123]],
    ["knownIdentities", [""]],
    ["privateAllowlist", [123]],
    ["privateAllowlist", [""]],
  ] as const)("rejects invalid private configuration %s entries", (key, value) => {
    expect(() =>
      createBuiltinDerivationDetectors({
        privateConfiguration: {
          ...privateConfiguration,
          [key]: value,
        } as typeof privateConfiguration,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_DERIVATION_INPUT" }));
  });

  test("content-binds every public recipe semantic used by the pattern detector", () => {
    const detectors = createBuiltinDerivationDetectors({
      privateConfiguration,
    });
    expect(detectors[1]!.descriptor.implementationDigest).toBe(
      builtinDetectorImplementationDigest(
        "deterministic-patterns",
        DETERMINISTIC_PUBLIC_RECIPE,
      ),
    );
    const mutated = structuredClone(DETERMINISTIC_PUBLIC_RECIPE);
    (
      mutated.patterns.email as {
        class: string;
      }
    ).class = "credential";
    expect(
      builtinDetectorImplementationDigest("deterministic-patterns", mutated),
    ).not.toBe(detectors[1]!.descriptor.implementationDigest);
  });

  test.each([
    ["known identity", 0],
    ["deterministic patterns", 1],
  ] as const)(
    "releases the %s surface after success and operational cancellation",
    async (_name, detectorIndex) => {
      const detector = createBuiltinDerivationDetectors({
        privateConfiguration,
      })[detectorIndex]!;
      const retainedSurfaceCount = (): number =>
        retainedBuiltinSurfaceCount(detector);

      const successful = detector.detect(surface("Ada Example"));
      expect(retainedSurfaceCount()).toBe(1);
      await successful;
      expect(retainedSurfaceCount()).toBe(0);

      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await expect(
        detector.detect(surface("Ada Example"), {
          signal: alreadyAborted.signal,
        }),
      ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
      expect(retainedSurfaceCount()).toBe(0);

      const inFlight = new AbortController();
      const pending = detector.detect(surface("Ada Example"), {
        signal: inFlight.signal,
      });
      expect(retainedSurfaceCount()).toBe(1);
      inFlight.abort();
      await expect(pending).rejects.toMatchObject({
        code: "OPERATION_ABORTED",
      });
      expect(retainedSurfaceCount()).toBe(0);
    },
  );

  test.each([
    ["known identity", 0],
    ["deterministic patterns", 1],
  ] as const)(
    "counts overlapping same-surface %s success and cancellation independently",
    async (_name, detectorIndex) => {
      const detector = createBuiltinDerivationDetectors({
        privateConfiguration,
      })[detectorIndex]!;
      const sharedSurface = surface("Ada Example");
      const controller = new AbortController();

      const successful = detector.detect(sharedSurface);
      const cancelled = detector.detect(sharedSurface, {
        signal: controller.signal,
      });
      expect(retainedBuiltinSurfaceCount(detector)).toBe(2);

      controller.abort();
      await expect(cancelled).rejects.toMatchObject({
        code: "OPERATION_ABORTED",
      });
      await successful;
      expect(retainedBuiltinSurfaceCount(detector)).toBe(0);
    },
  );
});

describe("finding normalization", () => {
  const descriptor: DerivationDetectorDescriptor = {
    id: "test",
    version: "1",
    implementationDigest: `sha256:${"a".repeat(64)}`,
    reproducibility: "byte-stable",
  };

  const finding = (
    overrides: Partial<DerivationFinding> = {},
  ): DerivationFinding => ({
    class: "email",
    confidence: "HIGH",
    surfaceId: "artifact:test:text",
    start: 0,
    end: 3,
    evidence: ["email-shape"],
    detector: descriptor,
    ...overrides,
  });

  test("rejects invalid surface ids and offsets", () => {
    expect(() =>
      normalizeDetectorFindings(surface("abc"), [
        finding({ surfaceId: "other" }),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "DETECTOR_CONTRACT_VIOLATION" }),
    );
    expect(() =>
      normalizeDetectorFindings(surface("abc"), [finding({ end: 4 })]),
    ).toThrowError(
      expect.objectContaining({ code: "DETECTOR_CONTRACT_VIOLATION" }),
    );
  });

  test.each([
    ["fractional start", { start: 0.5 }],
    ["fractional end", { end: 2.5 }],
    ["negative start", { start: -1 }],
    ["empty span", { start: 1, end: 1 }],
    ["reversed span", { start: 2, end: 1 }],
    ["out-of-range end", { end: 4 }],
  ] as const)("rejects a %s", (_name, offsets) => {
    expect(() =>
      normalizeDetectorFindings(surface("abc"), [finding(offsets)]),
    ).toThrowError(
      expect.objectContaining({ code: "DETECTOR_CONTRACT_VIOLATION" }),
    );
  });

  test.each([
    ["start", { start: 1, end: 2 }],
    ["end", { start: 0, end: 1 }],
  ] as const)(
    "rejects a finding whose %s boundary splits a valid surrogate pair",
    (_name, offsets) => {
      expect(() =>
        normalizeDetectorFindings(surface("😀"), [finding(offsets)]),
      ).toThrowError(
        expect.objectContaining({ code: "DETECTOR_CONTRACT_VIOLATION" }),
      );
    },
  );

  test("normalizes exact UTF-16 spans after and around astral characters", () => {
    expect(
      normalizeDetectorFindings(surface("😀abc"), [
        finding({ start: 2, end: 5 }),
        finding({ start: 0, end: 2, class: "credential" }),
      ]),
    ).toEqual([
      finding({ start: 0, end: 2, class: "credential" }),
      finding({ start: 2, end: 5 }),
    ]);
  });

  test("rejects matched plaintext in evidence", () => {
    expect(() =>
      normalizeDetectorFindings(surface("abc"), [
        finding({ evidence: ["abc"] }),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "DETECTOR_CONTRACT_VIOLATION" }),
    );
  });

  test("rejects matched plaintext reflected through the semantic class", () => {
    expect(() =>
      normalizeDetectorFindings(surface("secret"), [
        finding({ class: "secret", end: 6 }),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "DETECTOR_CONTRACT_VIOLATION" }),
    );
  });

  test("deduplicates and sorts normalized findings", () => {
    const second = finding({ class: "credential", start: 1, end: 2 });
    expect(
      normalizeDetectorFindings(surface("abc"), [second, finding(), finding()]),
    ).toEqual([finding(), second]);
  });
});
