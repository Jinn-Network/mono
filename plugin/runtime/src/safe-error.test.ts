import { describe, expect, test } from "vitest";

import { PluginRuntimeError } from "./errors.js";
import { describeUnknownError } from "./safe-error.js";

describe("describeUnknownError", () => {
  test("reads plain Error messages without invoking toString", () => {
    const error = new Error("plain failure");
    expect(describeUnknownError(error)).toBe("plain failure");
  });

  test("preserves PluginRuntimeError messages", () => {
    const error = new PluginRuntimeError("config-invalid", "bad config");
    expect(describeUnknownError(error)).toBe("bad config");
  });

  test("never invokes hostile toString, valueOf, or inspect hooks", () => {
    const hostile = {
      toString() {
        throw new Error("toString ran");
      },
      valueOf() {
        throw new Error("valueOf ran");
      },
      [Symbol.for("nodejs.util.inspect.custom")]() {
        throw new Error("inspect ran");
      },
    };
    expect(describeUnknownError(hostile)).toBe("an unknown error occurred");
  });

  test("rejects accessor-backed Error messages", () => {
    const hostile = new Error("safe");
    Object.defineProperty(hostile, "message", {
      enumerable: false,
      get() {
        throw new Error("message getter ran");
      },
    });
    expect(describeUnknownError(hostile)).toBe("an error occurred");
  });

  test("accepts string throws unchanged", () => {
    expect(describeUnknownError("configuration failed")).toBe("configuration failed");
  });
});
