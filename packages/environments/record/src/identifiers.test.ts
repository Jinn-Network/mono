import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  ENVIRONMENT_RECORD_KIND,
  ENVIRONMENT_RECORD_MEDIA_TYPE,
  ENVIRONMENT_RECORD_SCHEMA_ID,
} from "./identifiers.js";
import { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";

// DUAL-ACCEPT (DR-2026-08-04 transition window): canonical
// `https://spec.jinn.network/records/<segment>/v<major>` and the legacy
// `https://jinn.network/records/<segment>/<major>.<minor>` this constant still
// spells. Reference implementation: packages/discovery/protocol/src/origins.ts.
// Component C2 narrows this to the canonical arm once the re-seal has landed.
const RECORD_KIND_GRAMMAR = /^https:\/\/(?:spec\.)?jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/(?:v[1-9]\d*|\d+\.\d+)$/;

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
      RECORD_KIND_GRAMMAR,
    );
  });

  test("the media type is the exact vendor-tree string the design pins", () => {
    expect(ENVIRONMENT_RECORD_MEDIA_TYPE).toBe("application/vnd.jinn.environment.v1+json");
  });

  test("the published schema id is derived from the record kind", () => {
    expect(ENVIRONMENT_RECORD_SCHEMA_ID).toBe(`${ENVIRONMENT_RECORD_KIND}/schema`);
  });

  // The mirrored grammar must already accept the spelling the re-seal will mint, because
  // C1's wave flips this package's constants and nothing else may need to move with them.
  // No constant here uses the canonical arm yet, so only this asserts it.
  test("the mirrored grammar accepts the canonical re-seal spelling", () => {
    expect("https://spec.jinn.network/records/environment/v1").toMatch(RECORD_KIND_GRAMMAR);
    expect("https://spec.jinn.network/records/environment/v2").toMatch(RECORD_KIND_GRAMMAR);
    expect("https://jinn.network/records/environment/1.0").toMatch(RECORD_KIND_GRAMMAR);
    for (const rejected of [
      "https://spec.jinn.network/records/environment/v0",
      "https://spec.jinn.network/records/environment/1",
      "https://spec.jinn.network/records/environment/v1/facts/v1",
      "https://evil.jinn.network/records/environment/v1",
      "https://jinn.network.evil.example/records/environment/v1",
    ]) {
      expect(rejected).not.toMatch(RECORD_KIND_GRAMMAR);
    }
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

  // `new URL` tolerates whitespace by percent-encoding it, which the published schema's
  // `[^\s]+` does not. Sealing a key this package accepts and the schema it publishes
  // rejects would hand a third party a different verdict on the same record.
  test("rejects a URI name carrying whitespace, as the published schema does", () => {
    expect(isNamespacedExtensionKey("http://example.test/ext a")).toBe(false);
    expect(isNamespacedExtensionKey("http://example.test/\text")).toBe(false);
    expect(isNamespacedExtensionKey("http://example.test/ext")).toBe(true);
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
