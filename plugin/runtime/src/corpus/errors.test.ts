// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { PluginRuntimeError } from "../errors.js";
import { CORPUS_ERROR_CODES, CorpusMirrorError } from "./errors.js";
import { compareCodeUnitStrings } from "./order.js";

describe("corpus errors", () => {
  test("subclasses the runtime error so callers can catch one type", () => {
    const error = new CorpusMirrorError(CORPUS_ERROR_CODES.syncLockIo, "lock unavailable");
    expect(error).toBeInstanceOf(PluginRuntimeError);
    expect(error.name).toBe("CorpusMirrorError");
    expect(error.code).toBe("corpus-sync-lock-io");
  });

  test("carries a cause without losing the message", () => {
    const cause = new Error("EACCES");
    const error = new CorpusMirrorError(CORPUS_ERROR_CODES.mirrorStoreIo, "cannot open", { cause });
    expect(error.message).toBe("cannot open");
    expect(error.cause).toBe(cause);
  });

  test("every code is namespaced so it never collides with a C3 or C4 code", () => {
    for (const code of Object.values(CORPUS_ERROR_CODES)) {
      expect(code.startsWith("corpus-")).toBe(true);
    }
  });

  test("the codes object is frozen", () => {
    expect(Object.isFrozen(CORPUS_ERROR_CODES)).toBe(true);
  });
});

describe("compareCodeUnitStrings", () => {
  test("orders by UTF-16 code unit, not by locale", () => {
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(compareCodeUnitStrings("b", "a")).toBe(1);
  });

  test("sorts a key list deterministically", () => {
    expect(["b", "ä", "Z", "a"].sort(compareCodeUnitStrings)).toEqual(["Z", "a", "b", "ä"]);
  });
});
