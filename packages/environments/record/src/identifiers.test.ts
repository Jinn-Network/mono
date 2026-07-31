import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  ENVIRONMENT_RECORD_KIND,
  ENVIRONMENT_RECORD_MEDIA_TYPE,
  ENVIRONMENT_RECORD_SCHEMA_ID,
} from "./identifiers.js";
import { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";

describe("identifiers", () => {
  test("the record kind is the exact string the design pins", () => {
    expect(ENVIRONMENT_RECORD_KIND).toBe("https://jinn.network/records/environment/1.0");
  });

  test("the record kind conforms to the discovery record-kind URI grammar", () => {
    // Mirror of `assertRecordKindUri`: `https://jinn.network/records/<segment>/<major>.<minor>`
    // with segment matching the discovery source-name grammar. This package cannot import
    // discovery (tier-2, zero Jinn dependencies); the authoritative check runs in the facts
    // leaf, which calls `assertRecordKindUri` on this constant.
    expect(ENVIRONMENT_RECORD_KIND).toMatch(
      /^https:\/\/jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/\d+\.\d+$/,
    );
  });

  test("the media type is the exact vendor-tree string the design pins", () => {
    expect(ENVIRONMENT_RECORD_MEDIA_TYPE).toBe("application/vnd.jinn.environment.v1+json");
  });

  test("the published schema id is derived from the record kind", () => {
    expect(ENVIRONMENT_RECORD_SCHEMA_ID).toBe(`${ENVIRONMENT_RECORD_KIND}/schema`);
  });
});

describe("namespaced extension keys", () => {
  test("accepts reverse-DNS and absolute-URI names", () => {
    expect(isNamespacedExtensionKey("network.jinn.note")).toBe(true);
    expect(isNamespacedExtensionKey("com.example.thing")).toBe(true);
    expect(isNamespacedExtensionKey("https://example.test/ext")).toBe(true);
  });

  test("rejects bare names", () => {
    expect(isNamespacedExtensionKey("note")).toBe(false);
    expect(isNamespacedExtensionKey("_private")).toBe(false);
    expect(isNamespacedExtensionKey("")).toBe(false);
  });

  test("topLevelRecordSchema admits namespaced extras and refuses bare ones", () => {
    const schema = topLevelRecordSchema({ known: z.string() });
    expect(schema.safeParse({ known: "a", "network.jinn.note": "kept" }).success).toBe(true);
    expect(schema.safeParse({ known: "a", note: "bare" }).success).toBe(false);
  });

  test("namespaced extras survive the parse round-trip rather than being stripped", () => {
    const schema = topLevelRecordSchema({ known: z.string() });
    const parsed = schema.parse({ known: "a", "network.jinn.note": "kept" });
    expect((parsed as Record<string, unknown>)["network.jinn.note"]).toBe("kept");
  });
});
