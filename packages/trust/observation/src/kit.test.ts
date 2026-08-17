// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CLASS_A_PROFILE, CLASS_O_PROFILE, RECEIPT_CLASSES } from "./profile.js";
import { createMemoryObservationContainer } from "./testing.js";

const testSchema = z.object({ schemaVersion: z.literal(1), a: z.number() });

describe("receipt class profile", () => {
  it("names both classes and marks Class A as not yet a present discipline", () => {
    expect([...RECEIPT_CLASSES]).toEqual(["observation", "authority"]);
    expect(CLASS_O_PROFILE.gateReadable).toBe(false);
    expect(CLASS_O_PROFILE.defaultMode).toBe(0o600);
    expect(CLASS_A_PROFILE.presentDiscipline).toBe(false);
    expect(CLASS_A_PROFILE.gateReadable).toBe(true);
  });
});

describe("the in-tree fake", () => {
  it("schema-validates then serializes the same pretty JSON the filesystem writer emits", () => {
    const fake = createMemoryObservationContainer();
    fake.write("observation.json", testSchema, { schemaVersion: 1, a: 1 });
    expect(fake.read("observation.json")).toBe(
      `${JSON.stringify({ schemaVersion: 1, a: 1 }, null, 2)}\n`,
    );
  });

  it("rejects an invalid value before recording anything", () => {
    const fake = createMemoryObservationContainer();
    expect(() => fake.write("observation.json", testSchema, { schemaVersion: 1, a: "no" } as never))
      .toThrow();
    expect(fake.paths()).toEqual([]);
  });
});
