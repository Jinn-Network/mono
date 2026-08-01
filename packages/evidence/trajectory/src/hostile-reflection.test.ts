import { describe, expect, test } from "vitest";

import { isAbortLikeError, readAbortSignalAborted } from "./hostile-reflection.js";

describe("hostile-reflection", () => {
  test("readAbortSignalAborted uses AbortSignal.prototype getter, not own aborted accessor", () => {
    const controller = new AbortController();
    let ownGetterCalls = 0;
    Object.defineProperty(controller.signal, "aborted", {
      get: () => {
        ownGetterCalls += 1;
        return false;
      },
      configurable: true,
    });
    controller.abort();
    expect(readAbortSignalAborted(controller.signal)).toBe(true);
    expect(ownGetterCalls).toBe(0);
  });

  test("isAbortLikeError rejects proxied thrown values without reflection traps", () => {
    let descriptorTraps = 0;
    let prototypeTraps = 0;
    const thrown = new Proxy(new DOMException("aborted", "AbortError"), {
      getOwnPropertyDescriptor(target, property) {
        descriptorTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        prototypeTraps += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    expect(isAbortLikeError(thrown)).toBe(false);
    expect(descriptorTraps).toBe(0);
    expect(prototypeTraps).toBe(0);
  });

  test("isAbortLikeError accepts genuine DOMException AbortError", () => {
    expect(isAbortLikeError(new DOMException("aborted", "AbortError"))).toBe(true);
  });
});
