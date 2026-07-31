import { describe, expect, test } from "vitest";

import { UnsupportedCanonicalValueError } from "./canonical.js";
import { preflightCanonicalInput } from "./preflight.js";
import { sealTrajectory } from "./schema.js";

describe("canonical preflight", () => {
  test("does not invoke getters", () => {
    let getterCalls = 0;
    const document = {
      protocol: "https://jinn.network/protocols/trajectory/1.0",
      poison: {
        get secret() {
          getterCalls += 1;
          return "leak";
        },
      },
    };
    expect(() => preflightCanonicalInput(document)).toThrow(UnsupportedCanonicalValueError);
    expect(getterCalls).toBe(0);
  });

  test("rejects proxy objects", () => {
    const target = { a: 1 };
    expect(() => preflightCanonicalInput(new Proxy(target, {}))).toThrow(
      UnsupportedCanonicalValueError,
    );
  });

  test("rejects cycles", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => preflightCanonicalInput(cycle)).toThrow(UnsupportedCanonicalValueError);
  });

  test("rejects setter properties", () => {
    const document: { value?: number } = {};
    Object.defineProperty(document, "value", {
      set: () => undefined,
      enumerable: true,
      configurable: true,
    });
    expect(() => preflightCanonicalInput(document)).toThrow(UnsupportedCanonicalValueError);
  });

  test("rejects property-descriptor traps", () => {
    const trapped = {};
    Object.defineProperty(trapped, "x", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("trap");
      },
    });
    expect(() => preflightCanonicalInput(trapped)).toThrow(UnsupportedCanonicalValueError);
  });

  test("rejects non-namespaced keys inside extension objects", () => {
    expect(() =>
      preflightCanonicalInput({
        "network.jinn.note": { bad: true },
      }),
    ).toThrow(UnsupportedCanonicalValueError);
  });

  test("rejects nested undeclared keys before sealing", () => {
    expect(() =>
      sealTrajectory({
        protocol: "https://jinn.network/protocols/trajectory/1.0",
        source: {
          nativeTrace: { digest: { sha256: "a".repeat(64), bad: true } },
          formatIri: "https://jinn.network/formats/claude-code-stream-json/v1",
        },
      }),
    ).toThrow();
  });

  test("rejects proxy arrays without invoking index getters", () => {
    let getterCalls = 0;
    const target = ["ok"];
    const proxy = new Proxy(target, {
      get(obj, prop) {
        if (String(prop) === "0") getterCalls += 1;
        return Reflect.get(obj, prop);
      },
    });
    expect(() => preflightCanonicalInput({ items: proxy })).toThrow(UnsupportedCanonicalValueError);
    expect(getterCalls).toBe(0);
  });

  test("rejects cyclic arrays with typed error", () => {
    const cyclic: unknown[] = [1];
    cyclic.push(cyclic);
    expect(() => preflightCanonicalInput({ items: cyclic })).toThrow(UnsupportedCanonicalValueError);
  });

  test("rejects array index accessor without invoking getter", () => {
    let getterCalls = 0;
    const array: unknown[] = [1];
    Object.defineProperty(array, 0, {
      get: () => {
        getterCalls += 1;
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => preflightCanonicalInput({ items: array })).toThrow(UnsupportedCanonicalValueError);
    expect(getterCalls).toBe(0);
  });

  test("seal rejects hostile statement getters before schema parse", async () => {
    const { buildTrajectoryDerivationStatement, sealTrajectoryDerivationAttestation } = await import(
      "./derivation.js"
    );
    let getterCalls = 0;
    const statement = buildTrajectoryDerivationStatement({
      producerId: "producer-1",
      executionDigest: `sha256:${"b".repeat(64)}`,
      trajectoryDigest: `sha256:${"c".repeat(64)}`,
      nativeTraceDigest: `sha256:${"a".repeat(64)}`,
      formatIri: "https://jinn.network/formats/claude-code-stream-json/v1",
      decoderId: "claude-code-stream-json",
      decoderVersion: "1.0.0",
      vocabularyProfile: "https://jinn.network/profiles/trajectory-vocabulary/1.0",
      timebase: "synthetic-ordinal",
      linkageMode: "forward-linked",
      derivedAt: "2026-07-31T12:00:00Z",
    });
    Object.defineProperty(statement, "forged", {
      get: () => {
        getterCalls += 1;
        return "bad";
      },
      enumerable: true,
      configurable: true,
    });
    await expect(
      sealTrajectoryDerivationAttestation({
        statement,
        signer: async () => [{ signature: new Uint8Array([1]), keyid: "k" }],
      }),
    ).rejects.toThrow();
    expect(getterCalls).toBe(0);
  });
});
