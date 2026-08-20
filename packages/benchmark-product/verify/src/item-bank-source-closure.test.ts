// SPDX-License-Identifier: Apache-2.0

/**
 * The cold verifier's item-bank/source-manifest closure (program packet P2, review fix).
 *
 * Driven directly rather than through a materialized bundle, because a bundle whose cluster key is
 * decoupled from its declared sources cannot be produced by this repository's own import path: the
 * importer's code-unit-least rule is strictly stronger than the membership rule under test. This
 * check exists for bundles produced by other implementations, so its fixtures are constructed.
 */

import { describe, expect, test } from "vitest";
import { BenchmarkProductError } from "./profile/errors.js";
import {
  BINARY_ITEM_BANK_ENTRY_PROTOCOL,
  BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
  BinaryItemBankEntrySchema,
  BinarySourceManifestEntrySchema,
} from "./admission/intake.js";
import { checkItemBankSourceClosure } from "./verify.js";

const PUBLISHED_AT = "2026-03-09T00:00:00Z";
const hex = (character: string) => character.repeat(64);
const digest = (character: string) => `sha256:${hex(character)}`;

function itemRow(input: {
  readonly itemId: string;
  readonly sourceHexes: readonly string[];
  readonly sourceCommitment: string;
}) {
  return BinaryItemBankEntrySchema.parse({
    protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL,
    item: {
      itemId: input.itemId,
      question: `Synthetic closure question for ${input.itemId}?`,
      referenceAnswer: "The admitted synthetic answer.",
      candidateAnswer: "The admitted synthetic answer.",
      provenance: { sourceCommitment: input.sourceCommitment, timestamp: PUBLISHED_AT },
      sources: input.sourceHexes.map((sha256) => ({ digest: { sha256 } })),
    },
  });
}

function sourceRow(character: string) {
  const descriptor = {
    uri: `https://fixtures.example.test/source-${character}.json`,
    digest: { sha256: hex(character) },
  };
  return BinarySourceManifestEntrySchema.parse({
    protocol: BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
    provenanceSha256: digest(character),
    source: descriptor,
    license: { uri: "https://fixtures.example.test/license.txt", digest: { sha256: hex("b") } },
    attribution: { uri: "https://fixtures.example.test/attribution.txt", digest: { sha256: hex("c") } },
    publishedAt: PUBLISHED_AT,
  });
}

const ITEM_ONE = "urn:uuid:40000000-0000-4000-8000-000000000001";
const ITEM_TWO = "urn:uuid:40000000-0000-4000-8000-000000000002";

function expectRefusal(run: () => unknown): BenchmarkProductError {
  try {
    run();
    throw new Error("expected a refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(BenchmarkProductError);
    return cause as BenchmarkProductError;
  }
}

describe("cold-verify item-bank/source-manifest closure", () => {
  test("accepts a bank whose cluster key is one of the item's own declared sources", () => {
    const rows = [
      itemRow({ itemId: ITEM_ONE, sourceHexes: [hex("a"), hex("e")], sourceCommitment: digest("a") }),
      itemRow({ itemId: ITEM_TWO, sourceHexes: [hex("f")], sourceCommitment: digest("f") }),
    ];
    const result = checkItemBankSourceClosure(rows, [sourceRow("a"), sourceRow("e"), sourceRow("f")]);
    expect(result.itemDigests.size).toBe(2);
  });

  test("refuses a bundle whose cluster key is decoupled from the item's declared sources", () => {
    // The item declares source `a` but names `f` as its cluster key. Both rows exist in the
    // manifest, so coverage alone would let this through; membership is what catches it.
    const rows = [
      itemRow({ itemId: ITEM_ONE, sourceHexes: [hex("a")], sourceCommitment: digest("f") }),
      itemRow({ itemId: ITEM_TWO, sourceHexes: [hex("f")], sourceCommitment: digest("f") }),
    ];
    const error = expectRefusal(() => checkItemBankSourceClosure(rows, [sourceRow("a"), sourceRow("f")]));
    expect(error.code).toBe("record-integrity");
    expect(error.issues).toEqual([{
      path: "item-bank.jsonl.1.item.provenance.sourceCommitment",
      message: "item provenance sourceCommitment is not one of the item's declared sources",
    }]);
  });

  test("keeps the unused-source-row refusal: a row named only by a cluster key is still unused", () => {
    // Regression for the review finding. If the covered set folded the cluster key in, source row
    // `e` would count as used here and this bundle would pass with a source nothing draws on.
    const rows = [
      itemRow({ itemId: ITEM_ONE, sourceHexes: [hex("a"), hex("e")], sourceCommitment: digest("e") }),
    ];
    expect(() => checkItemBankSourceClosure(rows, [sourceRow("a"), sourceRow("e")])).not.toThrow();

    const decoupled = [
      itemRow({ itemId: ITEM_ONE, sourceHexes: [hex("a")], sourceCommitment: digest("a") }),
    ];
    const error = expectRefusal(() => checkItemBankSourceClosure(decoupled, [sourceRow("a"), sourceRow("e")]));
    expect(error.code).toBe("record-integrity");
    expect(error.issues).toEqual([{
      path: "source-manifest.jsonl",
      message: "source manifest does not exactly cover item-bank provenance",
    }]);
  });

  test("still refuses a source digest no manifest row maps", () => {
    const rows = [itemRow({ itemId: ITEM_ONE, sourceHexes: [hex("d")], sourceCommitment: digest("d") })];
    const error = expectRefusal(() => checkItemBankSourceClosure(rows, [sourceRow("a")]));
    expect(error.issues).toEqual([{
      path: "source-manifest.jsonl",
      message: "source manifest does not exactly cover item-bank provenance",
    }]);
  });

  test("still refuses duplicate item payloads", () => {
    const row = itemRow({ itemId: ITEM_ONE, sourceHexes: [hex("a")], sourceCommitment: digest("a") });
    const error = expectRefusal(() => checkItemBankSourceClosure([row, row], [sourceRow("a")]));
    expect(error.issues).toEqual([{
      path: "item-bank.jsonl",
      message: "item bank contains duplicate payloads",
    }]);
  });
});
