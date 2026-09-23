// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the binary-judgment payload shape as it appears in the three independent copies
 * this package and `@jinn-network/task-execution-profiles` each carry (program packet P2, task
 * T2): `admission/contracts.ts`'s `HumanReviewPacketSchema.item`, and `admission/intake.ts`'s
 * `ItemPayloadSchema` (via `BinaryItemBankEntrySchema.item`). Both must accept the reshaped 2.0
 * payload (optional `evidence`, object-shaped `provenance`, non-empty `sources`) and reject the
 * superseded 1.0 array-shaped `provenance`. `BinarySourceManifestEntrySchema` additionally gains a
 * required, calendar-strict `publishedAt`.
 */

import { describe, expect, test } from "vitest";
import {
  BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
  BinaryItemBankEntrySchema,
  BinaryItemBankIntakeExtensionSchema,
  BinarySourceManifestEntrySchema,
} from "./intake.js";
import { HUMAN_REVIEW_PACKET_PROTOCOL, HumanReviewPacketSchema } from "./contracts.js";

const DIGEST_HEX = "a".repeat(64);
const SOURCE_COMMITMENT = `sha256:${DIGEST_HEX}`;
const ITEM_ID = "urn:uuid:12345678-1234-4123-8123-123456789abc";

const evidenceCarryingItem = {
  itemId: ITEM_ID,
  question: "Is 2 + 2 equal to 4?",
  referenceAnswer: "Yes.",
  candidateAnswer: "Yes.",
  evidence: "Direct arithmetic verification: 2 + 2 = 4.",
  provenance: { sourceCommitment: SOURCE_COMMITMENT, timestamp: "2026-01-01T00:00:00Z" },
  sources: [{ digest: { sha256: DIGEST_HEX } }],
};

const legacyOneDotZeroItem = {
  itemId: ITEM_ID,
  question: "Is 2 + 2 equal to 4?",
  referenceAnswer: "Yes.",
  candidateAnswer: "Yes.",
  provenance: [{ digest: { sha256: DIGEST_HEX } }],
};

const validPacket = {
  protocol: HUMAN_REVIEW_PACKET_PROTOCOL,
  itemSha256: SOURCE_COMMITMENT,
  item: evidenceCarryingItem,
  evaluationSpecSha256: SOURCE_COMMITMENT,
  reviewerId: "urn:jinn:reviewer:test-1",
  form: {
    question: "Is the candidate answer correct relative to the question and reference answer?",
    labels: ["CORRECT", "WRONG", "indeterminate"],
    completeReviewRequired: true,
  },
};

const validSourceManifestEntry = {
  protocol: BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
  provenanceSha256: SOURCE_COMMITMENT,
  source: { uri: "https://example.test/source", digest: { sha256: DIGEST_HEX } },
  license: { uri: "https://example.test/license", digest: { sha256: DIGEST_HEX } },
  attribution: { uri: "https://example.test/attribution", digest: { sha256: DIGEST_HEX } },
  publishedAt: "2026-01-01T00:00:00Z",
};

const validIntakeExtension = {
  profile: "https://spec.jinn.network/task-profiles/binary-judgment/2.0",
  itemBankSha256: SOURCE_COMMITMENT,
  sourceManifestSha256: SOURCE_COMMITMENT,
  admissionIndexSha256: SOURCE_COMMITMENT,
  admissionManifestSha256: SOURCE_COMMITMENT,
  replacementLedgerSha256: SOURCE_COMMITMENT,
};

describe("binary-judgment payload schema — widened copies", () => {
  test("an evidence-carrying item payload validates through contracts.ts's copy", () => {
    expect(HumanReviewPacketSchema.shape.item.safeParse(evidenceCarryingItem).success).toBe(true);
  });

  test("an evidence-carrying item payload validates through intake.ts's copy", () => {
    expect(BinaryItemBankEntrySchema.shape.item.safeParse(evidenceCarryingItem).success).toBe(true);
  });

  test("a HumanReviewPacket whose item carries evidence validates", () => {
    expect(HumanReviewPacketSchema.safeParse(validPacket).success).toBe(true);
  });

  test("the superseded 1.0 array-shaped provenance is rejected by contracts.ts's copy", () => {
    expect(HumanReviewPacketSchema.shape.item.safeParse(legacyOneDotZeroItem).success).toBe(false);
  });

  test("the superseded 1.0 array-shaped provenance is rejected by intake.ts's copy", () => {
    expect(BinaryItemBankEntrySchema.shape.item.safeParse(legacyOneDotZeroItem).success).toBe(false);
  });
});

describe("BinarySourceManifestEntrySchema — publishedAt", () => {
  test("a valid entry with publishedAt validates", () => {
    expect(BinarySourceManifestEntrySchema.safeParse(validSourceManifestEntry).success).toBe(true);
  });

  test("a source-manifest row without publishedAt is rejected", () => {
    const { publishedAt: _publishedAt, ...withoutPublishedAt } = validSourceManifestEntry;
    expect(BinarySourceManifestEntrySchema.safeParse(withoutPublishedAt).success).toBe(false);
  });

  test("a source-manifest row whose publishedAt is an impossible calendar date is rejected", () => {
    const result = BinarySourceManifestEntrySchema.safeParse({
      ...validSourceManifestEntry,
      publishedAt: "2026-02-30T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  test("a source-manifest row whose publishedAt carries fractional seconds is rejected", () => {
    const result = BinarySourceManifestEntrySchema.safeParse({
      ...validSourceManifestEntry,
      publishedAt: "2026-01-01T00:00:00.123Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("BinaryItemBankIntakeExtensionSchema — profile literal", () => {
  test("the old .../binary-judgment/1.0 profile literal is refused", () => {
    const result = BinaryItemBankIntakeExtensionSchema.safeParse({
      ...validIntakeExtension,
      profile: "https://spec.jinn.network/task-profiles/binary-judgment/1.0",
    });
    expect(result.success).toBe(false);
  });

  test("the .../binary-judgment/2.0 profile literal is accepted", () => {
    expect(BinaryItemBankIntakeExtensionSchema.safeParse(validIntakeExtension).success).toBe(true);
  });
});
