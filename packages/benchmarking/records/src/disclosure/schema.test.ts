/**
 * The disclosure-specification record's structural law (design §3–§5, test matrix §11 T2–T5, T25).
 *
 * Every fixture below is synthetic placeholder prose written for this test file. No third-party
 * prompt, dataset row, annotation, or audit-derived byte appears here (R7, §12.3).
 */

import { describe, expect, it } from "vitest";
import {
  DISCLOSURE_SPECIFICATION_RECORD_KIND,
  MATRIX_RECORD_KIND,
  SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
} from "../identifiers.js";
import { InvalidDocumentError } from "../sealing.js";
import {
  DISCLOSURE_VARIABLE_KEYS,
  DisclosureSpecificationSchema,
  parseDisclosureSpecification,
  sealDisclosureSpecification,
  type DisclosureVariableEntry,
} from "./schema.js";

const SUBJECT_DIGEST = "1".repeat(64);
// Deliberately carries hex letters: the uppercase-refusal test below is vacuous over an all-digit
// digest, because `"2".repeat(64).toUpperCase()` is the same string.
const PINNED_A = "2a".repeat(32);
const PINNED_B = "3".repeat(64);
const OBSERVED = "4".repeat(64);

function measured(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    status: "measured-here",
    statement: "One dated model snapshot, fixed for every arm, with sampling frozen by the sealed instrument.",
    evidence: [{ role: "pinned-configuration", digest: { sha256: PINNED_A } }],
    ...overrides,
  };
}

function asserted(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    status: "disclosed-by-publisher",
    statement: "Fixed and stated by the upstream collection; this venue ran none of it.",
    ...overrides,
  };
}

function undisclosed(reason = "not-stated"): Record<string, unknown> {
  return { status: "undisclosed", reason };
}

function record(variables: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: DISCLOSURE_SPECIFICATION_RECORD_KIND,
    specification: SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
    author: "did:key:zPlaceholderAuthorIdentity",
    subject: { kind: MATRIX_RECORD_KIND, digest: { sha256: SUBJECT_DIGEST } },
    variables: {
      "ingestion-model": undisclosed(),
      "retrieval-config": undisclosed(),
      "answer-model": asserted(),
      "answer-prompt": asserted(),
      "judge-model": measured(),
      "judge-prompt": measured(),
      ...variables,
    },
  };
}

describe("the disclosure-specification record admits exactly the design's three statuses", () => {
  it("seals a six-variable record and re-parses to the same bytes", () => {
    const sealed = sealDisclosureSpecification(record());
    expect(sealed.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const parsed = parseDisclosureSpecification(sealed.bytes);
    expect(Object.keys(parsed.variables).sort()).toEqual([...DISCLOSURE_VARIABLE_KEYS].sort());
    expect(sealDisclosureSpecification(parsed).bytes).toEqual(sealed.bytes);
  });

  it("carries an assertion with no source, and says so by omission rather than by a placeholder URI", () => {
    const parsed = DisclosureSpecificationSchema.parse(record());
    const answerPrompt = parsed.variables["answer-prompt"] as DisclosureVariableEntry;
    expect(answerPrompt.status).toBe("disclosed-by-publisher");
    expect("sources" in answerPrompt ? answerPrompt.sources : undefined).toBeUndefined();
  });

  it("admits all three undisclosed reason tokens and refuses a fourth", () => {
    for (const reason of ["not-stated", "stated-without-identifiers", "outside-this-experiment"]) {
      expect(DisclosureSpecificationSchema.safeParse(
        record({ "ingestion-model": undisclosed(reason) }),
      ).success).toBe(true);
    }
    expect(DisclosureSpecificationSchema.safeParse(
      record({ "ingestion-model": undisclosed("unknown-to-this-venue") }),
    ).success).toBe(false);
  });
});

describe("R3 — evidence is representable on exactly one status (§11 T2, T3)", () => {
  it("T2: an assertion carrying an evidence key refuses at parse", () => {
    const result = DisclosureSpecificationSchema.safeParse(record({
      "answer-model": asserted({ evidence: [{ role: "pinned-configuration", digest: { sha256: PINNED_A } }] }),
    }));
    expect(result.success).toBe(false);
  });

  it("T3: an undisclosed entry carrying a statement refuses at parse", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({
      "retrieval-config": { status: "undisclosed", reason: "not-stated", statement: "vaguely named" },
    })).success).toBe(false);
  });

  it("an undisclosed entry carrying sources refuses too — the branch has no field for one", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({
      "retrieval-config": { status: "undisclosed", reason: "not-stated", sources: [{ uri: "https://example.invalid/a" }] },
    })).success).toBe(false);
  });
});

describe("R2 — all six variables, always (§11 T4, T5)", () => {
  it("T4: a record missing one of the six refuses, naming the missing key", () => {
    const incomplete = record() as { variables: Record<string, unknown> };
    delete incomplete.variables["judge-prompt"];
    const result = DisclosureSpecificationSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "variables.judge-prompt")).toBe(true);
  });

  it("T5: a record carrying a seventh variable refuses, naming the unknown key", () => {
    const result = DisclosureSpecificationSchema.safeParse(record({ "judge-input-shape": measured() }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("judge-input-shape");
  });
});

describe("R6 — strict everywhere; unknown keys fail closed", () => {
  it("refuses an unknown top-level key", () => {
    expect(DisclosureSpecificationSchema.safeParse({ ...record(), completenessScore: 2 }).success).toBe(false);
  });

  it("refuses a second digest algorithm on the subject", () => {
    expect(DisclosureSpecificationSchema.safeParse({
      ...record(),
      subject: { kind: MATRIX_RECORD_KIND, digest: { sha256: SUBJECT_DIGEST, sha512: "ff" } },
    }).success).toBe(false);
  });

  it("refuses a non-literal kind or specification", () => {
    expect(DisclosureSpecificationSchema.safeParse({ ...record(), kind: `${DISCLOSURE_SPECIFICATION_RECORD_KIND}x` }).success).toBe(false);
    expect(DisclosureSpecificationSchema.safeParse({ ...record(), specification: "https://example.invalid/other" }).success).toBe(false);
  });

  it("refuses a relative author IRI and an empty statement", () => {
    expect(DisclosureSpecificationSchema.safeParse({ ...record(), author: "not-an-iri" }).success).toBe(false);
    expect(DisclosureSpecificationSchema.safeParse(record({ "judge-model": measured({ statement: "" }) })).success).toBe(false);
  });

  it("refuses a statement longer than the 1024-character bound", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({ "judge-model": measured({ statement: "a".repeat(1025) }) })).success).toBe(false);
    expect(DisclosureSpecificationSchema.safeParse(record({ "judge-model": measured({ statement: "a".repeat(1024) }) })).success).toBe(true);
  });

  it("refuses bytes that are not the one exact canonical encoding", () => {
    const sealed = sealDisclosureSpecification(record());
    const respelled = new TextEncoder().encode(` ${new TextDecoder().decode(sealed.bytes)}`);
    expect(() => parseDisclosureSpecification(respelled)).toThrow(InvalidDocumentError);
  });
});

describe("measured-here evidence discipline (§4.3)", () => {
  it("refuses a measurement citing only execution observations", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({
      "judge-model": measured({ evidence: [{ role: "execution-observation", digest: { sha256: OBSERVED } }] }),
    })).success).toBe(false);
  });

  it("refuses an empty evidence list", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({ "judge-model": measured({ evidence: [] }) })).success).toBe(false);
  });

  it("refuses unsorted and duplicated citations, and admits the sorted form", () => {
    const sorted = [
      { role: "execution-observation", digest: { sha256: OBSERVED } },
      { role: "pinned-configuration", digest: { sha256: PINNED_A } },
      { role: "pinned-configuration", digest: { sha256: PINNED_B } },
    ];
    expect(DisclosureSpecificationSchema.safeParse(record({ "judge-model": measured({ evidence: sorted }) })).success).toBe(true);
    expect(DisclosureSpecificationSchema.safeParse(record({
      "judge-model": measured({ evidence: [sorted[1], sorted[0], sorted[2]] }),
    })).success).toBe(false);
    expect(DisclosureSpecificationSchema.safeParse(record({
      "judge-model": measured({ evidence: [sorted[1], sorted[1]] }),
    })).success).toBe(false);
  });

  it("refuses an unknown evidence role and an uppercase digest", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({
      "judge-model": measured({ evidence: [{ role: "attested-configuration", digest: { sha256: PINNED_A } }] }),
    })).success).toBe(false);
    expect(DisclosureSpecificationSchema.safeParse(record({
      "judge-model": measured({ evidence: [{ role: "pinned-configuration", digest: { sha256: PINNED_A.toUpperCase() } }] }),
    })).success).toBe(false);
  });
});

describe("T25 — sources unsorted, or carrying a duplicate uri", () => {
  it("admits a sorted, unique source list", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({
      "answer-model": asserted({ sources: [{ uri: "https://example.invalid/a" }, { uri: "https://example.invalid/b" }] }),
    })).success).toBe(true);
  });

  it("refuses an unsorted list", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({
      "answer-model": asserted({ sources: [{ uri: "https://example.invalid/b" }, { uri: "https://example.invalid/a" }] }),
    })).success).toBe(false);
  });

  it("refuses a duplicate uri", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({
      "answer-model": asserted({ sources: [{ uri: "https://example.invalid/a" }, { uri: "https://example.invalid/a" }] }),
    })).success).toBe(false);
  });

  it("refuses an empty sources array — absent and empty are different claims", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({ "answer-model": asserted({ sources: [] }) })).success).toBe(false);
  });

  it("refuses a relative source uri", () => {
    expect(DisclosureSpecificationSchema.safeParse(record({
      "answer-model": asserted({ sources: [{ uri: "/relative/path" }] }),
    })).success).toBe(false);
  });
});
