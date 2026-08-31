/**
 * The disclosure-specification record (design `2026-08-19-disclosure-specification-record.md`
 * §3–§5, issue #2839).
 *
 * Everything else the product discloses describes *what it executed*. This record's central
 * capability is **carrying an assertion honestly**: it keeps a declared-but-not-run variable
 * permanently distinguishable from a measured one, at the schema level, so that no rendering,
 * projection, summary, or later reader can confuse them.
 *
 * The seven rules of §3 are enforced structurally rather than by convention — violating one is a
 * parse failure, not a review finding:
 *
 * - **R1 — one record, one subject.** `subject` is a single object, never a list, so composite,
 *   truncated, or derived subjects have nowhere to live.
 * - **R2 — all six variables, always.** Silence is a status you write down, not one you get for
 *   free. There is no default and no inferred value; an absent key refuses.
 * - **R3 — evidence is representable on exactly one status.** `VariableEntry` is a strict
 *   discriminated union: `disclosed-by-publisher` and `undisclosed` have no `evidence` field, so
 *   an assertion has nowhere to put a digest. This is the single most load-bearing rule here.
 * - **R5 — nothing derivable is stored.** No pinning statuses, no counts, no verdicts, no rates.
 * - **R6 — sealed once; the bytes are the record forever.** Canonical JCS encoding, identity is the
 *   SHA-256 of those exact bytes, strict schemas, unknown keys fail closed.
 * - **R7 — no third-party bytes.** Every `statement` is the record author's own original prose.
 *   The schema cannot enforce that; it is stated here because this file is where a reviewer looks.
 *
 * R4 (the verifier authenticates measurements and carries assertions) is a property of the
 * `disclosure-specification` check, not of this schema — see `@colophon-claims/verify`.
 */

import { z } from "zod";
import { AgentIriSchema, LowercaseSha256HexSchema } from "../descriptors.js";
import {
  DISCLOSURE_SPECIFICATION_RECORD_KIND,
  SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
} from "../identifiers.js";
import { parseExactWithSchema, sealWithSchema, type SealedRecord } from "../sealing.js";

/**
 * The six variables, frozen exactly as the design authority's §2 states them. The set is CLOSED: a
 * seventh variable is a conformance failure, not a tolerated extra (§2.1, operator ruling Q1).
 * Declared in this order so the projection and every renderer read one order.
 */
export const DISCLOSURE_VARIABLE_KEYS = [
  "ingestion-model",
  "retrieval-config",
  "answer-model",
  "answer-prompt",
  "judge-model",
  "judge-prompt",
] as const;
export type DisclosureVariableKey = (typeof DISCLOSURE_VARIABLE_KEYS)[number];

/**
 * Two tokens, closed, and owned by the standard rather than by any bundle format (§4.4). A finer
 * vocabulary would encode Jinn's own record taxonomy into a portable standard and would need
 * revision every time that taxonomy grew. The mapping onto a specific carrier's record roles is the
 * carrier's business (Jinn's is the verifier's §6.4 table).
 */
export const DISCLOSURE_EVIDENCE_ROLES = ["pinned-configuration", "execution-observation"] as const;
export type DisclosureEvidenceRole = (typeof DISCLOSURE_EVIDENCE_ROLES)[number];

/**
 * §4.3's three reason tokens. `outside-this-experiment` means STRUCTURALLY INAPPLICABLE, not merely
 * unknown: an experiment with no retrieval step at all has no retrieval config to disclose. It is
 * not the token for "someone else fixed this and we do not know what they chose" — that is
 * `not-stated`. Scope and knowledge are different distinctions and the tokens are not
 * interchangeable.
 */
export const DISCLOSURE_UNDISCLOSED_REASONS = [
  "not-stated",
  "stated-without-identifiers",
  "outside-this-experiment",
] as const;
export type DisclosureUndisclosedReason = (typeof DISCLOSURE_UNDISCLOSED_REASONS)[number];

const AbsoluteIriSchema = z.string().refine(
  (value) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value),
  { message: "must be an absolute IRI" },
);

/**
 * The DigestSet shape `{ "sha256": "<hex>" }`, strict. `sha256` is the only admitted algorithm; the
 * strict object is what makes a second algorithm a conformance failure rather than an ignored
 * extra (§4.2).
 */
const DisclosureDigestSchema = z.strictObject({ sha256: LowercaseSha256HexSchema });

/** The author's own words about one configuration. Bounded so a record cannot become a document. */
const StatementSchema = z.string().min(1).max(1024);

const EvidenceCitationSchema = z.strictObject({
  role: z.enum(DISCLOSURE_EVIDENCE_ROLES),
  digest: DisclosureDigestSchema,
});

const SourceSchema = z.strictObject({ uri: AbsoluteIriSchema });

/** UTF-16 code-unit order over `role` + U+001F + `digest`, the discipline `publication-extension.ts` applies
 * to `registrationArtifacts`. The record seals to exact bytes, so two spellings of one citation list
 * would be two records claiming one thing. */
function evidenceKey(entry: z.infer<typeof EvidenceCitationSchema>): string {
  return `${entry.role}\u001f${entry.digest.sha256}`;
}

const MeasuredHereEntrySchema = z.strictObject({
  status: z.literal("measured-here"),
  statement: StatementSchema,
  evidence: z.array(EvidenceCitationSchema).min(1),
}).superRefine((entry, ctx) => {
  if (!entry.evidence.some((citation) => citation.role === "pinned-configuration")) {
    ctx.addIssue({
      code: "custom",
      path: ["evidence"],
      message: "a measured-here variable must cite at least one pinned-configuration; a measurement"
        + " with only observations is a measurement of something nobody wrote down",
    });
  }
  for (let index = 1; index < entry.evidence.length; index += 1) {
    if (evidenceKey(entry.evidence[index - 1]!) >= evidenceKey(entry.evidence[index]!)) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence", index],
        message: "evidence must be sorted and unique by (role, digest.sha256) in UTF-16 code-unit order",
      });
    }
  }
});

const DisclosedByPublisherEntrySchema = z.strictObject({
  status: z.literal("disclosed-by-publisher"),
  statement: StatementSchema,
  /**
   * Optional rather than required because requiring it would be circular for the flagship case: the
   * report that states these variables is the artifact this record is published inside, so at seal
   * time there is no URI to cite. Inventing a placeholder to satisfy a required field would be
   * worse than an honest empty (§4.3). Absent means the assertion is the record author's own, with
   * no external citation, and the projection says exactly that.
   *
   * There is deliberately NO `retrievedAt` (operator ruling Q3): unverifiable metadata dressing an
   * assertion as evidence weakens the measured-versus-asserted line.
   */
  sources: z.array(SourceSchema).min(1).optional(),
}).superRefine((entry, ctx) => {
  const sources = entry.sources;
  if (sources === undefined) return;
  for (let index = 1; index < sources.length; index += 1) {
    if (sources[index - 1]!.uri >= sources[index]!.uri) {
      ctx.addIssue({
        code: "custom",
        path: ["sources", index],
        message: "sources must be sorted and unique by uri (UTF-16 code-unit order)",
      });
    }
  }
});

/**
 * No `statement`, no `evidence`, no `sources` — a reason token and nothing else.
 *
 * Dropping `statement` from this branch costs the `stated-without-identifiers` case its ability to
 * say *what* was vaguely stated. That is deliberate (§4.3's acknowledged tradeoff): a free-text
 * field on the branch that promises no assertion is the most likely place for an assertion to
 * reappear, and R3's guarantee is worth more than the lost nuance. A publisher who wants to record
 * the vague statement uses `disclosed-by-publisher` and says in `statement` that it is unpinnable.
 */
const UndisclosedEntrySchema = z.strictObject({
  status: z.literal("undisclosed"),
  reason: z.enum(DISCLOSURE_UNDISCLOSED_REASONS),
});

export const DisclosureVariableEntrySchema = z.discriminatedUnion("status", [
  MeasuredHereEntrySchema,
  DisclosedByPublisherEntrySchema,
  UndisclosedEntrySchema,
]);
export type DisclosureVariableEntry = z.infer<typeof DisclosureVariableEntrySchema>;
export type DisclosureVariableStatus = DisclosureVariableEntry["status"];

/** All six required, no more and no fewer (R2). A strict object is what makes both halves true. */
export const DisclosureVariablesSchema = z.strictObject(
  Object.fromEntries(
    DISCLOSURE_VARIABLE_KEYS.map((key) => [key, DisclosureVariableEntrySchema]),
  ) as { readonly [K in DisclosureVariableKey]: typeof DisclosureVariableEntrySchema },
);

export const DisclosureSpecificationSchema = z.strictObject({
  kind: z.literal(DISCLOSURE_SPECIFICATION_RECORD_KIND),
  specification: z.literal(SIX_VARIABLE_DISCLOSURE_SPECIFICATION),
  /** Present so the record is attributable when it travels alone; the carrier binds it to
   * `report.author` when it travels in a bundle (design §7 step 4). */
  author: AgentIriSchema,
  subject: z.strictObject({
    kind: AbsoluteIriSchema,
    digest: DisclosureDigestSchema,
  }),
  variables: DisclosureVariablesSchema,
});
export type DisclosureSpecification = z.infer<typeof DisclosureSpecificationSchema>;

/** Parse and validate raw sealed bytes; throws `InvalidDocumentError`. Requires the input to be the
 * one exact canonical encoding, so a re-spelled record is not a second record for one claim. */
export function parseDisclosureSpecification(bytes: Uint8Array): DisclosureSpecification {
  return parseExactWithSchema(DisclosureSpecificationSchema, bytes);
}

/** Validate → I-JSON enforce → JCS → exact bytes. Those bytes are the record forever (R6). */
export function sealDisclosureSpecification(document: unknown): SealedRecord {
  return sealWithSchema(DisclosureSpecificationSchema, document);
}
