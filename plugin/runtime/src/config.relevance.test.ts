// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { resolveRuntimeConfig } from "./config.js";
import { PluginRuntimeError } from "./errors.js";

const HOME = "/tmp/jinn-home";

const base = { env: {}, homeDirectory: HOME } as const;

describe("relevance configuration", () => {
  test("defaults are supplied when the block is absent", () => {
    const parsed = resolveRuntimeConfig(base);
    expect(parsed.relevance.maxTerms).toBe(10);
    expect(parsed.relevance.floor).toBe(2);
    expect(parsed.relevance.searchLimit).toBe(20);
    expect(parsed.projection.maxChars).toBe(3500);
    expect(parsed.projection.maxRecords).toBe(2);
    expect(parsed.sensitivity.knownIdentities).toEqual([]);
    expect(parsed.sensitivity.noncePath).toBe(`${HOME}/sensitivity-nonce`);
  });

  test("operator overrides are honoured", () => {
    const parsed = resolveRuntimeConfig({
      ...base,
      file: {
        relevance: { maxTerms: 6, floor: 3, searchLimit: 5 },
        projection: { maxChars: 1200, maxRecords: 1 },
        sensitivity: { knownIdentities: ["ritsu@example.test"] },
      },
    });
    expect(parsed.relevance.maxTerms).toBe(6);
    expect(parsed.relevance.floor).toBe(3);
    expect(parsed.relevance.searchLimit).toBe(5);
    expect(parsed.projection.maxChars).toBe(1200);
    expect(parsed.projection.maxRecords).toBe(1);
    expect(parsed.sensitivity.knownIdentities).toEqual(["ritsu@example.test"]);
    expect(parsed.sensitivity.noncePath).toBe(`${HOME}/sensitivity-nonce`);
  });

  test("nonsensical bounds are rejected rather than clamped", () => {
    expect(() =>
      resolveRuntimeConfig({ ...base, file: { relevance: { floor: 0 } } }),
    ).toThrow(PluginRuntimeError);
    expect(() =>
      resolveRuntimeConfig({ ...base, file: { projection: { maxRecords: 0 } } }),
    ).toThrow(PluginRuntimeError);
    expect(() =>
      resolveRuntimeConfig({ ...base, file: { projection: { maxChars: 40 } } }),
    ).toThrow(PluginRuntimeError);
  });
});
