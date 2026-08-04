// SPDX-License-Identifier: MIT

/**
 * Canonicalization conformance for the shapes JSON cannot spell (substrate §4.1 step 5).
 *
 * The tuple and manifest families cover documents that arrive as JSON. This one covers the values
 * that arrive from *code* — a `Date` someone put in a policy, an array with a hole left by a
 * preallocation — because those are the ones a canonicalizer silently accepts. Each fixture
 * describes its cases by constructor and this file materializes them, the same way the
 * fork-healing fixtures describe a tree rather than being one.
 *
 * Everything under test is imported from `./conformance.js`, so both implementations are gated.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  canonicalJsonText,
  canonicalTupleBytes,
  prefixedDigest,
  sealCandidateManifest,
} from "./conformance.js";
import { outcomeOf, readFixture } from "./fixtures.js";
import type { CandidateManifest, ExecutionPolicyTuple } from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

interface ConstructedCase {
  readonly name: string;
  readonly construct: string;
  readonly args: unknown[];
  readonly why: string;
  readonly expect?: { ok: false; code: string; index: number };
}

class DeclaredHarness {
  constructor(fields: Record<string, unknown>) {
    Object.assign(this, fields);
  }
}

/** Turns a fixture's constructor descriptor into the actual runtime value. */
function materialize({ construct, args }: ConstructedCase): unknown {
  switch (construct) {
    case "Date":
      return new Date(args[0] as string);
    case "Map":
      return new Map(args[0] as [string, string][]);
    case "Set":
      return new Set(args[0] as string[]);
    case "RegExp":
      return new RegExp(args[0] as string, args[1] as string);
    case "ClassInstance":
      return new DeclaredHarness(args[0] as Record<string, unknown>);
    case "BoxedString":
      // eslint-disable-next-line no-new-wrappers -- the point of the case is that this is an object
      return new String(args[0] as string);
    case "SparseLiteral": {
      // A hole cannot survive JSON, so it is punched here: the fixture supplies the dense form and
      // the index to delete, and `delete` is what actually makes the index absent rather than
      // undefined-valued.
      const dense = [...(args[0] as unknown[])];
      delete dense[args[1] as number];
      return dense;
    }
    case "ArrayOfLength":
      return new Array(args[0] as number);
    default:
      throw new Error(`unknown fixture constructor: ${construct}`);
  }
}

function tupleCarrying(axis: string, value: unknown): ExecutionPolicyTuple {
  return {
    formatToken: "network.jinn.policy.execution-tuple/1.0",
    harness: null,
    model: null,
    loadout: null,
    isolationPolicy: "unrestricted",
    [axis]: value,
  } as unknown as ExecutionPolicyTuple;
}

describe("canonicalization — golden", () => {
  const fixture = readFixture<{ input: unknown; expect: { canonical: string; digest: string } }>(
    "canonical/golden/mixed-scalars-and-nesting.json",
  );

  it("emits the pinned canonical text", () => {
    expect(canonicalJsonText(fixture.input)).toBe(fixture.expect.canonical);
  });

  it("the bytes are that text's UTF-8 encoding, and digest to the pinned sha256", () => {
    expect(decoder.decode(canonicalJsonBytes(fixture.input))).toBe(fixture.expect.canonical);
    expect(prefixedDigest(canonicalJsonBytes(fixture.input))).toBe(fixture.expect.digest);
  });

  it("round-trips: the canonical text parses, and re-canonicalizing is a fixed point", () => {
    const reparsed: unknown = JSON.parse(fixture.expect.canonical);
    expect(canonicalJsonText(reparsed)).toBe(fixture.expect.canonical);
  });
});

describe("non-plain objects are refused (they seal as {} and collide)", () => {
  const fixture = readFixture<{
    input: { cases: ConstructedCase[] };
    expect: { code: string; path: string; andWhenNested: { axis: string; path: string } };
  }>("canonical/adversarial/non-plain-object.json");

  for (const testCase of fixture.input.cases) {
    it(`${testCase.name}: refused at the document root`, () => {
      const outcome = outcomeOf(() => canonicalJsonBytes(materialize(testCase)));
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe(fixture.expect.code);
      expect(outcome.path).toBe(fixture.expect.path);
    });

    it(`${testCase.name}: refused inside a tuple, with the axis named`, () => {
      const outcome = outcomeOf(() =>
        canonicalTupleBytes(tupleCarrying(fixture.expect.andWhenNested.axis, materialize(testCase))),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe(fixture.expect.code);
      expect(outcome.path).toBe(fixture.expect.andWhenNested.path);
    });
  }

  it("the collision the refusal closes: two different Dates would seal identically", () => {
    // Stated as the defect rather than only as the rule, so the fixture cannot be "fixed" by
    // relaxing the rule. Under a walk-the-own-keys canonicalizer both of these are `{}`.
    const [first, second] = fixture.input.cases;
    if (first === undefined || second === undefined) throw new Error("collision pair missing");
    const naive = (value: object) => JSON.stringify(Object.fromEntries(Object.entries(value)));
    expect(naive(materialize(first) as object)).toBe(naive(materialize(second) as object));
    expect((materialize(first) as Date).getTime()).not.toBe((materialize(second) as Date).getTime());
  });
});

describe("sparse arrays are refused (they emit bytes JSON.parse rejects)", () => {
  const fixture = readFixture<{
    input: {
      cases: ConstructedCase[];
      carriers: { tupleAxis: string; manifestExtension: string };
    };
  }>("canonical/adversarial/sparse-array.json");

  const manifestBase = readFixture<{ input: CandidateManifest }>("manifest/golden/minimal.json").input;

  for (const testCase of fixture.input.cases) {
    const expected = testCase.expect;
    if (expected === undefined) throw new Error(`${testCase.name} states no expectation`);

    it(`${testCase.name}: refused at the document root, naming index ${expected.index}`, () => {
      const outcome = outcomeOf(() => canonicalJsonBytes({ plan: materialize(testCase) }));
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe(expected.code);
      expect(outcome.path).toBe(`plan.${expected.index}`);
    });

    it(`${testCase.name}: refused as a tuple's profile-declared axis`, () => {
      const outcome = outcomeOf(() =>
        canonicalTupleBytes(tupleCarrying(fixture.input.carriers.tupleAxis, materialize(testCase))),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe(expected.code);
      expect(outcome.path).toBe(`${fixture.input.carriers.tupleAxis}.${expected.index}`);
    });

    it(`${testCase.name}: refused as a manifest's namespaced extension`, () => {
      const outcome = outcomeOf(() =>
        sealCandidateManifest({
          ...manifestBase,
          [fixture.input.carriers.manifestExtension]: materialize(testCase),
        } as CandidateManifest),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe(expected.code);
      expect(outcome.path).toBe(
        `${fixture.input.carriers.manifestExtension}.${expected.index}`,
      );
    });
  }

  it("the defect the refusal closes: a mapped-and-joined hole emits unparseable bytes", () => {
    const [literal] = fixture.input.cases;
    if (literal === undefined) throw new Error("literal-hole case missing");
    const sparse = materialize(literal) as unknown[];
    const naive = `[${sparse.map((element) => JSON.stringify(element)).join(",")}]`;
    expect(naive).toBe("[1,,3]");
    expect(() => JSON.parse(naive)).toThrow();
  });
});
