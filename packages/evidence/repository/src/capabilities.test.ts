import { describe, expect, test } from "vitest";

import {
  assertEvidenceRepositoryCapabilities,
  assertStableImmutableEvidenceRepositoryCapabilities,
} from "./capabilities.js";

describe("internal repository capability validation", () => {
  test.each([
    null,
    [],
    1,
    "capabilities",
  ])("rejects invalid capability container %#", (capabilities) => {
    expect(() =>
      assertEvidenceRepositoryCapabilities(capabilities),
    ).toThrowError(/non-null, non-array object/u);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1024",
  ])("rejects invalid maxObjectBytes value %s", (maxObjectBytes) => {
    expect(() =>
      assertEvidenceRepositoryCapabilities({ maxObjectBytes }),
    ).toThrowError(/positive safe integer/u);
  });

  test.each([1, Number.MAX_SAFE_INTEGER])(
    "accepts valid maxObjectBytes value %s",
    (maxObjectBytes) => {
      expect(() =>
        assertEvidenceRepositoryCapabilities({ maxObjectBytes }),
      ).not.toThrow();
    },
  );

  test("accepts and preserves unknown future fields semantically", () => {
    const capabilities = Object.freeze({
      maxObjectBytes: 1,
      futureCapability: "preserved",
    });

    expect(() =>
      assertEvidenceRepositoryCapabilities(capabilities),
    ).not.toThrow();
  });

  test("accepts a stable frozen whole-object snapshot", () => {
    const capabilities = Object.freeze({
      maxObjectBytes: 1,
      futureCapability: "stable",
    });

    expect(
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toBe(capabilities);
  });

  test("rejects and restores every mutable whole-object operation", () => {
    const capabilities = {
      maxObjectBytes: 1,
      futureCapability: "stable",
    };

    expect(() =>
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toThrowError(
      /add future property.*overwrite maxObjectBytes.*overwrite futureCapability.*delete maxObjectBytes.*delete futureCapability/u,
    );
    expect(capabilities).toEqual({
      maxObjectBytes: 1,
      futureCapability: "stable",
    });
  });

  test("rejects an unstable capability object reference", () => {
    const first = Object.freeze({});
    const second = Object.freeze({});
    let reads = 0;

    expect(() =>
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => (reads++ === 0 ? first : second),
      ),
    ).toThrowError(/stable object/u);
  });

  test("rejects a stable object whose declared limit changes", () => {
    let maxObjectBytes = 0;
    const capabilities = Object.freeze({
      get maxObjectBytes() {
        maxObjectBytes += 1;
        return maxObjectBytes;
      },
    });

    expect(() =>
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toThrowError(/stable maxObjectBytes/u);
  });

  test("probes every unknown future field for immutability", () => {
    const capabilities = Object.create(null) as {
      maxObjectBytes: number;
      futureCapability: string;
      futureCapabilityTwo: string;
    };
    Object.defineProperties(capabilities, {
      maxObjectBytes: {
        configurable: false,
        enumerable: true,
        value: 1,
        writable: false,
      },
      futureCapability: {
        configurable: false,
        enumerable: true,
        value: "locked",
        writable: false,
      },
      futureCapabilityTwo: {
        configurable: true,
        enumerable: true,
        value: "mutable",
        writable: true,
      },
    });
    Object.preventExtensions(capabilities);

    expect(() =>
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toThrowError(
      /overwrite futureCapabilityTwo.*delete futureCapabilityTwo/u,
    );
    expect(capabilities.futureCapabilityTwo).toBe("mutable");
  });
});
