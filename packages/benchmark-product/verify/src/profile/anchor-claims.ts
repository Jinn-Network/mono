/**
 * The anchored-closure projection (anchor-evidence design §7.4 and §9.2): the pure function that
 * turns a bundle's carried AnchorEvidence bytes into the claim package's `anchors` section, and
 * the conditional honesty copy that section gates.
 *
 * This module is **single-sourced, not mirrored**. `@colophon-claims/core` already depends on this
 * package (it takes `nodeCryptoAnchorPorts` and the reader instructions from here), so producer and
 * verifier import the same function rather than two copies of it. §7.4 requires that "producer and
 * verifier derive the section from the same bundle bytes by the same pure function, so
 * claim-consistency remains an exact byte-compare" — one function is the strongest available form
 * of that requirement, since two mirrored copies can drift and this one cannot.
 *
 * Four disciplines are load-bearing:
 *
 * - **Records are read only through `parseExactAnchorEvidence`, proof content only through
 *   `decodeAnchorProofContent`.** Conformance is shape-level and admits alternate JSON spellings;
 *   identity is byte-exactness. A record selected through the laxer door would have a digest other
 *   than the one it is filed under.
 * - **Subject selectors are digest-keyed.** The lock anchor is any carried anchor whose
 *   `subject.digest` equals the digest of the bundle's exact `run.json` bytes; the matrix anchor is
 *   any whose digest equals `matrix.json`'s. `subject.kind` is then required to equal the resolved
 *   record's actual kind — it is checked, never used to route (§8 step 2). A digest that names no
 *   bundle record, or a kind that misdescribes the one it names, is `invalid`: affirmative evidence
 *   of substitution, reported louder than absence.
 * - **Byte-embedded facts only.** `genTime`, `policyOid`, `serialNumber`,
 *   `signerCertificateSha256` for RFC 3161; the attested block height (or `pending`) for
 *   OpenTimestamps. Facts that need external data (block time) or lack a canonical rendering
 *   (issuer distinguished names, accuracy intervals) never enter this section — they are
 *   verifier-report and presentation content (§7.4).
 * - **No trust material is supplied here.** This projection is a function of the bundle's bytes,
 *   never of a verifier's configured roots, because the sealed claim text must be identical for
 *   every reader (§8, "The honesty text keys on byte-facts"). Trust evaluation lives in the
 *   `integrity-anchors` check's own report.
 */

import { z } from "zod";
import {
  MATRIX_RECORD_KIND,
  RUN_RECORD_KIND,
  compareCalendarStrictRfc3339Instants,
} from "@jinn-network/benchmarking-records";
import {
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
  createOpenTimestampsProofVerifier,
  createRfc3161AnchorProofVerifier,
  decodeAnchorProofContent,
  parseExactAnchorEvidence,
} from "@jinn-network/trust-core";
import type { AnchorProofResult } from "@jinn-network/trust-core";
import { nodeCryptoAnchorPorts } from "../anchor/ports.js";

/** The two records this product anchors (§7.1). Both are whole sealed-record digests. */
export type ClaimAnchorSubject = "lock" | "matrix";

/** RFC 3161's four byte-embedded facts (§7.4). `accuracy` and the issuer DN are deliberately
 * absent: the first has no canonical single rendering, the second is not canonically comparable
 * across implementations. */
export interface Rfc3161ClaimAnchorFacts {
  readonly genTime: string;
  readonly policyOid: string;
  readonly serialNumber: string;
  readonly signerCertificateSha256: string;
}

/** OpenTimestamps' one byte-embedded fact, or the calendar-only state. A `pending` proof carries no
 * height because none has been attested yet — the two shapes are disjoint by construction so no
 * reader can mistake a promise for a commitment (§13 item 5). */
export type OpenTimestampsClaimAnchorFacts =
  | { readonly blockHeight: number }
  | { readonly pending: true };

export type ClaimAnchorFacts = Rfc3161ClaimAnchorFacts | OpenTimestampsClaimAnchorFacts;

export interface ClaimAnchor {
  readonly subject: ClaimAnchorSubject;
  /** The resolved record's actual kind IRI — checked against `subject.kind`, never taken from it. */
  readonly kind: string;
  readonly provider: string;
  readonly recordSha256: string;
  /** Present only on the §6.2 upgraded form of a pending proof — see `upgradeEdge` below. */
  readonly upgradesRecordSha256?: string;
  readonly facts: ClaimAnchorFacts;
}

export interface CarriedAnchorRecord {
  readonly recordSha256: string;
  readonly bytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// The wire schema. Defined once here and imported by both claim-package modules,
// for the same drift reason the derivation is single-sourced.
// ---------------------------------------------------------------------------

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest");

/** RFC 3161's four byte-embedded facts, strictly — an extra key here would be a fact this section
 * is not allowed to carry. */
const Rfc3161ClaimAnchorFactsSchema = z.strictObject({
  genTime: z.string().min(1),
  policyOid: z.string().min(1),
  serialNumber: z.string().regex(/^[a-f0-9]+$/, "must be lowercase hex of the DER INTEGER content octets"),
  signerCertificateSha256: Sha256HexSchema,
});

/** OpenTimestamps' two disjoint shapes: an attested height, or the calendar-only promise. */
const OpenTimestampsClaimAnchorFactsSchema = z.union([
  z.strictObject({ blockHeight: z.number().int().nonnegative() }),
  z.strictObject({ pending: z.literal(true) }),
]);

export const ClaimAnchorSchema = z.object({
  subject: z.enum(["lock", "matrix"]),
  kind: z.string().min(1),
  provider: z.string().min(1),
  recordSha256: Sha256HexSchema,
  upgradesRecordSha256: Sha256HexSchema.optional(),
  facts: z.union([Rfc3161ClaimAnchorFactsSchema, OpenTimestampsClaimAnchorFactsSchema]),
});

export interface DeriveClaimAnchorsInput {
  readonly records: readonly CarriedAnchorRecord[];
  /** sha256 hex of the bundle's exact `run.json` bytes. */
  readonly runSha256: string;
  /** sha256 hex of the bundle's exact `matrix.json` bytes. */
  readonly matrixSha256: string;
}

/** A record this projection refuses. Every caller converts it into its own typed refusal
 * (`record-integrity` on the producer side, an `invalid` anchor outcome on the verifier side), so
 * the failure is never swallowed and never crosses a package boundary as an untyped throw. */
export class ClaimAnchorProjectionError extends Error {
  override readonly name = "ClaimAnchorProjectionError";
  readonly recordSha256: string;

  constructor(recordSha256: string, message: string) {
    super(message);
    this.recordSha256 = recordSha256;
  }
}

function compareCodeUnits(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRfc3161Facts(facts: ClaimAnchorFacts): facts is Rfc3161ClaimAnchorFacts {
  return "genTime" in facts;
}

function isPending(facts: ClaimAnchorFacts): boolean {
  return "pending" in facts;
}

/**
 * The proof outcome, computed with **no trust material** — the only outcome shape this projection
 * may key on. A verifier's configured roots change `present` into `verified`; they must never
 * change one byte of the sealed claim (§8).
 */
function verifyCarriedProof(
  provider: string,
  subjectSha256: string,
  proofBytes: Uint8Array,
): AnchorProofResult {
  return provider === RFC3161_TSA_ANCHOR_PROFILE
    ? createRfc3161AnchorProofVerifier(nodeCryptoAnchorPorts).verifyProof({ subjectSha256, proofBytes })
    : createOpenTimestampsProofVerifier().verifyProof({ subjectSha256, proofBytes });
}

function factsFor(
  recordSha256: string,
  provider: string,
  result: AnchorProofResult,
): ClaimAnchorFacts {
  if (result.status === "invalid") {
    throw new ClaimAnchorProjectionError(recordSha256, `the carried proof does not verify: ${result.reason}`);
  }
  if (provider === RFC3161_TSA_ANCHOR_PROFILE) {
    if (result.status === "pending") {
      // Structurally unreachable: an RFC 3161 token is complete when it is issued. Refusing rather
      // than inventing a `pending` RFC 3161 fact shape keeps the two profiles' fact grammars
      // disjoint by construction.
      throw new ClaimAnchorProjectionError(recordSha256, "an RFC 3161 token has no pending form");
    }
    const facts = result.facts as {
      readonly genTime: string;
      readonly policyOid: string;
      readonly serialNumber: string;
      readonly signerCertificateSha256: string;
    };
    return {
      genTime: facts.genTime,
      policyOid: facts.policyOid,
      serialNumber: facts.serialNumber,
      signerCertificateSha256: facts.signerCertificateSha256,
    };
  }
  if (result.status === "pending") return { pending: true };
  return { blockHeight: (result.facts as { readonly blockHeight: number }).blockHeight };
}

/**
 * §6.2's upgrade edge, derived from the carried bytes rather than read from producer bookkeeping.
 *
 * The AnchorEvidence record has no field naming the record it supersedes (§5 rule 3 keeps nothing
 * derivable in the record), so the edge must come out of the set itself or not appear at all. It is
 * emitted exactly when one `(subject-digest, provider)` group carries precisely one pending proof
 * and one completed proof — the shape the design calls "the write-once exception admits exactly
 * this pair" (§11 family 9). Any other group shape leaves the field absent on every member: an
 * ambiguous chain is not an edge this function is willing to assert, and both sides compute the
 * same absence, so the byte-compare holds either way.
 *
 * Recorded as a finding for the design owner: §7.4 does not enumerate this field, and RunState's
 * own `upgradesRecordSha256` admits longer chains than a bundle can express.
 */
function upgradeEdges(
  entries: readonly Omit<ClaimAnchor, "upgradesRecordSha256">[],
  subjectDigests: ReadonlyMap<ClaimAnchorSubject, string>,
): ReadonlyMap<string, string> {
  const edges = new Map<string, string>();
  const groups = new Map<string, typeof entries[number][]>();
  for (const entry of entries) {
    const key = `${subjectDigests.get(entry.subject)!} ${entry.provider}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const group of groups.values()) {
    const pending = group.filter((entry) => isPending(entry.facts));
    const complete = group.filter((entry) => !isPending(entry.facts));
    if (pending.length === 1 && complete.length === 1) {
      edges.set(complete[0]!.recordSha256, pending[0]!.recordSha256);
    }
  }
  return edges;
}

/**
 * Projects the carried AnchorEvidence records into the claim package's `anchors` section.
 *
 * Ordered by record digest so the section has exactly one spelling for one carried set. Throws
 * `ClaimAnchorProjectionError` on a record that is not exactly-sealed, does not parse, names a
 * digest no bundle record has, misdescribes the kind of the record it does name, carries a provider
 * profile no verifier implements, or carries a proof the rules reject.
 */
export function deriveClaimAnchors(input: DeriveClaimAnchorsInput): readonly ClaimAnchor[] {
  const subjectDigests = new Map<ClaimAnchorSubject, string>([
    ["lock", input.runSha256],
    ["matrix", input.matrixSha256],
  ]);
  const kindsBySubject = new Map<ClaimAnchorSubject, string>([
    ["lock", RUN_RECORD_KIND],
    ["matrix", MATRIX_RECORD_KIND],
  ]);

  const partial = [...input.records]
    .sort((left, right) => compareCodeUnits(left.recordSha256, right.recordSha256))
    .map((carried): Omit<ClaimAnchor, "upgradesRecordSha256"> => {
      let record: ReturnType<typeof parseExactAnchorEvidence>;
      let proofBytes: Uint8Array;
      try {
        record = parseExactAnchorEvidence(carried.bytes);
        proofBytes = decodeAnchorProofContent(record.proof.content);
      } catch (cause) {
        throw new ClaimAnchorProjectionError(
          carried.recordSha256,
          `anchor record is not the exact sealed encoding of a conforming AnchorEvidence: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      // Digest-keyed selection. Nothing routes on `subject.kind`; a kind label can never move an
      // anchor onto a claim its digest does not back.
      const subject = [...subjectDigests].find(([, digest]) => digest === record.subject.digest.sha256)?.[0];
      if (subject === undefined) {
        throw new ClaimAnchorProjectionError(
          carried.recordSha256,
          `anchor covers ${record.subject.digest.sha256}, which is neither this bundle's sealed Run nor its sealed Matrix`,
        );
      }
      const resolvedKind = kindsBySubject.get(subject)!;
      if (record.subject.kind !== resolvedKind) {
        throw new ClaimAnchorProjectionError(
          carried.recordSha256,
          `anchor names subject kind ${record.subject.kind}, but the record its digest resolves to is ${resolvedKind}`,
        );
      }
      if (
        record.provider !== RFC3161_TSA_ANCHOR_PROFILE
        && record.provider !== OPENTIMESTAMPS_ANCHOR_PROFILE
      ) {
        throw new ClaimAnchorProjectionError(
          carried.recordSha256,
          `no proof verifier implements the anchor profile ${record.provider}`,
        );
      }
      return {
        subject,
        kind: resolvedKind,
        provider: record.provider,
        recordSha256: carried.recordSha256,
        facts: factsFor(
          carried.recordSha256,
          record.provider,
          verifyCarriedProof(record.provider, record.subject.digest.sha256, proofBytes),
        ),
      };
    });

  const edges = upgradeEdges(partial, subjectDigests);
  return partial.map((entry) => {
    const upgrades = edges.get(entry.recordSha256);
    return upgrades === undefined ? entry : { ...entry, upgradesRecordSha256: upgrades };
  });
}

// ---------------------------------------------------------------------------
// The honesty mapping (§9.2). Every sentence below is the design's own text.
// ---------------------------------------------------------------------------

/** The historical value every unanchored bundle keeps (§9.2, "Additive"). */
export const STRUCTURAL_PRE_REGISTRATION = "structural-and-append-order-only" as const;
/** The widened value an anchored bundle carries. */
export const ANCHORED_PRE_REGISTRATION = "structural-append-order-and-anchored-time" as const;

export const SELF_RUN_TRUST_ROOT =
  "Signatures verify against the bundle-carried public keys minted by this workspace; there is no third-party trust anchor on the self-run venue.";

export const ANCHORED_TRUST_ROOT =
  "Signatures verify against the bundle-carried public keys minted by this workspace. The lock digest "
  + "additionally carries a third-party time anchor, checked against trust material supplied on the "
  + "verifier's side — never against roots carried in this bundle.";

/**
 * A lock anchor gates copy only when it is carried, structurally complete for its class, and
 * digest- and kind-matching (§9.2). The first and last are guaranteed by `deriveClaimAnchors`,
 * which refuses everything else; completeness is the one condition readable off the section: a
 * `pending`-only proof is not structurally complete and gates nothing.
 */
export function governingLockAnchors(anchors: readonly ClaimAnchor[]): readonly ClaimAnchor[] {
  const complete = anchors.filter((anchor) => anchor.subject === "lock" && !isPending(anchor.facts));
  // §4.2's earliest-wins, made total: anchors whose time is byte-embedded order by that time, and
  // they precede the time-less chain-time anchors, which can never be shown to be earlier. Record
  // digest is the deterministic tiebreak, and the sole order among the time-less ones.
  return [...complete].sort((left, right) => {
    const leftTime = isRfc3161Facts(left.facts) ? left.facts.genTime : undefined;
    const rightTime = isRfc3161Facts(right.facts) ? right.facts.genTime : undefined;
    if (leftTime !== undefined && rightTime !== undefined) {
      const compared = compareCalendarStrictRfc3339Instants(leftTime, rightTime);
      if (compared !== undefined && compared !== 0) return compared;
    } else if (leftTime !== undefined) {
      return -1;
    } else if (rightTime !== undefined) {
      return 1;
    }
    return compareCodeUnits(left.recordSha256, right.recordSha256);
  });
}

/** Complete matrix anchors, in record-digest order. A matrix anchor upgrades nothing (§9.2). */
export function carriedMatrixAnchors(anchors: readonly ClaimAnchor[]): readonly ClaimAnchor[] {
  return anchors
    .filter((anchor) => anchor.subject === "matrix" && !isPending(anchor.facts))
    .sort((left, right) => compareCodeUnits(left.recordSha256, right.recordSha256));
}

/** `<genTime|height>` — the one rendering both the replacement sentence and the neutral lines use. */
function anchoredTimeOrHeight(anchor: ClaimAnchor): string {
  return isRfc3161Facts(anchor.facts)
    ? anchor.facts.genTime
    : String((anchor.facts as { readonly blockHeight: number }).blockHeight);
}

/** The time basis a profile rests on (§4.1), as the `<class>` the neutral line names. */
function anchorClass(anchor: ClaimAnchor): "authority-time" | "chain-time" {
  return isRfc3161Facts(anchor.facts) ? "authority-time" : "chain-time";
}

/**
 * The replacement for limitation sentence 2, rendered once from the governing anchor.
 *
 * The `authority-time` form asserts, because its cryptography is fully carried and the verifier
 * re-verifies it unconditionally and fails loud on `invalid`. The `chain-time` form is attributive
 * — it says what the proof asserts and what checking it requires — because structural completeness
 * is not chain evaluation; the assertive chain-time statement lives only in the report of a
 * verifier that evaluated headers (§8, §9.2).
 */
export function anchoredPreRegistrationSentence(governing: ClaimAnchor): string {
  return isRfc3161Facts(governing.facts)
    ? "Pre-registration here is anchored: an external timestamp authority asserts this run's sealed "
      + `design digest existed no later than ${governing.facts.genTime}. That assertion proves the `
      + "design's existence by that time and nothing else about the run — in particular, not that "
      + "results were produced after it — and it is only as good as the authority behind the signing "
      + "key named in the token."
    : "Pre-registration here carries an anchor: an OpenTimestamps proof asserting a Bitcoin "
      + `commitment at block height ${anchoredTimeOrHeight(governing)} covers this run's sealed design `
      + "digest. Checking that commitment requires Bitcoin block headers on the verifier's side; if "
      + "it holds, it shows the design existed no later than that block — and nothing else about the "
      + "run.";
}

/** One neutral line per additional lock anchor (§9.2). It upgrades nothing; it reports. */
export function additionalLockAnchorLine(anchor: ClaimAnchor): string {
  return `The lock digest additionally carries a ${anchorClass(anchor)} anchor of ${anchoredTimeOrHeight(anchor)}.`;
}

/** One neutral line per carried matrix anchor (§9.2). It upgrades no claim. */
export function matrixAnchorLine(anchor: ClaimAnchor): string {
  return `The terminal results digest carries a third-party time anchor of ${anchoredTimeOrHeight(anchor)}.`;
}

/**
 * The complete venue-limits list for one anchor section: the unconditional list with sentence 2
 * replaced by the governing anchor's form, followed by the neutral lines. Sentences 1, 3/3', 4, and
 * 5 are untouched — anchors have nothing to say about operator control, pinning axes, self-reported
 * cost, or agent distinctness (§9.2).
 *
 * With no governing lock anchor the unconditional list is returned unchanged, including when the
 * bundle carries only pending or only matrix anchors: absent, pending, or invalid anchors change
 * nothing.
 */
export function anchoredVenueLimits(
  unconditional: readonly string[],
  anchors: readonly ClaimAnchor[],
): readonly string[] {
  const lock = governingLockAnchors(anchors);
  const matrix = carriedMatrixAnchors(anchors);
  const governing = lock[0];
  if (governing === undefined) {
    return matrix.length === 0 ? unconditional : [...unconditional, ...matrix.map(matrixAnchorLine)];
  }
  const additional = [...lock.slice(1)]
    .sort((left, right) => compareCodeUnits(left.recordSha256, right.recordSha256))
    .map(additionalLockAnchorLine);
  return [
    unconditional[0]!,
    anchoredPreRegistrationSentence(governing),
    ...unconditional.slice(2),
    ...additional,
    ...matrix.map(matrixAnchorLine),
  ];
}

/** `venueHonesty.preRegistration` for one anchor section (§9.2). */
export function anchoredPreRegistration(
  anchors: readonly ClaimAnchor[],
): typeof STRUCTURAL_PRE_REGISTRATION | typeof ANCHORED_PRE_REGISTRATION {
  return governingLockAnchors(anchors).length === 0
    ? STRUCTURAL_PRE_REGISTRATION
    : ANCHORED_PRE_REGISTRATION;
}

/** `claim.verification.trustRoot` for one anchor section (§9.2). */
export function anchoredTrustRoot(anchors: readonly ClaimAnchor[]): string {
  return governingLockAnchors(anchors).length === 0 ? SELF_RUN_TRUST_ROOT : ANCHORED_TRUST_ROOT;
}
