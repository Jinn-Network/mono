// SPDX-License-Identifier: Apache-2.0

/**
 * The disclosed closure's projection, role binding, and record-level check (issue #2839;
 * disclosure-specification-record design §6.2, §6.4, §6.6, §7; test matrix §11 T6-T8, T20, T21,
 * T23, T24).
 *
 * Every fixture here is synthetic placeholder prose written for this file. No third-party prompt,
 * dataset row, annotation, or audit-derived byte appears (design R7, §12.3).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  DISCLOSURE_SPECIFICATION_RECORD_KIND,
  MATRIX_RECORD_KIND,
  SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
  sealDisclosureSpecification,
} from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { BUNDLE_EVIDENCE_ROLES, BUNDLE_V4_ADMISSION_EVIDENCE_ROLES, BUNDLE_V4_EVIDENCE_ROLES } from "../schema.js";
import { BenchmarkProductError } from "./errors.js";
import {
  DISCLOSURE_ROLE_BINDING,
  DISCLOSURE_SPECIFICATION_BUNDLE_ROLE,
  DisclosureProjectionError,
  assertDisclosureSpecification,
  deriveDisclosureSpecification,
} from "./disclosure.js";

const MATRIX_SHA256 = "a".repeat(64);
const AUTHOR = "did:key:zPlaceholderAuthorIdentity";
const INSTRUMENT_SHA256 = "b".repeat(64);
const VERDICT_SHA256 = "c".repeat(64);

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: DISCLOSURE_SPECIFICATION_RECORD_KIND,
    specification: SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
    author: AUTHOR,
    subject: { kind: MATRIX_RECORD_KIND, digest: { sha256: MATRIX_SHA256 } },
    variables: {
      "ingestion-model": { status: "undisclosed", reason: "not-stated" },
      "retrieval-config": { status: "undisclosed", reason: "not-stated" },
      "answer-model": {
        status: "disclosed-by-publisher",
        statement: "Fixed and stated by the upstream collection; this venue executed none of it.",
      },
      "answer-prompt": {
        status: "disclosed-by-publisher",
        statement: "Described in the source collection and not re-executed here.",
      },
      "judge-model": {
        status: "measured-here",
        statement: "One dated model snapshot, fixed for every arm, with sampling frozen by the sealed instrument.",
        evidence: [
          { role: "execution-observation", digest: { sha256: VERDICT_SHA256 } },
          { role: "pinned-configuration", digest: { sha256: INSTRUMENT_SHA256 } },
        ],
      },
      "judge-prompt": {
        status: "measured-here",
        statement: "Sealed grading instruments, each with its own frozen template digest.",
        evidence: [{ role: "pinned-configuration", digest: { sha256: INSTRUMENT_SHA256 } }],
      },
    },
    ...overrides,
  };
}

function sealed(overrides: Record<string, unknown> = {}): { bytes: Uint8Array; sha256: string } {
  const result = sealDisclosureSpecification(record(overrides));
  return { bytes: result.bytes, sha256: result.digest.slice("sha256:".length) };
}

/** The refuse the verifier hands in, in the shape it hands it in: a typed product refusal whose
 * first issue carries the path. */
function refuse(path: string, message: string): never {
  throw new BenchmarkProductError("record-integrity", message, [{ path, message }]);
}

interface CheckOverrides {
  readonly catalogRoles?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly recordBytes?: ReadonlyMap<string, Uint8Array>;
  readonly extensionDigestSha256?: string;
  readonly matrixSha256?: string;
  readonly reportAuthor?: string;
}

function check(recordOverrides: Record<string, unknown> = {}, overrides: CheckOverrides = {}) {
  const { bytes, sha256 } = sealed(recordOverrides);
  return assertDisclosureSpecification({
    extensionDigestSha256: overrides.extensionDigestSha256 ?? sha256,
    catalogRoles: overrides.catalogRoles ?? new Map<string, ReadonlySet<string>>([
      [sha256, new Set([DISCLOSURE_SPECIFICATION_BUNDLE_ROLE])],
      [INSTRUMENT_SHA256, new Set(["judge-instrument"])],
      [VERDICT_SHA256, new Set(["verdict"])],
    ]),
    recordBytes: overrides.recordBytes ?? new Map([[sha256, bytes]]),
    matrixSha256: overrides.matrixSha256 ?? MATRIX_SHA256,
    reportAuthor: overrides.reportAuthor ?? AUTHOR,
    refuse,
  });
}

function digestOf(value: readonly string[]): string {
  return createHash("sha256").update(canonicalJsonBytes([...value])).digest("hex");
}

describe("T20 — appending the role moves no existing vocabulary", () => {
  /**
   * Measured on origin/next @ f345990ce, before the append. The /2 catalog derives its roles from
   * `BUNDLE_EVIDENCE_ROLES`, a SEPARATE constant, so appending to the v4 list cannot reach it — and
   * this digest is what proves that rather than asserts it. (The design's §6.2 named a
   * `ROLE_ORDER.slice(0, 12)` in the producer as the hazard; the tree has since moved to the
   * separate constant, and this pin covers the current mechanism.)
   */
  const PRE_APPEND_V2_ROLES_SHA256 = "2a676e20916cde97c8726824beb6000ff3f464566cd8cbb1e301ae3377c9de6f";
  /** The admission-only subset, likewise untouched: a disclosure record is not admission evidence. */
  const PRE_APPEND_V4_ADMISSION_ROLES_SHA256 = "6ade5374f27ca3067152c1abed8cb468b40a54a05dc99f243279dbfb9137aec6";
  /** The v4 list before the append. The list itself necessarily changes; what must not change is its
   * PREFIX, which is the frozen ordering map every existing bundle's role arrays were written in. */
  const PRE_APPEND_V4_ROLES_SHA256 = "82fc4d363cc74637d2afe62ff6533fafab4e44ad8a551459ee3b3c610792daff";

  test("the /2 catalog vocabulary is byte-unchanged", () => {
    expect(digestOf(BUNDLE_EVIDENCE_ROLES)).toBe(PRE_APPEND_V2_ROLES_SHA256);
    expect(BUNDLE_EVIDENCE_ROLES).not.toContain(DISCLOSURE_SPECIFICATION_BUNDLE_ROLE);
  });

  test("the admission-only subset is byte-unchanged", () => {
    expect(digestOf(BUNDLE_V4_ADMISSION_EVIDENCE_ROLES)).toBe(PRE_APPEND_V4_ADMISSION_ROLES_SHA256);
  });

  test("the v4 vocabulary grows by exactly one token, at the very end, with its prefix unmoved", () => {
    expect(BUNDLE_V4_EVIDENCE_ROLES.at(-1)).toBe(DISCLOSURE_SPECIFICATION_BUNDLE_ROLE);
    const prefix = BUNDLE_V4_EVIDENCE_ROLES.slice(0, -1);
    expect(digestOf(prefix)).toBe(PRE_APPEND_V4_ROLES_SHA256);
    expect(prefix).toHaveLength(41);
  });
});

describe("the shared projection carries the record verbatim (§6.6)", () => {
  test("projects the digest, the standard, the subject, and all six entries unchanged", () => {
    const { bytes, sha256 } = sealed();
    const projected = deriveDisclosureSpecification(bytes);

    expect(projected.recordSha256).toBe(sha256);
    expect(projected.specification).toBe(SIX_VARIABLE_DISCLOSURE_SPECIFICATION);
    expect(projected.subjectSha256).toBe(MATRIX_SHA256);
    expect(projected.variables).toEqual((record() as { variables: unknown }).variables);
  });

  test("the key order is the frozen one, not whatever order the record's bytes happened to carry", () => {
    expect(Object.keys(deriveDisclosureSpecification(sealed().bytes).variables)).toEqual([
      "ingestion-model", "retrieval-config", "answer-model", "answer-prompt", "judge-model", "judge-prompt",
    ]);
  });

  test("nothing is counted, ranked, or summarized — the section has exactly four keys", () => {
    expect(Object.keys(deriveDisclosureSpecification(sealed().bytes)).sort())
      .toEqual(["recordSha256", "specification", "subjectSha256", "variables"]);
  });

  test("bytes that are not a valid sealed record raise the typed projection error", () => {
    expect(() => deriveDisclosureSpecification(new TextEncoder().encode("{}")))
      .toThrow(DisclosureProjectionError);
  });
});

describe("the check authenticates measurements and carries assertions (§7 steps 1-8)", () => {
  test("a well-formed record verifies and reports all six statuses", () => {
    expect(check().statuses).toEqual({
      "ingestion-model": "undisclosed",
      "retrieval-config": "undisclosed",
      "answer-model": "disclosed-by-publisher",
      "answer-prompt": "disclosed-by-publisher",
      "judge-model": "measured-here",
      "judge-prompt": "measured-here",
    });
  });

  test("T19 — an assertion whose statement is plainly false still VERIFIES", () => {
    // This test is the one a reviewer will want to delete. It must not be deleted: a verifier that
    // failed on a false assertion would be claiming a power it does not have (design R4).
    const report = check({
      variables: {
        ...(record() as { variables: Record<string, unknown> }).variables,
        "answer-model": {
          status: "disclosed-by-publisher",
          statement: "Every candidate answer was written by a model that does not exist.",
        },
      },
    });
    expect(report.statuses["answer-model"]).toBe("disclosed-by-publisher");
  });

  test("T6 — a measured-here variable citing a digest the bundle does not carry refuses", () => {
    expect(() => check({
      variables: {
        ...(record() as { variables: Record<string, unknown> }).variables,
        "judge-prompt": {
          status: "measured-here",
          statement: "Sealed grading instruments.",
          evidence: [{ role: "pinned-configuration", digest: { sha256: "f".repeat(64) } }],
        },
      },
    })).toThrow(/which this bundle does not carry/);
  });

  test("T7 — a citation whose record's bundle roles are outside the admissible set refuses", () => {
    const { bytes, sha256 } = sealed();
    expect(() => assertDisclosureSpecification({
      extensionDigestSha256: sha256,
      catalogRoles: new Map<string, ReadonlySet<string>>([
        [sha256, new Set([DISCLOSURE_SPECIFICATION_BUNDLE_ROLE])],
        // `human-review-verdict` is neither a pinned configuration nor an execution observation.
        [INSTRUMENT_SHA256, new Set(["human-review-verdict"])],
        [VERDICT_SHA256, new Set(["verdict"])],
      ]),
      recordBytes: new Map([[sha256, bytes]]),
      matrixSha256: MATRIX_SHA256,
      reportAuthor: AUTHOR,
      refuse,
    })).toThrow(/outside the admissible set/);
  });

  test("T8 — a measurement citing only execution observations never reaches the check", () => {
    // Structural: `sealDisclosureSpecification` refuses it, so no such record exists to check.
    expect(() => sealed({
      variables: {
        ...(record() as { variables: Record<string, unknown> }).variables,
        "judge-model": {
          status: "measured-here",
          statement: "A measurement of something nobody wrote down.",
          evidence: [{ role: "execution-observation", digest: { sha256: VERDICT_SHA256 } }],
        },
      },
    })).toThrow();
  });

  test("T9 — an author differing from the Report author refuses", () => {
    expect(() => check({}, { reportAuthor: "did:key:zSomeOtherIdentity" }))
      .toThrow(/not the bundle's verified Report author/);
  });

  test("T10 — a subject digest that is not this bundle's Matrix refuses", () => {
    expect(() => check({}, { matrixSha256: "9".repeat(64) }))
      .toThrow(/not this bundle's Matrix digest/);
  });

  test("a subject kind that is not the Matrix record kind refuses", () => {
    expect(() => check({
      subject: { kind: "https://spec.jinn.network/records/benchmark-report/v1", digest: { sha256: MATRIX_SHA256 } },
    })).toThrow(/subject kind must be/);
  });

  test("T21 — a record declaring the disclosure role plus a second role refuses", () => {
    const { bytes, sha256 } = sealed();
    expect(() => assertDisclosureSpecification({
      extensionDigestSha256: sha256,
      catalogRoles: new Map<string, ReadonlySet<string>>([
        [sha256, new Set([DISCLOSURE_SPECIFICATION_BUNDLE_ROLE, "judge-instrument"])],
        [INSTRUMENT_SHA256, new Set(["judge-instrument"])],
        [VERDICT_SHA256, new Set(["verdict"])],
      ]),
      recordBytes: new Map([[sha256, bytes]]),
      matrixSha256: MATRIX_SHA256,
      reportAuthor: AUTHOR,
      refuse,
    })).toThrow(/exactly that one role and no second/);
  });

  test("T23 — two catalog records bearing the role refuse on cardinality", () => {
    const { bytes, sha256 } = sealed();
    expect(() => assertDisclosureSpecification({
      extensionDigestSha256: sha256,
      catalogRoles: new Map<string, ReadonlySet<string>>([
        [sha256, new Set([DISCLOSURE_SPECIFICATION_BUNDLE_ROLE])],
        ["d".repeat(64), new Set([DISCLOSURE_SPECIFICATION_BUNDLE_ROLE])],
      ]),
      recordBytes: new Map([[sha256, bytes]]),
      matrixSha256: MATRIX_SHA256,
      reportAuthor: AUTHOR,
      refuse,
    })).toThrow(/more than one disclosure-specification record/);
  });

  test("T24 — a bearer the Report extension does not name refuses", () => {
    const { bytes, sha256 } = sealed();
    expect(() => assertDisclosureSpecification({
      extensionDigestSha256: sha256,
      catalogRoles: new Map<string, ReadonlySet<string>>([
        ["d".repeat(64), new Set([DISCLOSURE_SPECIFICATION_BUNDLE_ROLE])],
      ]),
      recordBytes: new Map([[sha256, bytes]]),
      matrixSha256: MATRIX_SHA256,
      reportAuthor: AUTHOR,
      refuse,
    })).toThrow(/is not the one the Report extension names/);
  });

  test("an extension naming a digest no catalog record bears refuses", () => {
    const { bytes, sha256 } = sealed();
    expect(() => assertDisclosureSpecification({
      extensionDigestSha256: sha256,
      catalogRoles: new Map<string, ReadonlySet<string>>([[INSTRUMENT_SHA256, new Set(["judge-instrument"])]]),
      recordBytes: new Map([[sha256, bytes]]),
      matrixSha256: MATRIX_SHA256,
      reportAuthor: AUTHOR,
      refuse,
    })).toThrow(/no evidence-catalog record carries/);
  });

  test("a catalog entry whose bytes the bundle does not carry refuses", () => {
    const { sha256 } = sealed();
    expect(() => assertDisclosureSpecification({
      extensionDigestSha256: sha256,
      catalogRoles: new Map<string, ReadonlySet<string>>([[sha256, new Set([DISCLOSURE_SPECIFICATION_BUNDLE_ROLE])]]),
      recordBytes: new Map(),
      matrixSha256: MATRIX_SHA256,
      reportAuthor: AUTHOR,
      refuse,
    })).toThrow(/does not carry the disclosure-specification record it names/);
  });

  test("bytes filed under the extension digest that are not a valid record refuse by path", () => {
    const { sha256 } = sealed();
    try {
      assertDisclosureSpecification({
        extensionDigestSha256: sha256,
        catalogRoles: new Map<string, ReadonlySet<string>>([[sha256, new Set([DISCLOSURE_SPECIFICATION_BUNDLE_ROLE])]]),
        recordBytes: new Map([[sha256, new TextEncoder().encode("{}")]]),
        matrixSha256: MATRIX_SHA256,
        reportAuthor: AUTHOR,
        refuse,
      });
      throw new Error("expected a refusal");
    } catch (cause) {
      expect((cause as BenchmarkProductError).issues[0]?.path).toBe(`records/${sha256}.bin`);
    }
  });
});

describe("§6.4's binding profile is a closed, Jinn-side mapping", () => {
  test("every admissible bundle role is a real v4 evidence role", () => {
    for (const roles of Object.values(DISCLOSURE_ROLE_BINDING)) {
      for (const role of roles) expect(BUNDLE_V4_EVIDENCE_ROLES).toContain(role);
    }
  });

  test("the two disclosure roles admit disjoint bundle-role sets", () => {
    const pinned = new Set<string>(DISCLOSURE_ROLE_BINDING["pinned-configuration"]);
    for (const role of DISCLOSURE_ROLE_BINDING["execution-observation"]) {
      expect(pinned.has(role)).toBe(false);
    }
  });

  test("the disclosure role is never itself admissible as a citation target", () => {
    for (const roles of Object.values(DISCLOSURE_ROLE_BINDING)) {
      expect(roles).not.toContain(DISCLOSURE_SPECIFICATION_BUNDLE_ROLE);
    }
  });
});
