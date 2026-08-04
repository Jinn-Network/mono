// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  admitToPopulation,
  armIdForTuple,
  EMPTY_POPULATION,
  parseExactPopulation,
  populationBytes,
  populationDigest,
} from "./population.js";
import { digestOf } from "../testing/admission-fixtures.js";

const tupleA = digestOf("a");
const tupleB = digestOf("b");

describe("armIdForTuple", () => {
  it("derives from the digest, not from insertion order", () => {
    expect(armIdForTuple(tupleA)).toBe("arm-aaaaaaaaaaaa");
    expect(armIdForTuple(tupleA)).toBe(armIdForTuple(tupleA));
  });

  it("stays inside the records §7.1 arm-id grammar", () => {
    expect(armIdForTuple(tupleB)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("refuses a malformed tuple digest", () => {
    expect(() => armIdForTuple("sha256:zz")).toThrow(/tuple digest must be sha256/);
  });
});

describe("admitToPopulation", () => {
  it("mints an arm and attributes it to the first manifest", () => {
    const result = admitToPopulation(EMPTY_POPULATION, {
      tupleDigest: tupleA, manifestDigest: digestOf("1"),
    });
    expect(result.joinedExisting).toBe(false);
    expect(result.entry).toEqual({
      tupleDigest: tupleA,
      armId: armIdForTuple(tupleA),
      attribution: { kind: "candidate", digest: digestOf("1") },
      manifests: [digestOf("1")],
    });
  });

  it("joins the existing arm on a second manifest for the same tuple (§7.3)", () => {
    const first = admitToPopulation(EMPTY_POPULATION, {
      tupleDigest: tupleA, manifestDigest: digestOf("1"),
    });
    const second = admitToPopulation(first.population, {
      tupleDigest: tupleA, manifestDigest: digestOf("2"),
    });
    expect(second.joinedExisting).toBe(true);
    expect(second.population.entries).toHaveLength(1);
    expect(second.entry.armId).toBe(first.entry.armId);
    expect(second.entry.manifests).toEqual([digestOf("1"), digestOf("2")]);
  });

  it("never moves attribution off the first-admitted manifest", () => {
    let population = EMPTY_POPULATION;
    for (const seed of ["1", "2", "3"]) {
      population = admitToPopulation(population, {
        tupleDigest: tupleA, manifestDigest: digestOf(seed),
      }).population;
    }
    expect(population.entries[0]!.attribution.digest).toBe(digestOf("1"));
  });

  it("is idempotent for a replayed (tuple, manifest) pair", () => {
    const first = admitToPopulation(EMPTY_POPULATION, {
      tupleDigest: tupleA, manifestDigest: digestOf("1"),
    });
    const replay = admitToPopulation(first.population, {
      tupleDigest: tupleA, manifestDigest: digestOf("1"),
    });
    expect(replay.alreadyRecorded).toBe(true);
    expect(populationDigest(replay.population)).toBe(populationDigest(first.population));
  });

  it("keeps entries sorted, so the document does not depend on admission order", () => {
    const forward = admitToPopulation(
      admitToPopulation(EMPTY_POPULATION, { tupleDigest: tupleB, manifestDigest: digestOf("2") }).population,
      { tupleDigest: tupleA, manifestDigest: digestOf("1") },
    ).population;
    const backward = admitToPopulation(
      admitToPopulation(EMPTY_POPULATION, { tupleDigest: tupleA, manifestDigest: digestOf("1") }).population,
      { tupleDigest: tupleB, manifestDigest: digestOf("2") },
    ).population;
    expect(populationDigest(forward)).toBe(populationDigest(backward));
  });

  it("refuses a malformed manifest digest", () => {
    expect(() => admitToPopulation(EMPTY_POPULATION, { tupleDigest: tupleA, manifestDigest: "x" }))
      .toThrow(/manifest digest must be sha256/);
  });

  it("refuses two tuples sharing one arm rather than letting them merge", () => {
    const collided = {
      ...EMPTY_POPULATION,
      entries: [{
        tupleDigest: `sha256:aaaaaaaaaaaa${"c".repeat(52)}`,
        armId: armIdForTuple(tupleA),
        attribution: { kind: "candidate" as const, digest: digestOf("1") },
        manifests: [digestOf("1")],
      }],
    };
    expect(() => admitToPopulation(collided, { tupleDigest: tupleA, manifestDigest: digestOf("2") }))
      .toThrow(/two tuples cannot share an arm/);
  });
});

describe("parseExactPopulation", () => {
  const populated = admitToPopulation(EMPTY_POPULATION, {
    tupleDigest: tupleA, manifestDigest: digestOf("1"),
  }).population;

  it("round-trips the registry", () => {
    expect(parseExactPopulation(populationBytes(populated))).toEqual(populated);
  });

  it("round-trips an empty registry", () => {
    expect(parseExactPopulation(populationBytes(EMPTY_POPULATION))).toEqual(EMPTY_POPULATION);
  });

  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

  it("refuses a wrong format token", () => {
    expect(() => parseExactPopulation(encode({ ...populated, formatToken: "other" })))
      .toThrow(/formatToken must be/);
  });

  it("refuses an arm id that is not derived from its tuple", () => {
    const tampered = { ...populated, entries: [{ ...populated.entries[0]!, armId: "arm-hand-picked" }] };
    expect(() => parseExactPopulation(encode(tampered))).toThrow(/is not the id derived from/);
  });

  it("refuses attribution that does not name the first-admitted manifest", () => {
    const tampered = {
      ...populated,
      entries: [{
        ...populated.entries[0]!,
        attribution: { kind: "candidate", digest: digestOf("9") },
      }],
    };
    expect(() => parseExactPopulation(encode(tampered)))
      .toThrow(/attribution must name the first-admitted manifest/);
  });

  it("refuses a duplicate entry for one tuple", () => {
    const tampered = { ...populated, entries: [populated.entries[0]!, populated.entries[0]!] };
    expect(() => parseExactPopulation(encode(tampered))).toThrow(/duplicate population entry/);
  });

  it("refuses bytes that are not the canonical form", () => {
    const text = new TextDecoder().decode(populationBytes(populated));
    expect(() => parseExactPopulation(new TextEncoder().encode(` ${text}`)))
      .toThrow(/not valid UTF-8 JSON|not the canonical form/);
  });

  it("refuses an entry with no manifests", () => {
    const tampered = { ...populated, entries: [{ ...populated.entries[0]!, manifests: [] }] };
    expect(() => parseExactPopulation(encode(tampered))).toThrow(/non-empty array/);
  });
});
