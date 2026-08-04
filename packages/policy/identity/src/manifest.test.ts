// SPDX-License-Identifier: MIT

/** Candidate-manifest conformance (substrate §5.1–§5.3, §8). */

import { describe, expect, it } from "vitest";

import {
  parseExactCandidateManifest,
  sealCandidateManifest,
  validateCandidateManifest,
} from "./conformance.js";
import { loadFixtureDirectory, readFixture } from "./fixtures.js";
import type { CandidateManifest, ValidationResult } from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

function issueCodes(result: ValidationResult): { code: string; path: string }[] {
  return result.ok ? [] : result.errors.map(({ code, path }) => ({ code, path }));
}

describe("candidate manifest — golden", () => {
  for (const fixture of loadFixtureDirectory("manifest", "golden")) {
    const manifest = fixture.input as CandidateManifest;
    const expected = fixture.expect as { digest: string; canonical: string; preservedExtensions?: string[] };

    it(`${fixture.name}: validates`, () => {
      expect(validateCandidateManifest(manifest).ok).toBe(true);
    });

    it(`${fixture.name}: seals to the pinned bytes and digest`, () => {
      const sealed = sealCandidateManifest(manifest);
      expect(decoder.decode(sealed.bytes)).toBe(expected.canonical);
      expect(sealed.digest).toBe(expected.digest);
    });

    it(`${fixture.name}: sealed bytes round-trip — parse then re-seal is byte-identical`, () => {
      const sealed = sealCandidateManifest(manifest);
      const reparsed = parseExactCandidateManifest(sealed.bytes);
      const resealed = sealCandidateManifest(reparsed);
      expect(resealed.bytes).toEqual(sealed.bytes);
      expect(resealed.digest).toBe(sealed.digest);
    });

    it(`${fixture.name}: non-canonical bytes carrying the same value are REJECTED`, () => {
      // Sealed once. Re-canonicalizing untrusted bytes and calling the result "the same
      // manifest" is how two hosts end up with two digests for one proposal.
      const nonCanonical = new TextEncoder().encode(` ${decoder.decode(sealCandidateManifest(manifest).bytes)}`);
      expect(() => parseExactCandidateManifest(nonCanonical)).toThrow();
    });

    if (expected.preservedExtensions !== undefined) {
      it(`${fixture.name}: namespaced extensions survive validation and sealing`, () => {
        const result = validateCandidateManifest(manifest);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        for (const key of expected.preservedExtensions ?? []) {
          expect(result.manifest[key]).toEqual((manifest as Record<string, unknown>)[key]);
          expect(decoder.decode(sealCandidateManifest(manifest).bytes)).toContain(JSON.stringify(key));
        }
      });
    }
  }
});

describe("candidate manifest — adversarial", () => {
  for (const fixture of loadFixtureDirectory("manifest", "adversarial")) {
    const expected = fixture.expect as { ok: false; code: string; path: string };

    it(`${fixture.name}: validation reports ${expected.code} at ${expected.path}`, () => {
      const result = validateCandidateManifest(fixture.input);
      expect(result.ok).toBe(false);
      expect(issueCodes(result)).toContainEqual({ code: expected.code, path: expected.path });
    });

    it(`${fixture.name}: sealing REFUSES — an invalid manifest never acquires an identity`, () => {
      expect(() => sealCandidateManifest(fixture.input as CandidateManifest)).toThrow();
    });
  }
});

describe("the no-self-score rule, in its checkable form (substrate §5.1/§5.3)", () => {
  const base = readFixture<{ input: CandidateManifest }>("manifest/golden/minimal.json").input;

  for (const field of ["score", "confidence", "rank", "fitness", "estimatedPassRate"]) {
    it(`rejects a top-level "${field}" field`, () => {
      const result = validateCandidateManifest({ ...base, [field]: 0.99 });
      expect(result.ok).toBe(false);
      expect(issueCodes(result)).toContainEqual({ code: "unrecognized-field", path: field });
    });
  }

  it("does NOT reject a score inside a namespaced extension — that is a consumer-MUST-IGNORE rule", () => {
    // Stated so the limit of the check is documented rather than discovered. §5.3:
    // "extension-borne self-assessment cannot be prevented by validation".
    const result = validateCandidateManifest({
      ...base,
      "network.example.selfAssessment": { score: 0.99 },
    });
    expect(result.ok).toBe(true);
  });
});

describe("namespaced-extension spellings (TEP §21.3)", () => {
  const base = readFixture<{ input: CandidateManifest }>("manifest/golden/minimal.json").input;

  it("accepts reverse-DNS and absolute-URI keys", () => {
    for (const key of ["network.example.notes", "https://example.org/vocab/x", "urn:example:y"]) {
      expect(validateCandidateManifest({ ...base, [key]: 1 }).ok).toBe(true);
    }
  });

  it("rejects bare, dotless, and hyphen-prefixed keys that only look namespaced", () => {
    for (const key of ["notes", "x-notes", "example_notes", ".leading", "trailing."]) {
      const result = validateCandidateManifest({ ...base, [key]: 1 });
      expect(result.ok).toBe(false);
      expect(issueCodes(result)).toContainEqual({ code: "unrecognized-field", path: key });
    }
  });
});

describe("what validation deliberately does NOT do (substrate §5.3)", () => {
  const base = readFixture<{ input: CandidateManifest }>("manifest/golden/multi-parent.json").input;

  it("does not fetch parents — an unresolvable parent digest still validates", () => {
    const result = validateCandidateManifest({
      ...base,
      parents: [{ kind: "candidate", digest: `sha256:${"f".repeat(64)}` }],
    });
    expect(result.ok).toBe(true);
  });

  it("does not require a signature — unsigned manifests are valid for local use", () => {
    // §5.2: cross-operator exchange and any adoption decision require the DSSE signature; the
    // requirement is the HOST's, not this validator's.
    expect(validateCandidateManifest(base).ok).toBe(true);
  });
});
