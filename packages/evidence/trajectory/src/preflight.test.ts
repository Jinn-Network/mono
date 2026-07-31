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
});
