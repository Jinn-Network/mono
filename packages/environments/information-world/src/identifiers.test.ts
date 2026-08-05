import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  INFORMATION_WORLD_KIND,
  INFORMATION_WORLD_MEDIA_TYPE,
  INFORMATION_WORLD_SCHEMA_ID,
} from "./identifiers.js";
import { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";

// Mirror of discovery's record-kind URI grammar (DR-2026-08-04, transition window closed):
// one origin, `https://spec.jinn.network`, and one version form, `v<major>`. Mirrored rather
// than imported because this package declares no Jinn dependency. Reference implementation:
// packages/discovery/protocol/src/origins.ts.
const RECORD_KIND_GRAMMAR = /^https:\/\/spec\.jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/v[1-9]\d*$/;

describe("identifiers", () => {
  test("the record kind is the exact string the design pins", () => {
    expect(INFORMATION_WORLD_KIND).toBe(
      "https://spec.jinn.network/records/information-world/v1",
    );
  });

  test("the record kind conforms to the discovery record-kind URI grammar", () => {
    // Mirror of `assertRecordKindUri`. This package cannot import discovery (tier 2, zero
    // Jinn dependencies); the authoritative check runs in the facts leaf, which calls
    // `assertRecordKindUri` on this constant.
    expect(INFORMATION_WORLD_KIND).toMatch(
      RECORD_KIND_GRAMMAR,
    );
  });

  test("the media type is the exact vendor-tree string the design pins", () => {
    expect(INFORMATION_WORLD_MEDIA_TYPE).toBe(
      "application/vnd.jinn.information-world.v1+json",
    );
  });

  // Re-homed out of the `records/` prefix (DR-2026-08-04): a record-kind URI must never be a
  // directory prefix of a served doc, so this no longer hangs off the record kind.
  test("the published schema id is an independent schemas/<kind>/v<major> identifier", () => {
    expect(INFORMATION_WORLD_SCHEMA_ID).toBe(
      "https://spec.jinn.network/schemas/information-world/v1",
    );
  });

  // The regression test for the C2 narrowing. While the mirror dual-accepted, a pre-re-seal
  // spelling matched as a valid record kind; the two literals at the head of the rejected
  // list below are exactly the spellings that must no longer match (DR-2026-08-04).
  test("the mirrored grammar accepts only the canonical spelling", () => {
    expect("https://spec.jinn.network/records/information-world/v1").toMatch(RECORD_KIND_GRAMMAR);
    expect("https://spec.jinn.network/records/information-world/v2").toMatch(RECORD_KIND_GRAMMAR);
    for (const rejected of [
      "https://jinn.network/records/information-world/1.0",
      "https://spec.jinn.network/records/information-world/1.0",
      "https://spec.jinn.network/records/information-world/v0",
      "https://spec.jinn.network/records/information-world/1",
      "https://spec.jinn.network/records/information-world/v1/facts/v1",
      "https://evil.jinn.network/records/information-world/v1",
      "https://jinn.network.evil.example/records/information-world/v1",
    ]) {
      expect(rejected).not.toMatch(RECORD_KIND_GRAMMAR);
    }
  });
});

describe("namespaced extension keys", () => {
  test.each([
    ["network.jinn.note", true],
    ["mailto:operator@example.test", true],
    ["urn:jinn:information-world", true],
    ["https://example.test/ext", true],
    ["mailto:", false],
    ["http://", false],
    ["http://example.test/ext a", false],
    ["note", false],
    ["", false],
  ])("classifies %j as %s", (key, expected) => {
    expect(isNamespacedExtensionKey(key)).toBe(expected);
  });

  test("topLevelRecordSchema admits namespaced extras and refuses bare ones", () => {
    const schema = topLevelRecordSchema({ known: z.string() });
    expect(schema.safeParse({ known: "a", "network.jinn.note": "kept" }).success).toBe(true);
    expect(schema.safeParse({ known: "a", note: "bare" }).success).toBe(false);
  });
});
