// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { expect, test } from "vitest";

import {
  createBuiltinDerivationDetectors,
  rejectNextBuiltinDetection,
  retainedBuiltinSurfaceCount,
} from "./detectors/index.js";
import {
  invokeContractDetector,
  snapshotDetectorContractSlot,
} from "./detector-contract-invocation.js";
import { createEvidenceDeriver } from "./derive.js";
import {
  createSyntheticDerivationDetectorFixtures,
  createSyntheticPrivateDetectorConfiguration,
  describeDerivationDetectorContract,
  describeEvidenceDeriverContract,
} from "./testing.js";
import type { DerivationDetectorContractContext } from "./testing.js";
import type {
  DerivationDetector,
  DerivationDetectorDescriptor,
  DerivationOperationOptions,
  DerivationSurface,
} from "./types.js";

interface ContractLifecycle {
  ambientObserverCalls: number;
  retainedObserverCalls: number;
  cleanupCalls: number;
}

const requireBuiltin = createRequire(import.meta.url);

const DETECTOR_PROXY_TRAPS = [
  "apply",
  "construct",
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

function trapCountingDetectorProxy(
  detector: DerivationDetector,
): {
  readonly detector: DerivationDetector;
  readonly trapCalls: Readonly<Record<
    (typeof DETECTOR_PROXY_TRAPS)[number],
    number
  >>;
} {
  const trapCalls = Object.fromEntries(
    DETECTOR_PROXY_TRAPS.map((trap) => [trap, 0]),
  ) as Record<(typeof DETECTOR_PROXY_TRAPS)[number], number>;
  const count = (trap: (typeof DETECTOR_PROXY_TRAPS)[number]): void => {
    trapCalls[trap] += 1;
  };
  return {
    detector: new Proxy(detector, {
      apply(target, thisArgument, argumentsList) {
        count("apply");
        return Reflect.apply(target as never, thisArgument, argumentsList);
      },
      construct(target, argumentsList, newTarget) {
        count("construct");
        return Reflect.construct(target as never, argumentsList, newTarget);
      },
      defineProperty(target, key, descriptor) {
        count("defineProperty");
        return Reflect.defineProperty(target, key, descriptor);
      },
      deleteProperty(target, key) {
        count("deleteProperty");
        return Reflect.deleteProperty(target, key);
      },
      get(target, key, receiver) {
        count("get");
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        count("getOwnPropertyDescriptor");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        count("getPrototypeOf");
        return Reflect.getPrototypeOf(target);
      },
      has(target, key) {
        count("has");
        return Reflect.has(target, key);
      },
      isExtensible(target) {
        count("isExtensible");
        return Reflect.isExtensible(target);
      },
      ownKeys(target) {
        count("ownKeys");
        return Reflect.ownKeys(target);
      },
      preventExtensions(target) {
        count("preventExtensions");
        return Reflect.preventExtensions(target);
      },
      set(target, key, value, receiver) {
        count("set");
        return Reflect.set(target, key, value, receiver);
      },
      setPrototypeOf(target, prototype) {
        count("setPrototypeOf");
        return Reflect.setPrototypeOf(target, prototype);
      },
    }),
    trapCalls,
  };
}

const CONTRACT_META_DESCRIPTOR: DerivationDetectorDescriptor = Object.freeze({
  id: "contract-meta-detector",
  version: "1.0.0",
  implementationDigest: `sha256:${"a".repeat(64)}`,
  reproducibility: "byte-stable",
});

function contractMetaDetector(
  onDetect: () => void = () => undefined,
): DerivationDetector {
  return {
    descriptor: CONTRACT_META_DESCRIPTOR,
    async detect() {
      onDetect();
      return [];
    },
  };
}

test("the detector contract kit rejects a detector Proxy without invoking traps", () => {
  let detectorCalls = 0;
  const { detector, trapCalls } = trapCountingDetectorProxy(
    contractMetaDetector(() => {
      detectorCalls += 1;
    }),
  );

  expect(() =>
    snapshotDetectorContractSlot({ detector }),
  ).toThrowError(/Detector must not be a Proxy/u);
  expect(trapCalls).toEqual(
    Object.fromEntries(DETECTOR_PROXY_TRAPS.map((trap) => [trap, 0])),
  );
  expect(detectorCalls).toBe(0);
});

test.each(["descriptor", "detect"] as const)(
  "the detector contract kit rejects an own %s accessor without evaluating it",
  (slot) => {
    let getterCalls = 0;
    let detectorCalls = 0;
    const detector = {};
    Object.defineProperties(detector, {
      descriptor: slot === "descriptor"
        ? {
            enumerable: true,
            get() {
              getterCalls += 1;
              return CONTRACT_META_DESCRIPTOR;
            },
          }
        : {
            enumerable: true,
            value: CONTRACT_META_DESCRIPTOR,
          },
      detect: slot === "detect"
        ? {
            enumerable: true,
            get() {
              getterCalls += 1;
              return async () => {
                detectorCalls += 1;
                return [];
              };
            },
          }
        : {
            enumerable: true,
            value: async () => {
              detectorCalls += 1;
              return [];
            },
          },
    });

    expect(() =>
      snapshotDetectorContractSlot({
        detector: detector as DerivationDetector,
      }),
    ).toThrowError(/own descriptor and detect data properties/u);
    expect(getterCalls).toBe(0);
    expect(detectorCalls).toBe(0);
  },
);

test("the detector contract kit accepts class and null-prototype detectors with own data slots", async () => {
  class ClassDetector implements DerivationDetector {
    readonly descriptor = CONTRACT_META_DESCRIPTOR;
    readonly detect = async (): Promise<readonly []> => [];
  }
  const nullPrototypeDetector = Object.create(null) as DerivationDetector;
  Object.defineProperties(nullPrototypeDetector, {
    descriptor: {
      enumerable: true,
      value: CONTRACT_META_DESCRIPTOR,
    },
    detect: {
      enumerable: true,
      value: async (): Promise<readonly []> => [],
    },
  });

  for (const detector of [
    new ClassDetector(),
    nullPrototypeDetector,
  ]) {
    const snapshot = snapshotDetectorContractSlot({ detector });
    expect(snapshot.descriptor).toEqual(CONTRACT_META_DESCRIPTOR);
    await expect(snapshot.detect({
      surfaceId: "contract:meta",
      sourceEntityId: "contract-meta",
      role: "other",
      mediaType: "text/plain",
      codec: "text",
      location: "",
      text: "synthetic",
    })).resolves.toEqual([]);
  }
});

function createContractLifecycle(): ContractLifecycle {
  return {
    ambientObserverCalls: 0,
    retainedObserverCalls: 0,
    cleanupCalls: 0,
  };
}

function builtinModule(id: string): Record<string, unknown> {
  const value: unknown = requireBuiltin(`node:${id}`);
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new Error(`Node built-in module ${id} is unavailable`);
  }
  return value as Record<string, unknown>;
}

function installBuiltinAmbientCanaries(): {
  readonly ambientEffectCount: () => number;
  readonly cleanup: () => void;
} {
  let ambientEffects = 0;
  let cleaned = false;
  const restorations: Array<() => void> = [];
  const fail = (label: string): never => {
    ambientEffects += 1;
    throw new Error(`Built-in detector attempted ambient ${label}`);
  };
  const installValue = (
    target: object,
    key: string,
    value: unknown,
    label: string,
  ): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || !("value" in descriptor)) {
      if (!descriptor || typeof descriptor.get !== "function") {
        throw new Error(`Cannot install ambient canary for ${label}`);
      }
      Object.defineProperty(target, key, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: true,
        value,
      });
      restorations.push(() => {
        Object.defineProperty(target, key, descriptor);
      });
      return;
    }
    Object.defineProperty(target, key, {
      ...descriptor,
      value,
    });
    restorations.push(() => {
      Object.defineProperty(target, key, descriptor);
    });
  };
  const install = (
    target: object,
    key: string,
    label: string,
  ): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (
      !descriptor ||
      ("value" in descriptor
        ? typeof descriptor.value !== "function"
        : typeof descriptor.get !== "function")
    ) {
      throw new Error(`Cannot install ambient canary for ${label}`);
    }
    installValue(
      target,
      key,
      (..._arguments: unknown[]): never => fail(label),
      label,
    );
  };
  const propertyOwner = (target: object, key: string): object => {
    for (
      let candidate: object | null = target;
      candidate !== null;
      candidate = Object.getPrototypeOf(candidate)
    ) {
      if (Object.hasOwn(candidate, key)) return candidate;
    }
    throw new Error(`Cannot find ambient canary target for ${key}`);
  };
  const installGetter = (
    target: object,
    key: string,
    label: string,
  ): void => {
    const owner = propertyOwner(target, key);
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (!descriptor || typeof descriptor.get !== "function") {
      throw new Error(`Cannot install ambient canary for ${label}`);
    }
    Object.defineProperty(owner, key, {
      ...descriptor,
      get: () => fail(label),
    });
    restorations.push(() => {
      Object.defineProperty(owner, key, descriptor);
    });
  };

  install(propertyOwner(globalThis, "fetch"), "fetch", "fetch");
  for (const [id, keys] of [
    ["http", ["request", "get"]],
    ["https", ["request", "get"]],
    ["net", ["connect", "createConnection"]],
    ["tls", ["connect"]],
    ["dgram", ["createSocket"]],
  ] as const) {
    const client = builtinModule(id);
    for (const key of keys) install(client, key, `${id}.${key}`);
  }
  const dns = builtinModule("dns");
  for (const key of [
    "lookup",
    "lookupService",
    "resolve",
    "resolve4",
    "resolve6",
    "reverse",
  ]) {
    install(dns, key, `dns.${key}`);
  }
  const dnsPromises = Reflect.get(dns, "promises");
  if (!dnsPromises || typeof dnsPromises !== "object") {
    throw new Error("Node DNS promises are unavailable");
  }
  for (const key of [
    "lookup",
    "resolve",
    "resolve4",
    "resolve6",
    "reverse",
  ]) {
    install(dnsPromises, key, `dns.promises.${key}`);
  }

  const filesystem = builtinModule("fs");
  for (const key of [
    "access",
    "accessSync",
    "appendFile",
    "appendFileSync",
    "chmod",
    "chmodSync",
    "chown",
    "chownSync",
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "createReadStream",
    "createWriteStream",
    "existsSync",
    "fstat",
    "fstatSync",
    "link",
    "linkSync",
    "lstat",
    "lstatSync",
    "mkdir",
    "mkdirSync",
    "open",
    "openSync",
    "opendir",
    "opendirSync",
    "read",
    "readFile",
    "readFileSync",
    "readlink",
    "readlinkSync",
    "readdir",
    "readdirSync",
    "readSync",
    "realpath",
    "realpathSync",
    "rename",
    "renameSync",
    "rm",
    "rmSync",
    "rmdir",
    "rmdirSync",
    "symlink",
    "symlinkSync",
    "stat",
    "statSync",
    "truncate",
    "truncateSync",
    "unlink",
    "unlinkSync",
    "utimes",
    "utimesSync",
    "writeFile",
    "writeFileSync",
  ]) {
    install(filesystem, key, `fs.${key}`);
  }
  const filesystemPromises = Reflect.get(filesystem, "promises");
  if (!filesystemPromises || typeof filesystemPromises !== "object") {
    throw new Error("Node filesystem promises are unavailable");
  }
  for (const key of [
    "access",
    "appendFile",
    "chmod",
    "chown",
    "copyFile",
    "cp",
    "link",
    "lstat",
    "mkdir",
    "open",
    "opendir",
    "readFile",
    "readlink",
    "readdir",
    "realpath",
    "rename",
    "rm",
    "rmdir",
    "symlink",
    "stat",
    "truncate",
    "unlink",
    "utimes",
    "writeFile",
  ]) {
    install(filesystemPromises, key, `fs.promises.${key}`);
  }

  install(process, "cwd", "process.cwd");
  const hrtimeCanary = Object.assign(
    (..._arguments: unknown[]): never => fail("process.hrtime"),
    {
      bigint: (): never => fail("process.hrtime.bigint"),
    },
  );
  installValue(process, "hrtime", hrtimeCanary, "process.hrtime");
  install(process, "uptime", "process.uptime");
  const environment = process.env;
  installValue(
    process,
    "env",
    new Proxy(environment, {
      deleteProperty: () => fail("process.env"),
      get: () => fail("process.env"),
      getOwnPropertyDescriptor: () => fail("process.env"),
      has: () => fail("process.env"),
      ownKeys: () => fail("process.env"),
      set: () => fail("process.env"),
    }),
    "process.env",
  );

  const operatingSystem = builtinModule("os");
  for (const key of ["homedir", "hostname", "userInfo"]) {
    install(operatingSystem, key, `os.${key}`);
  }

  const crypto = builtinModule("crypto");
  for (const key of [
    "randomBytes",
    "randomFill",
    "randomFillSync",
    "randomInt",
    "randomUUID",
  ]) {
    install(crypto, key, `crypto.${key}`);
  }
  const webCryptoPrototype = Object.getPrototypeOf(globalThis.crypto);
  install(
    webCryptoPrototype,
    "getRandomValues",
    "crypto.getRandomValues",
  );
  install(webCryptoPrototype, "randomUUID", "crypto.randomUUID");

  const dateConstructor = Date;
  install(dateConstructor, "now", "Date.now");
  installValue(
    globalThis,
    "Date",
    new Proxy(dateConstructor, {
      apply: (): never => fail("Date()"),
      construct: (): never => fail("new Date()"),
    }),
    "Date constructor",
  );
  install(
    propertyOwner(globalThis.performance, "now"),
    "now",
    "performance.now",
  );
  installGetter(
    globalThis.performance,
    "timeOrigin",
    "performance.timeOrigin",
  );
  install(Math, "random", "randomness");

  const moduleBuiltin = builtinModule("module");
  const syncBuiltinEsmExports = Reflect.get(
    moduleBuiltin,
    "syncBuiltinESMExports",
  );
  if (typeof syncBuiltinEsmExports !== "function") {
    throw new Error("Node built-in export synchronization is unavailable");
  }
  const synchronizeBuiltinExports = (): void => {
    Reflect.apply(syncBuiltinEsmExports, undefined, []);
  };
  synchronizeBuiltinExports();

  return {
    ambientEffectCount: () => ambientEffects,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      for (const restore of restorations.reverse()) restore();
      synchronizeBuiltinExports();
    },
  };
}

function createBuiltinContractContext(
  detectorIndex: number,
  lifecycle: ContractLifecycle,
): DerivationDetectorContractContext {
  const canaries = installBuiltinAmbientCanaries();
  try {
    const detector = createBuiltinDerivationDetectors({
      privateConfiguration,
    })[detectorIndex]!;
    return {
      detector,
      ambientEffectCount: () => {
        lifecycle.ambientObserverCalls += 1;
        return canaries.ambientEffectCount();
      },
      retainedSurfaceCount: () => {
        lifecycle.retainedObserverCalls += 1;
        return retainedBuiltinSurfaceCount(detector);
      },
      cleanup: () => {
        lifecycle.cleanupCalls += 1;
        canaries.cleanup();
      },
    };
  } catch (error) {
    canaries.cleanup();
    throw error;
  }
}

const privateConfiguration = createSyntheticPrivateDetectorConfiguration();

describeEvidenceDeriverContract((detectors) =>
  createEvidenceDeriver({
    detectors:
      detectors ??
      createBuiltinDerivationDetectors({ privateConfiguration }),
  }),
);

const builtinDetectors = (() => {
  const canaries = installBuiltinAmbientCanaries();
  try {
    return createBuiltinDerivationDetectors({
      privateConfiguration,
    });
  } finally {
    canaries.cleanup();
  }
})();
const fixtures = createSyntheticDerivationDetectorFixtures();
const knownIdentityLifecycle = createContractLifecycle();
const deterministicPatternsLifecycle = createContractLifecycle();

function mutableContractSurface(): DerivationSurface {
  return {
    ...fixtures.deterministicPatterns[0]!.surface,
  };
}

function mutationProbeContext(
  detect: DerivationDetector["detect"],
): DerivationDetectorContractContext {
  return {
    detector: {
      descriptor: builtinDetectors[1]!.descriptor,
      detect,
    },
    ambientEffectCount: () => 0,
    retainedSurfaceCount: () => 0,
  };
}

test("the detector contract catches input mutation on a repeated fulfillment", async () => {
  const surface = mutableContractSurface();
  let calls = 0;
  const context = mutationProbeContext(async (input) => {
    calls += 1;
    if (calls === 2) {
      (input as { text: string }).text = "mutated on second fulfillment";
    }
    return [];
  });

  await invokeContractDetector(context, surface);
  await expect(invokeContractDetector(context, surface)).rejects.toThrow(
    /mutated its input surface/u,
  );
});

test("the detector contract catches input mutation on a repeated rejection", async () => {
  const surface = mutableContractSurface();
  let calls = 0;
  const context = mutationProbeContext(async (input) => {
    calls += 1;
    if (calls === 2) {
      (input as { text: string }).text = "mutated on second rejection";
      throw new Error("synthetic operational rejection");
    }
    return [];
  });

  await invokeContractDetector(context, surface);
  await expect(invokeContractDetector(context, surface)).rejects.toThrow(
    /mutated its input surface/u,
  );
});

test("the detector contract catches input mutation during cancellation", async () => {
  const surface = mutableContractSurface();
  const context = mutationProbeContext(
    async (input, options?: DerivationOperationOptions) => {
      if (options?.signal?.aborted) {
        (input as { text: string }).text = "mutated during cancellation";
        throw Object.assign(new Error("synthetic cancellation"), {
          code: "OPERATION_ABORTED",
        });
      }
      return [];
    },
  );
  const controller = new AbortController();
  controller.abort();

  await expect(
    invokeContractDetector(context, surface, {
      signal: controller.signal,
    }),
  ).rejects.toThrow(/mutated its input surface/u);
});

test("synthetic detector surfaces carry unique private markers", () => {
  const surfaces = [
    ...fixtures.knownIdentity,
    ...fixtures.deterministicPatterns,
  ].map(({ surface }) => surface.text);
  const markers = surfaces.map((text) =>
    text.match(/\bprivate marker ([a-z]+)\b/u)?.[0]
  );
  expect(markers.every((marker) => marker !== undefined)).toBe(true);
  expect(new Set(markers).size).toBe(surfaces.length);
});

test("ambient canaries fail every prohibited effect category", () => {
  const canaries = installBuiltinAmbientCanaries();
  try {
    expect(() => globalThis.fetch("https://example.invalid")).toThrow(
      /ambient fetch/u,
    );
    expect(() =>
      Reflect.apply(
        Reflect.get(builtinModule("http"), "get") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        ["https://example.invalid"],
      )
    ).toThrow(/ambient http\.get/u);
    expect(() =>
      Reflect.apply(
        Reflect.get(builtinModule("fs"), "writeFileSync") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        ["/never-written", "private"],
      )
    ).toThrow(/ambient fs\.writeFileSync/u);
    expect(() => Date.now()).toThrow(/ambient Date\.now/u);
    expect(() => new Date()).toThrow(/ambient new Date\(\)/u);
    expect(() => globalThis.performance.now()).toThrow(
      /ambient performance\.now/u,
    );
    expect(() => process.hrtime()).toThrow(/ambient process\.hrtime/u);
    expect(() => Math.random()).toThrow(/ambient randomness/u);
    expect(canaries.ambientEffectCount()).toBe(8);
  } finally {
    canaries.cleanup();
  }
});

test.each([
  [
    "filesystem reads",
    /ambient fs\.readFileSync/u,
    () =>
      Reflect.apply(
        Reflect.get(builtinModule("fs"), "readFileSync") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        [undefined],
      ),
  ],
  [
    "filesystem read streams",
    /ambient fs\.createReadStream/u,
    () =>
      Reflect.apply(
        Reflect.get(builtinModule("fs"), "createReadStream") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        [undefined],
      ),
  ],
  [
    "filesystem stat",
    /ambient fs\.statSync/u,
    () =>
      Reflect.apply(
        Reflect.get(builtinModule("fs"), "statSync") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        [undefined],
      ),
  ],
  [
    "filesystem directory reads",
    /ambient fs\.readdirSync/u,
    () =>
      Reflect.apply(
        Reflect.get(builtinModule("fs"), "readdirSync") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        [undefined],
      ),
  ],
  [
    "process environment reads",
    /ambient process\.env/u,
    () => Reflect.get(process.env, "JINN_DERIVATION_CANARY"),
  ],
  [
    "process working-directory reads",
    /ambient process\.cwd/u,
    () => process.cwd(),
  ],
  [
    "operating-system home discovery",
    /ambient os\.homedir/u,
    () =>
      Reflect.apply(
        Reflect.get(builtinModule("os"), "homedir") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        [],
      ),
  ],
  [
    "operating-system hostname discovery",
    /ambient os\.hostname/u,
    () =>
      Reflect.apply(
        Reflect.get(builtinModule("os"), "hostname") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        [],
      ),
  ],
  [
    "operating-system user discovery",
    /ambient os\.userInfo/u,
    () =>
      Reflect.apply(
        Reflect.get(builtinModule("os"), "userInfo") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        [],
      ),
  ],
  [
    "DNS clients",
    /ambient dns\.lookup/u,
    () =>
      Reflect.apply(
        Reflect.get(builtinModule("dns"), "lookup") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        [undefined],
      ),
  ],
  [
    "cryptographic randomness",
    /ambient crypto\.randomBytes/u,
    () =>
      Reflect.apply(
        Reflect.get(builtinModule("crypto"), "randomBytes") as (
          ...arguments_: unknown[]
        ) => unknown,
        undefined,
        [1],
      ),
  ],
  [
    "wall-clock construction",
    /ambient new Date\(\)/u,
    () => new Date(),
  ],
  [
    "wall-clock function calls",
    /ambient Date\(\)/u,
    () => Reflect.apply(Date, undefined, []),
  ],
  [
    "monotonic clock reads",
    /ambient performance\.now/u,
    () => globalThis.performance.now(),
  ],
  [
    "clock-origin reads",
    /ambient performance\.timeOrigin/u,
    () => Reflect.get(globalThis.performance, "timeOrigin"),
  ],
  [
    "high-resolution clock reads",
    /ambient process\.hrtime/u,
    () => process.hrtime(),
  ],
  [
    "high-resolution bigint clock reads",
    /ambient process\.hrtime\.bigint/u,
    () => process.hrtime.bigint(),
  ],
  [
    "process uptime clock reads",
    /ambient process\.uptime/u,
    () => process.uptime(),
  ],
] as const)(
  "ambient canaries directly reject %s",
  (_name, expected, operation) => {
    const canaries = installBuiltinAmbientCanaries();
    try {
      expect(operation).toThrow(expected);
      expect(canaries.ambientEffectCount()).toBe(1);
    } finally {
      canaries.cleanup();
    }
  },
);

describeDerivationDetectorContract(
  () =>
    createBuiltinContractContext(
      0,
      knownIdentityLifecycle,
    ),
  fixtures.knownIdentity,
);
describeDerivationDetectorContract(
  () =>
    createBuiltinContractContext(
      1,
      deterministicPatternsLifecycle,
    ),
  fixtures.deterministicPatterns,
);

test.each([
  ["known identity", 0, fixtures.knownIdentity[0]!.surface],
  [
    "deterministic patterns",
    1,
    fixtures.deterministicPatterns[0]!.surface,
  ],
] as const)(
  "the %s detector releases observers after a non-abort operational rejection",
  async (_name, detectorIndex, surface) => {
    const context = createBuiltinContractContext(
      detectorIndex,
      createContractLifecycle(),
    );
    try {
      expect(context.ambientEffectCount()).toBe(0);
      expect(context.retainedSurfaceCount()).toBe(0);
      rejectNextBuiltinDetection(context.detector);
      await expect(context.detector.detect(surface)).rejects.toThrow(
        /synthetic operational rejection/u,
      );
      expect(context.ambientEffectCount()).toBe(0);
      expect(context.retainedSurfaceCount()).toBe(0);
    } finally {
      await context.cleanup?.();
    }
  },
);

test.each([
  [
    "known identity",
    knownIdentityLifecycle,
    fixtures.knownIdentity.length,
  ],
  [
    "deterministic patterns",
    deterministicPatternsLifecycle,
    fixtures.deterministicPatterns.length,
  ],
] as const)(
  "the %s contract observes every invocation and cleans every case",
  (_name, lifecycle, fixtureCount) => {
    const detectorInvocations = 2 * fixtureCount + 3;
    expect(lifecycle.ambientObserverCalls).toBe(
      detectorInvocations * 2,
    );
    expect(lifecycle.retainedObserverCalls).toBe(
      detectorInvocations * 2,
    );
    expect(lifecycle.cleanupCalls).toBe(fixtureCount + 3);
  },
);
