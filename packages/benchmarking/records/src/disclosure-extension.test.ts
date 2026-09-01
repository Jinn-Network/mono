/**
 * The `disclosure-specification/v1` Report extension (design §6.3; test matrix §11 T13).
 *
 * The whole binding rests on the Report record's loose-object extension retention: an unknown
 * absolute-URI key must survive parse → re-seal → byte-compare, because that is exactly what the
 * bundle verifier does to `report.json` before it reads the extension. T13 asserts it explicitly
 * rather than assuming it, and the negative half asserts the Report schema still refuses a
 * non-namespaced key so "loose" does not quietly mean "open".
 */

import { describe, expect, it } from "vitest";
import { DISCLOSURE_SPECIFICATION_EXTENSION, DISCLOSURE_SPECIFICATION_MEDIA_TYPE } from "./identifiers.js";
import { parseReport, sealReport } from "./report/schema.js";
import {
  ReportDisclosureExtensionSchema,
  readReportDisclosureExtension,
  withReportDisclosureExtension,
} from "./disclosure-extension.js";

const SUBJECT_DIGEST = "a".repeat(64);
const RECORD_DIGEST = "b".repeat(64);

const report = {
  protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
  subjects: [{ name: "sealed", digest: { sha256: SUBJECT_DIGEST } }],
  method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
  results: {},
  disclosures: {
    perSubject: [{
      subjectSha256: SUBJECT_DIGEST,
      integrityTiers: { "re-derivable": 0, "attested-only": 0 },
      pinning: {
        harness: { match: 0, mismatch: 0, unverifiable: 0 },
        model: { match: 0, mismatch: 0, unverifiable: 0 },
        loadout: { match: 0, mismatch: 0, unverifiable: 0 },
        isolation: { match: 0, mismatch: 0, unverifiable: 0 },
      },
      independence: 0,
      completeness: { expected: 0, judged: 0, floor: "1", runOutcome: "partial" },
      attrition: { perArm: {}, asymmetryFlags: [] },
    }],
  },
  author: "did:example:publisher",
};

const descriptor = {
  name: "disclosure-specification",
  mediaType: DISCLOSURE_SPECIFICATION_MEDIA_TYPE,
  digest: { sha256: RECORD_DIGEST },
};

describe("T13 — the Report record carries the extension and keeps its exact bytes", () => {
  it("parse → re-seal is byte-identical with the extension present", () => {
    const sealed = sealReport(withReportDisclosureExtension(report, descriptor));
    expect(sealReport(parseReport(sealed.bytes)).bytes).toEqual(sealed.bytes);
  });

  it("reads the descriptor back off the parsed record", () => {
    const sealed = sealReport(withReportDisclosureExtension(report, descriptor));
    expect(readReportDisclosureExtension(parseReport(sealed.bytes) as unknown as Record<string, unknown>))
      .toEqual(descriptor);
  });

  it("a Report with no extension reads back undefined and keeps its own bytes", () => {
    const sealed = sealReport(report);
    expect(readReportDisclosureExtension(parseReport(sealed.bytes) as unknown as Record<string, unknown>))
      .toBeUndefined();
    // The extension is strictly additive: the same document without it seals to exactly what it
    // sealed to before this extension existed.
    expect(sealReport(parseReport(sealed.bytes)).bytes).toEqual(sealed.bytes);
    expect(sealed.bytes).not.toEqual(sealReport(withReportDisclosureExtension(report, descriptor)).bytes);
  });

  it("the extension key is the design's absolute URI and lands under it verbatim", () => {
    const carried = withReportDisclosureExtension(report, descriptor);
    expect(DISCLOSURE_SPECIFICATION_EXTENSION)
      .toBe("https://spec.jinn.network/extensions/disclosure-specification/v1");
    expect(carried[DISCLOSURE_SPECIFICATION_EXTENSION]).toEqual(descriptor);
  });
});

describe("the descriptor is digest-identified — a hint can never substitute for it", () => {
  it("refuses a descriptor with no digest and one whose digest is malformed", () => {
    expect(ReportDisclosureExtensionSchema.safeParse({ name: "d", uri: "https://example.invalid/d" }).success).toBe(false);
    expect(ReportDisclosureExtensionSchema.safeParse({ name: "d", digest: { sha256: "short" } }).success).toBe(false);
  });

  it("admits an optional acquisition URI alongside the digest", () => {
    expect(ReportDisclosureExtensionSchema.safeParse({ ...descriptor, uri: "https://example.invalid/record" }).success)
      .toBe(true);
  });

  it("refuses a non-namespaced extension key on the Report record itself", () => {
    expect(() => sealReport({ ...report, disclosure: descriptor })).toThrow();
  });
});
