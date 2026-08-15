import { describe, expect, test } from "vitest";

import {
  assertEvidenceRepositoryCapabilitiesSlot,
  assertEvidenceRepositoryCapabilities,
  assertStableImmutableEvidenceRepositoryCapabilities,
  assertUnchangedEvidenceRepositoryCapabilitiesSlot,
} from "./capabilities.js";

const OBJECT_PROXY_TRAPS = [
  "defineProperty",
  "deleteProperty",
  "get",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "has",
  "isExtensible",
  "ownKeys",
  "preventExtensions",
  "set",
  "setPrototypeOf",
] as const;

type ObjectProxyTrap = (typeof OBJECT_PROXY_TRAPS)[number];

function createTrapCountingProxy<T extends object>(target: T): {
  readonly proxy: T;
  readonly trapCalls: Readonly<Record<ObjectProxyTrap, number>>;
} {
  const trapCalls = Object.fromEntries(
    OBJECT_PROXY_TRAPS.map((trap) => [trap, 0]),
  ) as Record<ObjectProxyTrap, number>;
  const count = (trap: ObjectProxyTrap): void => {
    trapCalls[trap] += 1;
  };
  const proxy = new Proxy(target, {
    defineProperty: (value, key, descriptor) => {
      count("defineProperty");
      return Reflect.defineProperty(value, key, descriptor);
    },
    deleteProperty: (value, key) => {
      count("deleteProperty");
      return Reflect.deleteProperty(value, key);
    },
    get: (value, key, receiver) => {
      count("get");
      return Reflect.get(value, key, receiver);
    },
    getOwnPropertyDescriptor: (value, key) => {
      count("getOwnPropertyDescriptor");
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
    getPrototypeOf: (value) => {
      count("getPrototypeOf");
      return Reflect.getPrototypeOf(value);
    },
    has: (value, key) => {
      count("has");
      return Reflect.has(value, key);
    },
    isExtensible: (value) => {
      count("isExtensible");
      return Reflect.isExtensible(value);
    },
    ownKeys: (value) => {
      count("ownKeys");
      return Reflect.ownKeys(value);
    },
    preventExtensions: (value) => {
      count("preventExtensions");
      return Reflect.preventExtensions(value);
    },
    set: (value, key, newValue, receiver) => {
      count("set");
      return Reflect.set(value, key, newValue, receiver);
    },
    setPrototypeOf: (value, prototype) => {
      count("setPrototypeOf");
      return Reflect.setPrototypeOf(value, prototype);
    },
  });

  return { proxy, trapCalls };
}

describe("internal repository capability validation", () => {
  test("rejects a capability slot replaced after repository activity", () => {
    const original = Object.freeze({ maxObjectBytes: 1 });
    const repository = { capabilities: original };

    repository.capabilities = Object.freeze({ maxObjectBytes: 1 });

    expect(() =>
      assertUnchangedEvidenceRepositoryCapabilitiesSlot(
        repository,
        original,
      ),
    ).toThrowError(/must remain unchanged for the repository lifetime/u);
  });

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

  test("rejects a present undefined maxObjectBytes field", () => {
    expect(() =>
      assertEvidenceRepositoryCapabilities({
        maxObjectBytes: undefined,
      }),
    ).toThrowError(/positive safe integer/u);
  });

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

  test.each(["shape", "stable snapshot"] as const)(
    "rejects a Proxy during %s validation without invoking traps",
    (validation) => {
      const { proxy: capabilities, trapCalls } =
        createTrapCountingProxy(
          Object.freeze({ maxObjectBytes: 1 }),
        );

      expect(() => {
        if (validation === "shape") {
          assertEvidenceRepositoryCapabilities(capabilities);
          return;
        }
        assertStableImmutableEvidenceRepositoryCapabilities(
          () => capabilities,
        );
      }).toThrowError(/Proxy/u);
      expect(trapCalls).toEqual(
        Object.fromEntries(
          OBJECT_PROXY_TRAPS.map((trap) => [trap, 0]),
        ),
      );
    },
  );

  test.each(["shape", "stable snapshot", "repository slot"] as const)(
    "rejects a Proxy prototype during %s validation without invoking traps",
    (validation) => {
      const { proxy: prototype, trapCalls } =
        createTrapCountingProxy({ maxObjectBytes: 1 });
      const capabilities = Object.freeze(Object.create(prototype));

      expect(() => {
        if (validation === "shape") {
          assertEvidenceRepositoryCapabilities(capabilities);
          return;
        }
        if (validation === "stable snapshot") {
          assertStableImmutableEvidenceRepositoryCapabilities(
            () => capabilities,
          );
          return;
        }
        assertEvidenceRepositoryCapabilitiesSlot({ capabilities });
      }).toThrowError(/prototype.*Proxy/iu);
      expect(trapCalls).toEqual(
        Object.fromEntries(
          OBJECT_PROXY_TRAPS.map((trap) => [trap, 0]),
        ),
      );
    },
  );

  test("rejects a repository Proxy before invoking any trap", () => {
    const { proxy: repository, trapCalls } = createTrapCountingProxy({
      capabilities: Object.freeze({ maxObjectBytes: 1 }),
    });

    expect(() =>
      assertEvidenceRepositoryCapabilitiesSlot(repository),
    ).toThrowError(/repository.*Proxy/iu);
    expect(trapCalls).toEqual(
      Object.fromEntries(
        OBJECT_PROXY_TRAPS.map((trap) => [trap, 0]),
      ),
    );
  });

  test("rejects a repository capability getter without invoking it", () => {
    let getterCalls = 0;
    const repository = {};
    Object.defineProperty(repository, "capabilities", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return Object.freeze({ maxObjectBytes: 1 });
      },
    });
    const before = Object.getOwnPropertyDescriptors(repository);

    expect(() =>
      assertEvidenceRepositoryCapabilitiesSlot(repository),
    ).toThrowError(/capabilities.*own data property/iu);
    expect(getterCalls).toBe(0);
    expect(Object.getOwnPropertyDescriptors(repository)).toEqual(before);
  });

  test("rejects an inherited repository capability slot without evaluation", () => {
    let getterCalls = 0;
    const prototype = {};
    Object.defineProperty(prototype, "capabilities", {
      get() {
        getterCalls += 1;
        return Object.freeze({ maxObjectBytes: 1 });
      },
    });
    const repository = Object.create(prototype);

    expect(() =>
      assertEvidenceRepositoryCapabilitiesSlot(repository),
    ).toThrowError(/capabilities.*own data property/iu);
    expect(getterCalls).toBe(0);
    expect(Object.hasOwn(repository, "capabilities")).toBe(false);
  });

  test("accepts an own writable repository capability data slot", () => {
    const capabilities = Object.freeze({ maxObjectBytes: 1 });
    const repository = { capabilities };
    const descriptor = Object.getOwnPropertyDescriptor(
      repository,
      "capabilities",
    );

    expect(descriptor).toMatchObject({
      configurable: true,
      writable: true,
    });
    expect(
      assertEvidenceRepositoryCapabilitiesSlot(repository),
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
    const previousDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "maxObjectBytes",
    );

    try {
      Object.defineProperty(Object.prototype, "maxObjectBytes", {
        configurable: true,
        get() {
          getterCalls += 1;
          return 1;
        },
      });
      const capabilities = {};

      expect(() =>
        assertEvidenceRepositoryCapabilities(capabilities),
      ).toThrowError(/own data property/u);
      expect(getterCalls).toBe(0);
      expect(Object.hasOwn(capabilities, "maxObjectBytes")).toBe(false);
    } finally {
      if (previousDescriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, "maxObjectBytes");
      } else {
        Object.defineProperty(
          Object.prototype,
          "maxObjectBytes",
          previousDescriptor,
        );
      }
    }
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
    ).toThrowError(/Proxy/u);
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

  test.each(["shape", "stable snapshot"] as const)(
    "rejects a frozen custom prototype during %s validation",
    (validation) => {
      const capabilities = Object.freeze(
        Object.assign(Object.create({ custom: true }), {
          maxObjectBytes: 1,
        }),
      );

      expect(() => {
        if (validation === "shape") {
          assertEvidenceRepositoryCapabilities(capabilities);
          return;
        }
        assertStableImmutableEvidenceRepositoryCapabilities(
          () => capabilities,
        );
      }).toThrowError(/plain or null prototype/u);
    },
  );

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
    ).toThrowError(/Proxy/u);
    expect(prototypeReads).toBe(0);
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

  test("accepts a stable frozen unknown NaN data field", () => {
    const capabilities = Object.freeze({
      maxObjectBytes: 1,
      futureCapability: Number.NaN,
    });

    expect(
      assertStableImmutableEvidenceRepositoryCapabilities(
        () => capabilities,
      ),
    ).toBe(capabilities);
    expect(Number.isNaN(capabilities.futureCapability)).toBe(true);
  });
});
