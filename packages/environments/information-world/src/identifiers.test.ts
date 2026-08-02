import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  INFORMATION_WORLD_KIND,
  INFORMATION_WORLD_MEDIA_TYPE,
  INFORMATION_WORLD_SCHEMA_ID,
} from "./identifiers.js";
import { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";

describe("identifiers", () => {
  test("the record kind is the exact string the design pins", () => {
    expect(INFORMATION_WORLD_KIND).toBe(
      "https://jinn.network/records/information-world/1.0",
    );
  });

  test("the record kind conforms to the discovery record-kind URI grammar", () => {
    // Mirror of `assertRecordKindUri`. This package cannot import discovery (tier 2, zero
    // Jinn dependencies); the authoritative check runs in the facts leaf, which calls
    // `assertRecordKindUri` on this constant.
    expect(INFORMATION_WORLD_KIND).toMatch(
      /^https:\/\/jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/\d+\.\d+$/,
    );
  });

  test("the media type is the exact vendor-tree string the design pins", () => {
    expect(INFORMATION_WORLD_MEDIA_TYPE).toBe(
      "application/vnd.jinn.information-world.v1+json",
    );
  });

  test("the published schema id is derived from the record kind", () => {
    expect(INFORMATION_WORLD_SCHEMA_ID).toBe(`${INFORMATION_WORLD_KIND}/schema`);
  });
});

describe("namespaced extension keys", () => {
  test("accepts reverse-DNS and absolute-URI names", () => {
    expect(isNamespacedExtensionKey("network.jinn.note")).toBe(true);
    expect(isNamespacedExtensionKey("https://example.test/ext")).toBe(true);
  });

  test("rejects bare names", () => {
    expect(isNamespacedExtensionKey("note")).toBe(false);
    expect(isNamespacedExtensionKey("")).toBe(false);
  });

  test("topLevelRecordSchema admits namespaced extras and refuses bare ones", () => {
    const schema = topLevelRecordSchema({ known: z.string() });
    expect(schema.safeParse({ known: "a", "network.jinn.note": "kept" }).success).toBe(true);
    expect(schema.safeParse({ known: "a", note: "bare" }).success).toBe(false);
  });
});
