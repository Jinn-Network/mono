// SPDX-License-Identifier: Apache-2.0

/**
 * The exact output of Colophon's checker, pinned before its general record checks move into a
 * platform package (issue #5120). Everything here is observed behavior, not specification: a pin
 * failing says the checker's output moved, and the move decides whether that was meant.
 *
 * `conformance-kit.test.mjs` and `anchor/integrity-anchors.test.ts` say what the outputs must mean,
 * by pattern and by containment. This suite compares them whole, so a reworded refusal or a moved
 * key fails here even where those two still pass. Expected values live in
 * `testing/checker-outputs.expected.json`, outside `fixtures/` because fixtures are append-only.
 *
 * To re-pin after a change that is meant, regenerate and read the diff:
 *
 *   CHECKER_CHARACTERIZATION_UPDATE=1 yarn vitest run src/characterization/checker-outputs.test.ts
 *
 * The record-checks move must not touch the expected file: a diff in it during #5120 means the move
 * changed an output, so fix the code.
 *
 * Normalization happens in one place, `normalize` in `testing/observe.ts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { ANCHOR_CASES } from "./testing/anchor-cases.js";
import { BUNDLE_CASES } from "./testing/bundle-cases.js";
import { normalize, observeBundle } from "./testing/observe.js";
import { SIGNATURE_CASES } from "./testing/signature-cases.js";

const EXPECTED_PATH = fileURLToPath(new URL("./testing/checker-outputs.expected.json", import.meta.url));
const KIT_DIR = fileURLToPath(new URL("../../fixtures/public-bundle-conformance-v1/", import.meta.url));
const UPDATE = process.env["CHECKER_CHARACTERIZATION_UPDATE"] === "1";

const kit = JSON.parse(readFileSync(join(KIT_DIR, "manifest.json"), "utf8")) as {
  readonly golden: { readonly path: string };
  readonly fixtures: readonly { readonly path: string }[];
};
const expected = (UPDATE ? {} : JSON.parse(readFileSync(EXPECTED_PATH, "utf8"))) as Record<string, unknown>;
const observed = new Map<string, unknown>();
const pinnedIds: string[] = [];

function pin(id: string, observe: () => unknown): void {
  pinnedIds.push(id);
  test(id, async () => {
    const actual = normalize(await observe());
    observed.set(id, actual);
    if (UPDATE) return;
    expect(actual).toStrictEqual(expected[id]);
    // `toStrictEqual` ignores key order, and a consumer reading the output does not.
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected[id]));
  });
}

describe("the public bundle conformance kit", () => {
  // Read from the kit's manifest, so a variant added to the kit cannot go unpinned.
  for (const { path } of [kit.golden, ...kit.fixtures]) {
    pin(`kit/${path}`, () => observeBundle(join(KIT_DIR, path)));
  }
});

describe("signature and trust refusals the kit does not reach", () => {
  for (const [id, bundleDir] of Object.entries(BUNDLE_CASES)) pin(id, () => observeBundle(bundleDir()));
});

describe("the signature primitives and did:key", () => {
  for (const [id, observe] of Object.entries(SIGNATURE_CASES)) pin(id, observe);
});

describe("integrity-anchors reports", () => {
  for (const [id, observe] of Object.entries(ANCHOR_CASES)) pin(`anchors/${id}`, observe);
});

test("the expected file pins exactly these cases", () => {
  if (!UPDATE) expect(Object.keys(expected)).toEqual(pinnedIds);
});

afterAll(() => {
  if (!UPDATE) return;
  const entries = pinnedIds.map((id) => [id, observed.get(id)]);
  writeFileSync(EXPECTED_PATH, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
});
