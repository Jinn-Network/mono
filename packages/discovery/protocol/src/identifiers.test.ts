import { describe, expect, it } from "vitest";
import { assertRecordKindUri } from "./grammar.js";
import { RECORD_KINDS } from "./identifiers.js";

describe("RECORD_KINDS", () => {
  it("pins every kind as a conforming records-root URI", () => {
    for (const uri of Object.values(RECORD_KINDS)) {
      expect(() => assertRecordKindUri(uri)).not.toThrow();
    }
  });

  it("mints announcement-entry so an entry digest has a normative subject.kind", () => {
    expect(RECORD_KINDS.announcementEntry).toBe(
      "https://spec.jinn.network/records/announcement-entry/v1",
    );
  });
});
