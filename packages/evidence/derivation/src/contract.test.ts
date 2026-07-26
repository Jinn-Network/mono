// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import {
  createBuiltinDerivationDetectors,
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
  if (!value || typeof value !== "object") {
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
    Object.defineProperty(target, key, {
      ...descriptor,
      value: (..._arguments: unknown[]): never => {
        ambientEffects += 1;
        throw new Error(`Built-in detector attempted ambient ${label}`);
      },
    });
    restorations.push(() => {
      Object.defineProperty(target, key, descriptor);
    });
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

  const filesystem = builtinModule("fs");
  for (const key of [
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
    "createWriteStream",
    "link",
    "linkSync",
    "mkdir",
    "mkdirSync",
    "open",
    "openSync",
    "rename",
    "renameSync",
    "rm",
    "rmSync",
    "rmdir",
    "rmdirSync",
    "symlink",
    "symlinkSync",
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
    "appendFile",
    "chmod",
    "chown",
    "copyFile",
    "cp",
    "link",
    "mkdir",
    "open",
    "rename",
    "rm",
    "rmdir",
    "symlink",
    "truncate",
    "unlink",
    "utimes",
    "writeFile",
  ]) {
    install(filesystemPromises, key, `fs.promises.${key}`);
  }

  install(Date, "now", "clock");
  install(Math, "random", "randomness");

  return {
    ambientEffectCount: () => ambientEffects,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      for (const restore of restorations.reverse()) restore();
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
