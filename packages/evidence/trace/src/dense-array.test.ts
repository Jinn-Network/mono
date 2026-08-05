import { describe, expect, test } from "vitest";

import { UndefinedArrayElementError, UnsupportedCanonicalValueError } from "./canonical.js";
import { inspectDenseArrayDescriptors } from "./dense-array.js";
import { preflightCanonicalInput } from "./preflight.js";

describe("dense unaugmented arrays", () => {
  test("rejects sparse hole at beginning", () => {
    const sparse = Array.from<number>({ length: 2 });
    sparse[1] = 1;
    expect(inspectDenseArrayDescriptors(sparse, "items").ok).toBe(false);
    expect(() => preflightCanonicalInput({ items: sparse })).toThrow(UndefinedArrayElementError);
  });

  test("rejects sparse hole in middle", () => {
    const sparse = [1, , 3];
    expect(() => preflightCanonicalInput({ items: sparse })).toThrow(UndefinedArrayElementError);
  });

  test("rejects sparse hole at end", () => {
    const sparse = [1];
    Object.defineProperty(sparse, "length", { value: 2, writable: true });
    expect(() => preflightCanonicalInput({ items: sparse })).toThrow(UndefinedArrayElementError);
  });

  test("rejects length greater than own indices", () => {
    const array = Array.from<number>({ length: 3 });
    array[2] = 1;
    expect(() => preflightCanonicalInput({ items: array })).toThrow(UndefinedArrayElementError);
  });

  test("rejects augmented string key", () => {
    const array = [1];
    Object.defineProperty(array, "foo", { value: 2, enumerable: true, configurable: true });
    expect(() => preflightCanonicalInput({ items: array })).toThrow(UnsupportedCanonicalValueError);
  });

  test("rejects augmented symbol key", () => {
    const array = [1];
    Object.defineProperty(array, Symbol("x"), { value: 2, enumerable: true, configurable: true });
    expect(() => preflightCanonicalInput({ items: array })).toThrow(UnsupportedCanonicalValueError);
  });

  test("rejects accessor index without invoking getter", () => {
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

  test("rejects non-enumerable index", () => {
    const array: unknown[] = [];
    Object.defineProperty(array, 0, { value: 1, enumerable: false, configurable: true });
    Object.defineProperty(array, "length", { value: 1, writable: true });
    expect(() => preflightCanonicalInput({ items: array })).toThrow(UnsupportedCanonicalValueError);
  });

  test("rejects cyclic nested array", () => {
    const cyclic: unknown[] = [1];
    cyclic.push(cyclic);
    expect(() => preflightCanonicalInput({ items: cyclic })).toThrow(UnsupportedCanonicalValueError);
  });
});
