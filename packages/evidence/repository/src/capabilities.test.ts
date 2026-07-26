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

  test("rejects every mutable whole-object path without mutation", () => {
    const capabilities = {
      maxObjectBytes: 1,
      futureCapability: "stable",
    };
    const before = Object.getOwnPropertyDescriptors(capabilities);
    const prototype = Object.getPrototypeOf(capabilities);

    expect(() =>
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toThrowError(
      /non-extensible.*maxObjectBytes must be non-writable.*maxObjectBytes must be non-configurable.*futureCapability must be non-writable.*futureCapability must be non-configurable/u,
    );
    expect(Object.getOwnPropertyDescriptors(capabilities)).toEqual(before);
    expect(Object.getPrototypeOf(capabilities)).toBe(prototype);
    expect(Object.isExtensible(capabilities)).toBe(true);
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

  test("rejects an accessor-backed limit without invoking it", () => {
    let getterCalls = 0;
    let setterCalls = 0;
    const capabilities = {};
    Object.defineProperty(capabilities, "maxObjectBytes", {
      configurable: false,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
      set() {
        setterCalls += 1;
      },
    });
    Object.preventExtensions(capabilities);
    const before = Object.getOwnPropertyDescriptors(capabilities);

    expect(() =>
      assertEvidenceRepositoryCapabilities(capabilities),
    ).toThrowError(/own data property/u);
    expect(getterCalls).toBe(0);
    expect(setterCalls).toBe(0);
    expect(Object.getOwnPropertyDescriptors(capabilities)).toEqual(before);
  });

  test("rejects an inherited limit without evaluating it", () => {
    let getterCalls = 0;
    const prototype = {};
    Object.defineProperty(prototype, "maxObjectBytes", {
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    const capabilities = Object.create(prototype);

    expect(() =>
      assertEvidenceRepositoryCapabilities(capabilities),
    ).toThrowError(/own data property/u);
    expect(getterCalls).toBe(0);
    expect(Object.hasOwn(capabilities, "maxObjectBytes")).toBe(false);
  });

  test("rejects unknown accessors without invoking or changing them", () => {
    let getterCalls = 0;
    let setterCalls = 0;
    const capabilities = { maxObjectBytes: 1 };
    Object.defineProperty(capabilities, "futureCapability", {
      configurable: false,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "future";
      },
      set() {
        setterCalls += 1;
      },
    });
    Object.freeze(capabilities);
    const before = Object.getOwnPropertyDescriptors(capabilities);

    expect(() =>
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toThrowError(/own data descriptor/u);
    expect(getterCalls).toBe(0);
    expect(setterCalls).toBe(0);
    expect(Object.getOwnPropertyDescriptors(capabilities)).toEqual(before);
  });

  test("rejects a defineProperty-mutable defensive proxy", () => {
    const target = {
      maxObjectBytes: 1,
      futureCapability: "mutable",
    };
    const capabilities = new Proxy(target, {
      deleteProperty: () => false,
      set: () => false,
    });

    expect(() =>
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toThrowError(/non-extensible/u);
    expect(target).toEqual({
      maxObjectBytes: 1,
      futureCapability: "mutable",
    });
    expect(
      Reflect.defineProperty(capabilities, "futureCapability", {
        value: "changed",
      }),
    ).toBe(true);
  });

  test("accepts a proxy only when reflective invariants remain provable", () => {
    const target = Object.freeze({
      maxObjectBytes: 1,
      futureCapability: "stable",
    });
    const capabilities = new Proxy(target, {});

    expect(
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toBe(capabilities);
  });

  test("rejects a frozen snapshot with a custom prototype", () => {
    const capabilities = Object.freeze(
      Object.assign(Object.create({ custom: true }), {
        maxObjectBytes: 1,
      }),
    );

    expect(() =>
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toThrowError(/plain or null prototype/u);
  });

  test("rejects an unstable prototype", () => {
    let prototypeReads = 0;
    const target = { maxObjectBytes: 1 };
    const capabilities = new Proxy(target, {
      deleteProperty: () => false,
      getPrototypeOf: () =>
        prototypeReads++ % 2 === 0 ? Object.prototype : null,
      set: () => false,
    });

    expect(() =>
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toThrowError(/stable prototype/u);
  });

  test("checks every unknown future data descriptor", () => {
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
    const before = Object.getOwnPropertyDescriptors(capabilities);

    expect(() =>
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toThrowError(
      /futureCapabilityTwo must be non-writable.*futureCapabilityTwo must be non-configurable/u,
    );
    expect(Object.getOwnPropertyDescriptors(capabilities)).toEqual(before);
  });

  test("accepts stable frozen plain and null-prototype snapshots", () => {
    const plain = Object.freeze({
      maxObjectBytes: 1,
      futureCapability: "plain",
    });
    const nullPrototype = Object.create(null) as {
      maxObjectBytes: number;
      futureCapability: string;
    };
    Object.defineProperties(nullPrototype, {
      maxObjectBytes: {
        configurable: false,
        enumerable: true,
        value: Number.MAX_SAFE_INTEGER,
        writable: false,
      },
      futureCapability: {
        configurable: false,
        enumerable: true,
        value: "null",
        writable: false,
      },
    });
    Object.preventExtensions(nullPrototype);

    expect(
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => plain,
      ),
    ).toBe(plain);
    expect(
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => nullPrototype,
      ),
    ).toBe(nullPrototype);
  });
});
