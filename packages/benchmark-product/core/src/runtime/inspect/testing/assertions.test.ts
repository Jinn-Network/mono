// SPDX-License-Identifier: Apache-2.0

/**
 * #4389: the Inspect integration suites route their assertions through these helpers, and those
 * suites are `skipIf`-gated on Docker / Inspect runtime env vars no ordinary CI job supplies. A
 * dropped `!` in `expectEvery`'s filter or in `expectOk` would turn every assertion that uses
 * them into a silent no-op, and nothing would go red until someone next ran the Docker suite.
 * This file runs under plain `yarn test` -- no Docker, no Python, no network -- and is the
 * regression guard for the helpers themselves.
 *
 * Kill-check (recorded in the #4449 change): dropping the `!` in `expectEvery`'s filter fails
 * the truth-table rows; dropping the `!` in `expectOk` fails its two cases.
 */

import { describe, expect, test, vi } from "vitest";
import { expectEvery, expectOk, expectRefused, leakMarkers } from "./assertions.js";

const identity = (item: boolean) => item;

/**
 * The truth table over `[] [T] [F] [TT] [TF] [FF] [FT]`: every row `expectEvery` must be
 * equivalent to `Array.prototype.every` on, including the empty array (vacuous truth) and both
 * orderings of a mixed pair, so an implementation that stopped at the first element, or the
 * last, or that inverted the predicate, is caught by at least one row.
 */
const truthTable: readonly (readonly boolean[])[] = [
  [],
  [true],
  [false],
  [true, true],
  [true, false],
  [false, false],
  [false, true],
];

describe("expectEvery", () => {
  test.each(truthTable.map((items) => [JSON.stringify(items), items] as const))(
    "is truth-table equivalent to Array.prototype.every on %s",
    (_label, items) => {
      const project = vi.fn((item: boolean, index: number) => ({ index, item }));
      const run = () => expectEvery(items, identity, project, "step");
      if (items.every(identity)) {
        expect(run).not.toThrow();
        // The laziness the doc comment claims: nothing is projected on the passing path.
        expect(project).not.toHaveBeenCalled();
      } else {
        expect(run).toThrow();
        // Every offender, and only the offenders, is projected -- with its index.
        const offenders = items.map((item, index) => ({ index, item })).filter(({ item }) => !item);
        expect(project.mock.calls.map(([item, index]) => ({ index, item }))).toEqual(offenders);
      }
    },
  );

  test("names the step, the counts, and the projections on the failing path", () => {
    let message = "";
    try {
      expectEvery([true, false, false], identity, (item, index) => ({ index, item }), "every item holds");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("every item holds");
    expect(message).toContain("2 of 3 failed");
    expect(message).toContain(JSON.stringify([{ index: 1, item: false }, { index: 2, item: false }]));
  });
});

describe("expectOk", () => {
  test("passes a successful result through unchanged", () => {
    const result = { ok: true as const, result: { value: 1 } };
    expect(expectOk(result, "step")).toBe(result);
  });

  test("fails naming the step and the serialized result on an unsuccessful one", () => {
    const result = { ok: false as const, error: { code: "validation", detail: "why" } };
    let message = "";
    try {
      expectOk(result, "quote");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("quote failed");
    expect(message).toContain(JSON.stringify(result));
  });
});

describe("expectRefused", () => {
  test("passes a refusal through narrowed to the error arm", () => {
    const result: { ok: true; result: number } | { ok: false; error: { code: string } } = {
      ok: false,
      error: { code: "record-integrity" },
    };
    const refused = expectRefused(result, "verify");
    expect(refused).toBe(result);
    expect(refused.error.code).toBe("record-integrity");
  });

  test("fails naming the step and the serialized result when the step was accepted", () => {
    const result = { ok: true as const, result: { value: 1 } };
    let message = "";
    try {
      expectRefused(result, "verify of a tampered matrix");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("verify of a tampered matrix was accepted");
    expect(message).toContain(JSON.stringify(result));
  });
});

describe("leakMarkers", () => {
  const sentinel = "sk-test-jinn-broker-sentinel-never-persist";
  const plantedPath = "/private/var/folders/xy/T/benchmark-product-inspect-broker-abc123/openai-api-key";

  test("returns no marker for clean bytes", () => {
    expect(leakMarkers(Buffer.from("nothing to see"), { "key-sentinel": sentinel })).toEqual([]);
  });

  test("names every marker whose value occurs, in the order given", () => {
    const bytes = Buffer.from(JSON.stringify({ path: plantedPath, key: sentinel }));
    expect(leakMarkers(bytes, { "key-sentinel": sentinel, "key-file-path": plantedPath }))
      .toEqual(["key-sentinel", "key-file-path"]);
    expect(leakMarkers(bytes, { "key-file-path": plantedPath })).toEqual(["key-file-path"]);
    expect(leakMarkers(Buffer.from(`prefix ${sentinel} suffix`), { "key-sentinel": sentinel, "key-file-path": plantedPath }))
      .toEqual(["key-sentinel"]);
  });

  test("searches a Uint8Array view at its own offset", () => {
    const backing = Buffer.from(`padding-${sentinel}`);
    const view = new Uint8Array(backing.buffer, backing.byteOffset + "padding-".length, sentinel.length);
    expect(leakMarkers(view, { "key-sentinel": sentinel })).toEqual(["key-sentinel"]);
    const clean = new Uint8Array(backing.buffer, backing.byteOffset, "padding-".length);
    expect(leakMarkers(clean, { "key-sentinel": sentinel })).toEqual([]);
  });

  /**
   * Planted-leak parity (#4388): the rewrite must still fail on the leak `not.toContain` failed
   * on, and the failure must name the marker without emitting the value or the absolute path.
   */
  test("a planted leak still fails, naming the marker and never the value or the path", () => {
    const journal = Buffer.from(JSON.stringify([{ kind: "delivery", keyFilePath: plantedPath, apiKey: sentinel }]));
    let message = "";
    try {
      expect(leakMarkers(journal, { "key-sentinel": sentinel })).toEqual([]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("key-sentinel");
    expect(message).not.toContain(sentinel);
    expect(message).not.toContain(plantedPath);
  });
});
