// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import {
  createBuiltinDerivationDetectors,
  rejectNextBuiltinDetection,
  retainedBuiltinSurfaceCount,
} from "./detectors/index.js";
import { createEvidenceDeriver } from "./derive.js";
import {
  createSyntheticDerivationDetectorFixtures,
  createSyntheticPrivateDetectorConfiguration,
  describeDerivationDetectorContract,
  describeEvidenceDeriverContract,
} from "./testing.js";
import type { DerivationDetectorContractContext } from "./testing.js";
import type { DerivationDetector } from "./types.js";

interface ContractLifecycle {
  ambientObserverCalls: number;
  retainedObserverCalls: number;
  cleanupCalls: number;
}

function createContractLifecycle(): ContractLifecycle {
  return {
    ambientObserverCalls: 0,
    retainedObserverCalls: 0,
    cleanupCalls: 0,
  };
}

function builtinModule(id: string): Record<string, unknown> {
  const value = process.getBuiltinModule(id);
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
      throw new Error(`Cannot install ambient canary for ${label}`);
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
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
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

  install(globalThis, "fetch", "fetch");
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

  install(Date, "now", "clock");
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
  detector: DerivationDetector,
  lifecycle: ContractLifecycle,
): DerivationDetectorContractContext {
  const canaries = installBuiltinAmbientCanaries();
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
}

const privateConfiguration = createSyntheticPrivateDetectorConfiguration();

describeEvidenceDeriverContract((detectors) =>
  createEvidenceDeriver({
    detectors:
      detectors ??
      createBuiltinDerivationDetectors({ privateConfiguration }),
  }),
);

const builtinDetectors = createBuiltinDerivationDetectors({
  privateConfiguration,
});
const fixtures = createSyntheticDerivationDetectorFixtures();
const knownIdentityLifecycle = createContractLifecycle();
const deterministicPatternsLifecycle = createContractLifecycle();

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
    expect(() => Date.now()).toThrow(/ambient clock/u);
    expect(() => Math.random()).toThrow(/ambient randomness/u);
    expect(canaries.ambientEffectCount()).toBe(5);
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
      builtinDetectors[0]!,
      knownIdentityLifecycle,
    ),
  fixtures.knownIdentity,
);
describeDerivationDetectorContract(
  () =>
    createBuiltinContractContext(
      builtinDetectors[1]!,
      deterministicPatternsLifecycle,
    ),
  fixtures.deterministicPatterns,
);

test.each([
  ["known identity", builtinDetectors[0]!, fixtures.knownIdentity[0]!.surface],
  [
    "deterministic patterns",
    builtinDetectors[1]!,
    fixtures.deterministicPatterns[0]!.surface,
  ],
] as const)(
  "the %s detector releases observers after a non-abort operational rejection",
  async (_name, detector, surface) => {
    const context = createBuiltinContractContext(
      detector,
      createContractLifecycle(),
    );
    try {
      expect(context.ambientEffectCount()).toBe(0);
      expect(context.retainedSurfaceCount()).toBe(0);
      rejectNextBuiltinDetection(detector);
      await expect(detector.detect(surface)).rejects.toThrow(
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
