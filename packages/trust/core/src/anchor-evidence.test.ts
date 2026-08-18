import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  ANCHOR_EVIDENCE_KIND,
  ANCHOR_EVIDENCE_MEDIA_TYPE,
} from "./identifiers.js";
import {
  ANCHOR_PROOF_MAX_DECODED_BYTES,
  AnchorEvidenceSchema,
  decodeAnchorProofContent,
  parseExactAnchorEvidence,
  sealAnchorEvidence,
  validateAnchorEvidence,
} from "./anchor-evidence.js";
import { canonicalJsonBytes } from "./canonical-json.js";
import { TrustCoreError } from "./errors.js";

// A record shaped exactly like the design §5 example. The subject digest is
// the SHA-256 of the ASCII string "jinn/anchor-evidence-v1/golden-subject"
// and the proof content is the base64 of
// "jinn/anchor-evidence-v1/golden-placeholder-proof" -- synthetic, but real
// values rather than repeated-nibble placeholders.
const VALID_ANCHOR_EVIDENCE = {
  kind: ANCHOR_EVIDENCE_KIND,
  subject: {
    kind: "https://spec.jinn.network/records/benchmark-run/v1",
    digest: {
      sha256: "0e1319b7648dfb4b2c2dac7f07621dca2c03b9277fd515c5800b014dd55786a5",
    },
  },
  provider: "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
  proof: {
    mediaType: "application/vnd.etsi.timestamp-token",
    content: "amlubi9hbmNob3ItZXZpZGVuY2UtdjEvZ29sZGVuLXBsYWNlaG9sZGVyLXByb29m",
  },
} as const;

/** Canonical, all-zero-byte base64 of exactly `byteLength` decoded bytes. */
function zeroBase64(byteLength: number): string {
  const remainder = byteLength % 3;
  return "A".repeat(Math.floor(byteLength / 3) * 4)
    + (remainder === 0 ? "" : remainder === 1 ? "AA==" : "AAA=");
}

function bytesOf(record: unknown): Uint8Array {
  return canonicalJsonBytes(record);
}

function codesOf(bytes: Uint8Array): readonly string[] {
  return validateAnchorEvidence(bytes).diagnostics.map((diagnostic) => diagnostic.code);
}

describe("anchor-evidence identifiers", () => {
  test("the record kind and media type are the design §5 spellings", () => {
    expect(ANCHOR_EVIDENCE_KIND).toBe("https://spec.jinn.network/records/anchor-evidence/v1");
    expect(ANCHOR_EVIDENCE_MEDIA_TYPE).toBe("application/vnd.jinn.anchor-evidence.v1+json");
  });
});

describe("validateAnchorEvidence — the conforming record", () => {
  test("the §5 example shape conforms and round-trips its value", () => {
    const { bytes } = sealAnchorEvidence(VALID_ANCHOR_EVIDENCE);
    const report = validateAnchorEvidence(bytes);
    expect(report.conforms).toBe(true);
    expect(report.diagnostics).toEqual([]);
    expect(report.value).toEqual(VALID_ANCHOR_EVIDENCE);
  });

  test("proof content of exactly 64 KiB decoded is admitted (the §5 rule 2 cap is inclusive)", () => {
    const atCap = {
      ...VALID_ANCHOR_EVIDENCE,
      proof: {
        ...VALID_ANCHOR_EVIDENCE.proof,
        content: zeroBase64(ANCHOR_PROOF_MAX_DECODED_BYTES),
      },
    };
    expect(validateAnchorEvidence(bytesOf(atCap)).conforms).toBe(true);
  });
});

// §5 rule 1 (exactly one subject; sha256 is the only admitted algorithm) and
// §8 step 1 (strict schema; unknown keys fail closed).
describe("validateAnchorEvidence — strict schema battery", () => {
  test("an unknown top-level key fails closed", () => {
    const bytes = bytesOf({ ...VALID_ANCHOR_EVIDENCE, anchoredAt: "2026-08-17T00:00:00Z" });
    const report = validateAnchorEvidence(bytes);
    expect(report.conforms).toBe(false);
    expect(report.diagnostics.some((d) => d.code === "SCHEMA_VIOLATION")).toBe(true);
  });

  test("an unknown nested key under subject fails closed", () => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      subject: { ...VALID_ANCHOR_EVIDENCE.subject, name: "run.json" },
    });
    expect(codesOf(bytes)).toContain("SCHEMA_VIOLATION");
  });

  test("an unknown nested key under proof fails closed", () => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      proof: { ...VALID_ANCHOR_EVIDENCE.proof, descriptor: { uri: "ipfs://…" } },
    });
    expect(codesOf(bytes)).toContain("SCHEMA_VIOLATION");
  });

  test("a second digest algorithm alongside sha256 fails closed (§5 rule 1: sha256 is the only admitted algorithm)", () => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      subject: {
        ...VALID_ANCHOR_EVIDENCE.subject,
        digest: {
          sha256: VALID_ANCHOR_EVIDENCE.subject.digest.sha256,
          sha512: "a".repeat(128),
        },
      },
    });
    expect(codesOf(bytes)).toContain("SCHEMA_VIOLATION");
  });

  test("a subject array fails closed (§5 rule 1: exactly one subject)", () => {
    const bytes = bytesOf({ ...VALID_ANCHOR_EVIDENCE, subject: [VALID_ANCHOR_EVIDENCE.subject] });
    expect(codesOf(bytes)).toContain("SCHEMA_VIOLATION");
  });

  test("an uppercase-hex subject digest fails closed", () => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      subject: {
        ...VALID_ANCHOR_EVIDENCE.subject,
        digest: { sha256: VALID_ANCHOR_EVIDENCE.subject.digest.sha256.toUpperCase() },
      },
    });
    expect(codesOf(bytes)).toContain("SCHEMA_VIOLATION");
  });

  test("a truncated (63-character) subject digest fails closed", () => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      subject: {
        ...VALID_ANCHOR_EVIDENCE.subject,
        digest: { sha256: VALID_ANCHOR_EVIDENCE.subject.digest.sha256.slice(0, 63) },
      },
    });
    expect(codesOf(bytes)).toContain("SCHEMA_VIOLATION");
  });

  test("a `sha256:`-prefixed digest string fails closed (the record carries the in-toto DigestSet shape)", () => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      subject: {
        ...VALID_ANCHOR_EVIDENCE.subject,
        digest: `sha256:${VALID_ANCHOR_EVIDENCE.subject.digest.sha256}`,
      },
    });
    expect(codesOf(bytes)).toContain("SCHEMA_VIOLATION");
  });

  test("a wrong `kind` literal fails closed", () => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      kind: "https://spec.jinn.network/records/anchor-evidence/v2",
    });
    expect(codesOf(bytes)).toContain("SCHEMA_VIOLATION");
  });

  test.each(["kind", "subject", "provider", "proof"])("a record missing %s fails closed", (field) => {
    const partial: Record<string, unknown> = { ...VALID_ANCHOR_EVIDENCE };
    delete partial[field];
    expect(codesOf(bytesOf(partial))).toContain("SCHEMA_VIOLATION");
  });

  test("a non-absolute subject kind or provider URI fails closed", () => {
    expect(codesOf(bytesOf({ ...VALID_ANCHOR_EVIDENCE, provider: "rfc3161-tsa" })))
      .toContain("SCHEMA_VIOLATION");
    expect(codesOf(bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      subject: { ...VALID_ANCHOR_EVIDENCE.subject, kind: "/records/benchmark-run/v1" },
    }))).toContain("SCHEMA_VIOLATION");
  });

  test("an empty proof media type fails closed", () => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      proof: { ...VALID_ANCHOR_EVIDENCE.proof, mediaType: "" },
    });
    expect(codesOf(bytes)).toContain("SCHEMA_VIOLATION");
  });
});

// §5 rule 2: the proof bytes are carried exactly, inline only, capped at 64 KiB.
describe("validateAnchorEvidence — proof-content rules (§5 rule 2)", () => {
  test.each([
    ["not base64 at all", "not base64!!"],
    // Length is a clean multiple of 4, so this reaches the alphabet check
    // instead of being turned away by the length test.
    ["whitespace-wrapped", "amlu bi9"],
    ["unpadded", "amlubi9hbmNob3ItZXZpZGVuY2UtdjEvZ29sZGVuLXBsYWNlaG9sZGVyLXByb29"],
    ["url-safe alphabet", "a-lu_i9hbmNob3ItZXZpZGVuY2UtdjEvZ29sZGVuLXBsYWNlaG9sZGVyLXByb29m"],
    ["non-canonical trailing bits under two-character padding", "AB=="],
    ["non-canonical trailing bits under one-character padding", "ABC="],
    ["empty", ""],
  ])("proof content that is %s fails with PROOF_CONTENT_NOT_BASE64", (_label, content) => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      proof: { ...VALID_ANCHOR_EVIDENCE.proof, content },
    });
    const report = validateAnchorEvidence(bytes);
    expect(report.conforms).toBe(false);
    expect(report.diagnostics.map((d) => d.code)).toContain("PROOF_CONTENT_NOT_BASE64");
  });

  test("proof content decoding to more than 64 KiB fails with PROOF_CONTENT_TOO_LARGE", () => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      proof: {
        ...VALID_ANCHOR_EVIDENCE.proof,
        content: zeroBase64(ANCHOR_PROOF_MAX_DECODED_BYTES + 1),
      },
    });
    const report = validateAnchorEvidence(bytes);
    expect(report.conforms).toBe(false);
    expect(report.diagnostics.map((d) => d.code)).toContain("PROOF_CONTENT_TOO_LARGE");
    expect(report.diagnostics[0]?.path).toBe("proof.content");
  });
});

describe("validateAnchorEvidence never throws", () => {
  test.each([
    ["empty bytes", new Uint8Array()],
    ["invalid UTF-8", new Uint8Array([0xff, 0xfe, 0xfd])],
    ["truncated JSON", new TextEncoder().encode("{\"kind\":")],
    ["a JSON array", new TextEncoder().encode("[]")],
    ["a JSON string", new TextEncoder().encode("\"anchor\"")],
  ])("garbage input (%s) reports a diagnostic instead of throwing", (_label, bytes) => {
    const report = validateAnchorEvidence(bytes);
    expect(report.conforms).toBe(false);
    expect(report.diagnostics.length).toBeGreaterThan(0);
    expect(report.value).toBeUndefined();
  });

  test("non-JSON bytes are reported as PAYLOAD_NOT_JSON", () => {
    expect(codesOf(new Uint8Array([0xff, 0xfe]))).toEqual(["PAYLOAD_NOT_JSON"]);
  });
});

describe("sealAnchorEvidence", () => {
  test("sealing is deterministic and the digest is the SHA-256 of the exact sealed bytes", () => {
    const first = sealAnchorEvidence(VALID_ANCHOR_EVIDENCE);
    const second = sealAnchorEvidence(VALID_ANCHOR_EVIDENCE);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.recordDigest).toBe(second.recordDigest);
    expect(first.recordDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("the sealed bytes are the bare record — no DSSE envelope, no signature (§5 rule 4)", () => {
    const { bytes } = sealAnchorEvidence(VALID_ANCHOR_EVIDENCE);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["kind", "proof", "provider", "subject"]);
  });

  test("a schema-nonconforming record is refused with a typed INVALID_INPUT error", () => {
    expect(() => sealAnchorEvidence({ ...VALID_ANCHOR_EVIDENCE, extra: 1 } as never))
      .toThrow(TrustCoreError);
    try {
      sealAnchorEvidence({ ...VALID_ANCHOR_EVIDENCE, extra: 1 } as never);
    } catch (error) {
      expect((error as TrustCoreError).code).toBe("INVALID_INPUT");
    }
  });

  test("an over-cap or non-base64 proof is refused at seal time, never stored", () => {
    expect(() => sealAnchorEvidence({
      ...VALID_ANCHOR_EVIDENCE,
      proof: { ...VALID_ANCHOR_EVIDENCE.proof, content: zeroBase64(ANCHOR_PROOF_MAX_DECODED_BYTES + 1) },
    })).toThrow(TrustCoreError);
    expect(() => sealAnchorEvidence({
      ...VALID_ANCHOR_EVIDENCE,
      proof: { ...VALID_ANCHOR_EVIDENCE.proof, content: "not base64!!" },
    })).toThrow(TrustCoreError);
  });
});

describe("parseExactAnchorEvidence", () => {
  test("seal → parse round-trips the record with byte identity", () => {
    const { bytes } = sealAnchorEvidence(VALID_ANCHOR_EVIDENCE);
    const parsed = parseExactAnchorEvidence(bytes);
    expect(parsed).toEqual(VALID_ANCHOR_EVIDENCE);
    expect(sealAnchorEvidence(parsed).bytes).toEqual(bytes);
  });

  test("bytes that are not the exact sealed encoding are refused", () => {
    const pretty = new TextEncoder().encode(JSON.stringify(VALID_ANCHOR_EVIDENCE, null, 2));
    expect(() => parseExactAnchorEvidence(pretty)).toThrow(TrustCoreError);
  });

  test("a BOM-prefixed spelling of a conforming record is refused, though validate still reports it conforming", () => {
    const { bytes } = sealAnchorEvidence(VALID_ANCHOR_EVIDENCE);
    const withBom = new Uint8Array(bytes.length + 3);
    withBom.set([0xef, 0xbb, 0xbf]);
    withBom.set(bytes, 3);
    // The UTF-8 decoder strips the BOM, so schema conformance survives it --
    // which is exactly why exactness is parseExact's job and never validate's.
    expect(validateAnchorEvidence(withBom).conforms).toBe(true);
    expect(() => parseExactAnchorEvidence(withBom)).toThrow(TrustCoreError);
  });

  test("a nonconforming record is refused rather than repaired", () => {
    const bytes = bytesOf({ ...VALID_ANCHOR_EVIDENCE, provider: "rfc3161-tsa" });
    expect(() => parseExactAnchorEvidence(bytes)).toThrow(TrustCoreError);
  });

  test("a proof over the inline cap is refused on parse as well as on seal", () => {
    const bytes = bytesOf({
      ...VALID_ANCHOR_EVIDENCE,
      proof: {
        ...VALID_ANCHOR_EVIDENCE.proof,
        content: zeroBase64(ANCHOR_PROOF_MAX_DECODED_BYTES + 1),
      },
    });
    expect(() => parseExactAnchorEvidence(bytes)).toThrow(TrustCoreError);
  });
});

describe("decodeAnchorProofContent", () => {
  test("round-trips the golden proof content to its exact bytes", () => {
    const decoded = decodeAnchorProofContent(VALID_ANCHOR_EVIDENCE.proof.content);
    expect(decoded).toEqual(
      new TextEncoder().encode("jinn/anchor-evidence-v1/golden-placeholder-proof"),
    );
    expect(decodeAnchorProofContent(zeroBase64(ANCHOR_PROOF_MAX_DECODED_BYTES)).length)
      .toBe(ANCHOR_PROOF_MAX_DECODED_BYTES);
  });

  test("refuses the URL-safe alphabet that the DSSE envelope decoder would accept", () => {
    expect(() => decodeAnchorProofContent("a-lu_i9hbmNob3ItZXZpZGVuY2UtdjEvZ29sZGVu"))
      .toThrow(TrustCoreError);
  });
});

describe("AnchorEvidenceSchema", () => {
  test("parses the conforming record and rejects an unknown key", () => {
    expect(AnchorEvidenceSchema.safeParse(VALID_ANCHOR_EVIDENCE).success).toBe(true);
    expect(AnchorEvidenceSchema.safeParse({ ...VALID_ANCHOR_EVIDENCE, note: "x" }).success).toBe(false);
  });
});

describe("sealAnchorEvidence pinned-digest golden", () => {
  const goldenPath = fileURLToPath(
    new URL("../fixtures/anchor-evidence-v1/golden.json", import.meta.url),
  );
  const golden: unknown = JSON.parse(readFileSync(goldenPath, "utf8"));

  const expectedDigestsPath = fileURLToPath(
    new URL("../fixtures/anchor-evidence-v1/expected-digests.json", import.meta.url),
  );
  const expectedDigests: Record<string, string> = JSON.parse(
    readFileSync(expectedDigestsPath, "utf8"),
  );

  test("sealAnchorEvidence produces bytes whose recordDigest matches the pinned golden digest", () => {
    const sealed = sealAnchorEvidence(golden as never);
    const expected = expectedDigests["anchor-evidence-golden"];
    if (expected === undefined) {
      throw new Error(
        `No pinned digest for "anchor-evidence-golden" yet -- actual digest: ${sealed.recordDigest}\n`
          + "Paste this into fixtures/anchor-evidence-v1/expected-digests.json and re-run.",
      );
    }
    expect(sealed.recordDigest).toBe(expected);
  });
});
