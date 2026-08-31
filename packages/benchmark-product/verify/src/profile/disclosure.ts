/**
 * The disclosed closure's projection and check (disclosure-specification-record design §6.4, §6.6,
 * §7; issue #2839).
 *
 * This module is **single-sourced, not mirrored**, exactly as `anchor-claims.ts` is: `@colophon-
 * claims/core` already depends on this package, so the producer and the standalone verifier call
 * ONE `deriveDisclosureSpecification`. The claim-consistency byte-compare then compares one
 * function's output over two byte sets rather than two implementations' guesses.
 *
 * The one posture that matters more than any mechanism here (design R4):
 *
 *   **The verifier AUTHENTICATES measurements and CARRIES assertions.**
 *
 * A `measured-here` variable must cite records the bundle actually carries, under a role admissible
 * for the citation. A `disclosed-by-publisher` variable is checked for internal well-formedness and
 * for nothing else — no lookup, no fetch, no cross-check against the Matrix or the Report, no status
 * upgrade or downgrade. An assertion that turns out to be false is a false assertion in a valid
 * record; that is the correct outcome and the honest one, and a verifier that refused it would be
 * claiming a power it does not have.
 *
 * What this check deliberately does NOT do (design §8, each one a thing a well-meaning implementer
 * would add):
 *
 * - It does not reconcile against `Report.disclosures.perSubject[].pinning`. Those counts answer
 *   "how well did each executed axis pin"; this record answers "which variables were executed at
 *   all". Two surfaces restating one fact are two surfaces that can disagree.
 * - It does not infer a status from the bundle. A bundle that plainly executed a judge model does
 *   not license marking `judge-model` as `measured-here` if the record says otherwise.
 * - It does not fetch anything, ever. A verifier that reached the network would make its own result
 *   depend on when it ran.
 * - It does not rank, score, compare, or aggregate. There is no disclosure-completeness score:
 *   counting statuses would create a number publishers optimize against, and a six-of-six record
 *   with six vague assertions would outscore a two-of-six record with two proofs.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DISCLOSURE_VARIABLE_KEYS,
  DisclosureVariablesSchema,
  MATRIX_RECORD_KIND,
  SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
  parseDisclosureSpecification,
  type DisclosureEvidenceRole,
  type DisclosureSpecification,
  type DisclosureVariableEntry,
  type DisclosureVariableKey,
  type DisclosureVariableStatus,
} from "@jinn-network/benchmarking-records";
import type { BundleV4EvidenceRole } from "../schema.js";

/** The evidence-catalog role a disclosure-specification record carries, and the ONLY one it may
 * carry: a record bearing this token together with any second role refuses (§7 step 1). */
export const DISCLOSURE_SPECIFICATION_BUNDLE_ROLE = "disclosure-specification" as const;

/**
 * §6.4's binding profile: which of this carrier's evidence roles satisfy which of the standard's two
 * portable disclosure roles. Jinn-side mapping, deliberately NOT part of the portable record — the
 * mapping from the standard's roles onto a specific carrier's record roles is the carrier's business.
 *
 * v1 deliberately does not narrow the admissible set per variable. Which record species fixes
 * `judge-model` depends on the judge profile packet P0 is freezing, and encoding a guess here would
 * put this module in P0's lane. Reserved as a v2 tightening once P0's record vocabulary merges.
 */
export const DISCLOSURE_ROLE_BINDING: Readonly<Record<DisclosureEvidenceRole, readonly BundleV4EvidenceRole[]>> = {
  "pinned-configuration": [
    "task",
    "item-bank",
    "source-item",
    "evaluation-spec",
    "judge-instrument",
    "runtime-selection",
    "admission-manifest",
  ],
  "execution-observation": [
    "run-pinning-evidence",
    "solve-submission",
    "solve-delivery",
    "solve-output",
    "evaluation-submission",
    "evaluation-delivery",
    "verdict",
  ],
};

/** The claim package's `disclosure` section (§6.6). Every variable entry is its record entry
 * VERBATIM: nothing is summarized, counted, ranked, or reworded (R5). */
export interface ClaimDisclosureSection {
  readonly recordSha256: string;
  /** The literal standard identifier, not any string: this section names the standard the record
   * claims compliance with, and a section naming a different one is not this record's projection. */
  readonly specification: typeof SIX_VARIABLE_DISCLOSURE_SPECIFICATION;
  readonly subjectSha256: string;
  readonly variables: Readonly<Record<DisclosureVariableKey, DisclosureVariableEntry>>;
}

/**
 * The claim section's own grammar, single-sourced from the record's schema so the section cannot
 * describe a variable entry the record could not have carried. It is a second line of defense
 * rather than the primary one: `assertClaimConsistency`'s whole-claim byte-compare against the
 * rebuilt claim is what actually proves the section is this record's projection.
 */
export const ClaimDisclosureSectionSchema = z.strictObject({
  recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  specification: z.literal(SIX_VARIABLE_DISCLOSURE_SPECIFICATION),
  subjectSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  variables: DisclosureVariablesSchema,
});

export class DisclosureProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisclosureProjectionError";
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The one shared projection, called by BOTH the workspace producer and the standalone verifier.
 *
 * It carries only facts embedded in the record's own bytes, plus the record's digest — which is the
 * digest of the very bytes handed in, never a separately supplied one. It exists at all so a reader
 * of `claim-package.json` alone sees all six statuses without opening an evidence record, and so
 * `assertClaimConsistency`'s existing whole-claim byte-compare covers the disclosure without a
 * second bespoke comparison.
 */
export function deriveDisclosureSpecification(recordBytes: Uint8Array): ClaimDisclosureSection {
  let record: DisclosureSpecification;
  try {
    record = parseDisclosureSpecification(recordBytes);
  } catch (cause) {
    throw new DisclosureProjectionError(
      `disclosure-specification record is not a valid sealed record: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return {
    recordSha256: sha256Hex(recordBytes),
    specification: record.specification,
    subjectSha256: record.subject.digest.sha256,
    // Verbatim, in the frozen key order. Building the object key by key rather than spreading
    // `record.variables` is what makes the order a property of this function rather than of
    // whatever order the record's own bytes happened to carry.
    variables: Object.fromEntries(
      DISCLOSURE_VARIABLE_KEYS.map((key) => [key, record.variables[key]]),
    ) as Readonly<Record<DisclosureVariableKey, DisclosureVariableEntry>>,
  };
}

/** The disclosed statuses, surfaced on the verification result (§7 step 11). Disclosed facts, never
 * folded into a single badge — the same posture `anchors` takes. */
export interface DisclosureSpecificationReport {
  readonly recordSha256: string;
  readonly specification: string;
  readonly subjectSha256: string;
  readonly statuses: Readonly<Record<DisclosureVariableKey, DisclosureVariableStatus>>;
}

export interface AssertDisclosureSpecificationInput {
  /** The Report extension's descriptor digest — what the carrier says the record is. */
  readonly extensionDigestSha256: string;
  /** Every evidence-catalog record's declared roles, keyed by record digest. */
  readonly catalogRoles: ReadonlyMap<string, ReadonlySet<string>>;
  /** The exact carried bytes for every evidence record, keyed by digest. */
  readonly recordBytes: ReadonlyMap<string, Uint8Array>;
  /** The bundle's own Matrix digest — the record's one legal subject (R1). */
  readonly matrixSha256: string;
  /** The verified Report's author IRI. */
  readonly reportAuthor: string;
  /** Refuses with the verifier's own typed refusal, so this module raises no error class of its own
   * at the call boundary and every path lands in the caller's issue shape. */
  readonly refuse: (path: string, message: string) => never;
}

/**
 * §7 steps 1–8: authenticate what the Report extension names.
 *
 * Step 9 (claim-id pairing) and step 10 (projection equality) live in `verify.ts` and
 * `assertClaimConsistency` respectively, because both compare against documents this function is
 * deliberately not handed — keeping this function a statement about the RECORD and its evidence.
 */
export function assertDisclosureSpecification(
  input: AssertDisclosureSpecificationInput,
): DisclosureSpecificationReport {
  // Explicitly annotated so TypeScript's control-flow analysis treats every call below as
  // terminating; a destructured member with an inferred type does not narrow through `never`.
  const refuse: (path: string, message: string) => never = input.refuse;

  // ── Step 1: carrier binding, in exact one-to-one correspondence ─────────────────────────────
  //
  // The extension's digest must resolve to EXACTLY ONE catalog record — none and two both refuse —
  // and that record's declared roles must be exactly the one disclosure role. Conversely any catalog
  // record bearing the role that the extension does not name refuses: without the second direction,
  // a second disclosure record could ride along with nothing checking it.
  const bearers = [...input.catalogRoles]
    .filter(([, roles]) => roles.has(DISCLOSURE_SPECIFICATION_BUNDLE_ROLE))
    .map(([digest]) => digest);
  if (bearers.length !== 1 || bearers[0] !== input.extensionDigestSha256) {
    refuse(
      "disclosure-specification",
      bearers.length === 0
        ? "the Report names a disclosure-specification record that no evidence-catalog record carries"
        : bearers.length > 1
          ? "the evidence catalog carries more than one disclosure-specification record; the Report names exactly one"
          : "the evidence catalog's disclosure-specification record is not the one the Report extension names",
    );
  }
  const declared = input.catalogRoles.get(input.extensionDigestSha256);
  if (declared === undefined || declared.size !== 1) {
    refuse(
      "disclosure-specification",
      "the disclosure-specification record must declare exactly that one role and no second",
    );
  }

  // ── Step 2: exact bytes ────────────────────────────────────────────────────────────────────
  //
  // The digest equality with the catalog entry is already established upstream (the bundle walk
  // recomputes every `records/<sha256>.bin`), so what is proved here is that those bytes parse
  // strictly AND are the one exact canonical encoding of what they parse to.
  const bytes = input.recordBytes.get(input.extensionDigestSha256);
  if (bytes === undefined) {
    refuse("disclosure-specification", "the bundle does not carry the disclosure-specification record it names");
  }
  const record: DisclosureSpecification = (() => {
    try {
      return parseDisclosureSpecification(bytes);
    } catch (cause) {
      refuse(
        `records/${input.extensionDigestSha256}.bin`,
        `disclosure-specification record is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  })();

  // ── Step 3: subject binding (R1) ───────────────────────────────────────────────────────────
  //
  // The Matrix rather than the Report, because the Report cannot name its own digest inside its own
  // signed payload, and because the record must be sealable before the Report is (§5).
  if (record.subject.kind !== MATRIX_RECORD_KIND) {
    refuse("disclosure-specification", `the record's subject kind must be ${MATRIX_RECORD_KIND}`);
  }
  if (record.subject.digest.sha256 !== input.matrixSha256) {
    refuse("disclosure-specification", "the record's subject digest is not this bundle's Matrix digest");
  }
  if (record.specification !== SIX_VARIABLE_DISCLOSURE_SPECIFICATION) {
    refuse("disclosure-specification", `the record must claim ${SIX_VARIABLE_DISCLOSURE_SPECIFICATION}`);
  }

  // ── Step 4: author binding ─────────────────────────────────────────────────────────────────
  //
  // A disclosure record asserting under one identity inside a bundle signed by another is a carrier
  // mismatch, not an extra fact.
  if (record.author !== input.reportAuthor) {
    refuse("disclosure-specification", "the record's author is not the bundle's verified Report author");
  }

  // ── Step 5: vocabulary completeness (R2) ───────────────────────────────────────────────────
  //
  // Structural via the strict object; restated so the refusal names the KEY rather than a schema
  // path a reader would have to decode.
  for (const key of DISCLOSURE_VARIABLE_KEYS) {
    if (record.variables[key] === undefined) {
      refuse("disclosure-specification", `the record does not state the variable "${key}"`);
    }
  }
  for (const key of Object.keys(record.variables)) {
    if (!(DISCLOSURE_VARIABLE_KEYS as readonly string[]).includes(key)) {
      refuse("disclosure-specification", `the record states an unknown variable "${key}"; the six-variable set is closed`);
    }
  }

  // ── Steps 6–8: authenticate measurements, carry assertions, and let undisclosed carry nothing ─
  const statuses: Record<string, DisclosureVariableStatus> = {};
  for (const key of DISCLOSURE_VARIABLE_KEYS) {
    const entry = record.variables[key];
    statuses[key] = entry.status;
    if (entry.status === "measured-here") {
      // Step 6. THE WHOLE SUBSTANCE of "variables the venue actually ran must match actual pinning
      // evidence in the bundle": no measured-here variable may cite a record the bundle does not
      // carry, and a citation resolving to bytes of the wrong species is as bad as a dangling one.
      for (const citation of entry.evidence) {
        const cited = input.catalogRoles.get(citation.digest.sha256);
        if (cited === undefined) {
          refuse(
            "disclosure-specification",
            `"${key}" is measured here but cites ${citation.digest.sha256}, which this bundle does not carry`,
          );
        }
        const citedRoles: ReadonlySet<string> = cited;
        const admissible = DISCLOSURE_ROLE_BINDING[citation.role];
        if (!admissible.some((role) => citedRoles.has(role))) {
          refuse(
            "disclosure-specification",
            `"${key}" cites ${citation.digest.sha256} as ${citation.role}, but that record's bundle roles are`
            + ` outside the admissible set for it`,
          );
        }
      }
      continue;
    }
    if (entry.status === "disclosed-by-publisher") {
      // Step 7. Internal consistency ONLY. The schema has already established the statement bound
      // and the sorted, unique, absolute-IRI source list; there is nothing further to check here and
      // — R4 — nothing further this verifier is entitled to check. Restated as a branch so a later
      // reader sees the deliberate emptiness rather than an omission.
      continue;
    }
    // Step 8. Structural via the union; restated so the refusal would name the variable. Reaching
    // this branch at all means the entry is `undisclosed`, which by construction carries a reason
    // token and nothing else.
  }

  return {
    recordSha256: input.extensionDigestSha256,
    specification: record.specification,
    subjectSha256: record.subject.digest.sha256,
    statuses: statuses as Readonly<Record<DisclosureVariableKey, DisclosureVariableStatus>>,
  };
}
