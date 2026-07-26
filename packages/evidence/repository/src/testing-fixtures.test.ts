import { describe, expect, test } from "vitest";

import { loadDeclaredLimitFixtures } from "./testing-fixtures.js";

describe("repository contract boundary fixtures", () => {
  test("does not allocate from an arbitrary declared limit", () => {
    expect(() =>
      loadDeclaredLimitFixtures(Number.MAX_SAFE_INTEGER, {}),
    ).toThrowError(/explicit.*fixture/u);
  });

  test.each([
    ["at-limit", undefined, () => new Uint8Array(2)],
    ["limit-plus-one", () => new Uint8Array(1), undefined],
  ] as const)(
    "requires an explicit %s fixture",
    (_name, createObjectAtDeclaredLimit, createObjectAboveDeclaredLimit) => {
      expect(() =>
        loadDeclaredLimitFixtures(1, {
          createObjectAtDeclaredLimit,
          createObjectAboveDeclaredLimit,
        }),
      ).toThrowError(/explicit.*fixture/u);
    },
  );

  test("validates both fixture lengths", () => {
    expect(() =>
      loadDeclaredLimitFixtures(1, {
        createObjectAtDeclaredLimit: () => new Uint8Array(0),
        createObjectAboveDeclaredLimit: () => new Uint8Array(1),
      }),
    ).toThrowError(/exactly 1 bytes/u);

    expect(() =>
      loadDeclaredLimitFixtures(1, {
        createObjectAtDeclaredLimit: () => new Uint8Array(1),
        createObjectAboveDeclaredLimit: () => new Uint8Array(1),
      }),
    ).toThrowError(/exactly 2 bytes/u);
  });

  test("returns exact boundary fixtures supplied by the binding", () => {
    const atLimit = new Uint8Array([1]);
    const aboveLimit = new Uint8Array([1, 2]);

    expect(
      loadDeclaredLimitFixtures(1, {
        createObjectAtDeclaredLimit: () => atLimit,
        createObjectAboveDeclaredLimit: () => aboveLimit,
      }),
    ).toEqual({ atLimit, aboveLimit });
  });
});
