import {
  evidenceReferenceKey,
  parseEvidenceCohort,
  parseEvidenceNativeClaimPackageV3,
  type EvidenceCohort,
  type EvidenceNativeClaimPackageV3,
  type EvidenceRecordReference,
} from "@jinn-network/benchmarking-protocol";
import { parseExactDsseEnvelope } from "@jinn-network/trust-core";
import { keyFingerprintFromDidKey } from "./identity/did-key.js";
import type { BundleTrust, BundleV4Trust } from "./schema.js";

/**
 * Who signed, in reader terms. The bundle's own identifiers select signatures and join records,
 * so they stay exact on the machine surface; the human surface is given the role instead
 * (issue #3024).
 */
export type PublicBundleSignerRole =
  | "publisher"
  | "automated-grader"
  | "human-reviewer"
  | "label-admission";

export interface PublicBundleSigner {
  readonly role: PublicBundleSignerRole;
  /** The load-bearing signer identity, verbatim. Machine surface only. */
  readonly identity: string;
  /** The exact key the signature selection resolved to. Machine surface only. */
  readonly keyId: string;
  /**
   * `same-operator` where the bundle itself declares that the key is workspace-minted under the
   * publisher's own custody; `undeclared` where it makes no custody statement. Never a claim that
   * a signer is an independent party -- no bundle format can establish that.
   */
  readonly custody: "same-operator" | "undeclared";
  /**
   * `sha256:<64 hex>` over the signer's raw Ed25519 public key, decoded from its `did:key` (issue
   * #2983). This is the bare name a reader falls back to when no domain is bound, so it digests the
   * KEY rather than the identifier that spells it and is therefore the same value in every bundle
   * format. Absent where `keyId` is not a `did:key` -- there is no key material to digest, and a
   * digest of the identifier string would not be a key fingerprint.
   */
  readonly keyFingerprint?: string;
}

/** Adds the fingerprint where the identifier carries the key, and nothing where it does not. */
function withKeyFingerprint(signer: Omit<PublicBundleSigner, "keyFingerprint">): PublicBundleSigner {
  const keyFingerprint = keyFingerprintFromDidKey(signer.keyId);
  return keyFingerprint === undefined ? signer : { ...signer, keyFingerprint };
}

function deduplicate(signers: readonly PublicBundleSigner[]): readonly PublicBundleSigner[] {
  const seen = new Set<string>();
  return signers.filter((signer) => {
    const key = `${signer.role} ${signer.keyId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Signers of a v2/v4/v6/v7 bundle, read from its already-authenticated `trust/public-keys.json`
 * and the Matrix verdict closure the `trust` check validated it against.
 *
 * Every group this returns is ground-truthed rather than merely declared: `trust.evaluators` is
 * pinned to exactly the union of the Matrix-referenced evaluators and the admission reviewers, and
 * each reviewer binding to the authenticated signed review closure. That union is why the two roles
 * are read from the two sets separately -- an identity that both graded cells and signed reviews is
 * in both, and classifying reviewer-first would print one fewer grader than actually graded. Both
 * trust grammars pin `selfRun.custody: "workspace-minted"` and `partyIndependence:
 * "not-established"`, so same-operator custody is a fact of the parsed record, not an inference.
 *
 * Admission authorities are deliberately absent: the v4 grammar pins every authority keyId to the
 * report key, so listing them would count the publisher's one key twice under two headings.
 */
export function legacyBundleSigners(
  trust: BundleTrust | BundleV4Trust,
  verdictEvaluators: ReadonlySet<string>,
): readonly PublicBundleSigner[] {
  const reviewers = new Set(
    "admission" in trust ? trust.admission.reviewers.map((entry) => entry.evaluator) : [],
  );
  return deduplicate([
    withKeyFingerprint({ role: "publisher", identity: trust.report.author, keyId: trust.report.keyId, custody: "same-operator" }),
    ...trust.evaluators.flatMap((entry) => {
      const roles: PublicBundleSignerRole[] = [];
      // The trust set equals verdicts + reviewers, so "in neither" is unreachable; if a future
      // widening makes it reachable, a signer must still be shown rather than silently dropped.
      if (verdictEvaluators.has(entry.evaluator) || !reviewers.has(entry.evaluator)) roles.push("automated-grader");
      if (reviewers.has(entry.evaluator)) roles.push("human-reviewer");
      return roles.map((role) => withKeyFingerprint({
        role,
        identity: entry.evaluator,
        keyId: entry.keyId,
        custody: "same-operator" as const,
      }));
    }),
  ]);
}

type EvidenceNativeSignerPurpose = EvidenceNativeClaimPackageV3["trust"]["signers"][number]["purpose"];

// Keyed to the purpose union rather than to `string`, so a protocol widening is a build failure
// here instead of an `undefined` role reaching the reader's screen.
const EVIDENCE_NATIVE_PURPOSE_ROLES: Record<EvidenceNativeSignerPurpose, PublicBundleSignerRole> = {
  report: "publisher",
  "automated-evaluator": "automated-grader",
  "human-reviewer": "human-reviewer",
  "label-admission": "label-admission",
};

type ClaimSelection = EvidenceCohort["members"][number]["evaluations"];

function addSelection(
  into: Map<string, EvidenceRecordReference>,
  selection: ClaimSelection,
): void {
  for (const reference of selection.considered) into.set(evidenceReferenceKey(reference), reference);
  for (const reference of selection.admitted) into.set(evidenceReferenceKey(reference), reference);
  for (const entry of selection.excluded) {
    into.set(evidenceReferenceKey(entry.reference), entry.reference);
  }
}

/** Cohort-referenced evidence records. `capture` is a typed source, not declared evidence, and is omitted. */
function cohortReferencedEvidence(cohort: EvidenceCohort): readonly EvidenceRecordReference[] {
  const referenced = new Map<string, EvidenceRecordReference>();
  for (const member of cohort.members) {
    referenced.set(evidenceReferenceKey(member.execution), member.execution);
    addSelection(referenced, member.evaluations);
    addSelection(referenced, member.verifications);
    addSelection(referenced, member.labelResolutions);
  }
  for (const excluded of cohort.excludedExecutions) {
    referenced.set(evidenceReferenceKey(excluded.execution), excluded.execution);
  }
  return [...referenced.values()];
}

function lookupRecordBytes(
  recordFiles: ReadonlyMap<string, Uint8Array>,
  reference: EvidenceRecordReference,
): Uint8Array | undefined {
  const digestPath = `records/${reference.record.digest.sha256}.bin`;
  const byDigest = recordFiles.get(digestPath);
  if (byDigest !== undefined) return byDigest;
  const byName = recordFiles.get(reference.record.name);
  if (byName !== undefined) return byName;
  return recordFiles.get(`records/${reference.record.name}`);
}

function referencedEvidenceKeyIds(
  cohortBytes: Uint8Array,
  recordFiles: ReadonlyMap<string, Uint8Array>,
): Set<string> {
  const keyIds = new Set<string>();
  // Missing `cohort.json` is wired as empty bytes: disclose report keys only, never throw.
  if (cohortBytes.byteLength === 0) return keyIds;
  for (const reference of cohortReferencedEvidence(parseEvidenceCohort(cohortBytes))) {
    if (reference.family === "execution-evidence") continue;
    const bytes = lookupRecordBytes(recordFiles, reference);
    if (bytes === undefined) continue;
    try {
      for (const signature of parseExactDsseEnvelope(bytes).signatures) {
        if (signature.keyid !== undefined) keyIds.add(signature.keyid);
      }
    } catch {
      // Disclosure must not throw a verification-shaped error for a missing or non-DSSE record.
    }
  }
  return keyIds;
}

/**
 * Signers of a v5 evidence-native bundle, read from the same authenticated `claim-package.json`
 * bytes the closure verified.
 *
 * The reader-facing set is verified keys that signed the report or a cohort-referenced declared
 * evidence record. `claim.trust.signers` is a publisher-written declaration used by the closure
 * only as a lookup table: a surplus entry there is never contradicted, because no signature ever
 * selects it. A surplus signed record still verifies and still appears in `verifiedSignerKeyIds`;
 * without the cohort-reference filter a bundle could declare a human reviewer, or a dozen graders,
 * that signed nothing the cohort named and have the checker print them as fact. The claim package
 * declares no custody, so nothing here upgrades a signer to same-operator either.
 */
export function evidenceNativeBundleSigners(
  claimPackageBytes: Uint8Array,
  verifiedSignerKeyIds: readonly string[],
  cohortBytes: Uint8Array,
  recordFiles: ReadonlyMap<string, Uint8Array>,
): readonly PublicBundleSigner[] {
  const claim = parseEvidenceNativeClaimPackageV3(claimPackageBytes);
  const verified = new Set(verifiedSignerKeyIds);
  const allowed = referencedEvidenceKeyIds(cohortBytes, recordFiles);
  for (const signer of claim.trust.signers) {
    if (signer.purpose === "report" && verified.has(signer.keyId)) allowed.add(signer.keyId);
  }
  return deduplicate(claim.trust.signers
    .filter((signer) => verified.has(signer.keyId) && allowed.has(signer.keyId))
    .map((signer) => withKeyFingerprint({
      role: EVIDENCE_NATIVE_PURPOSE_ROLES[signer.purpose],
      identity: signer.identity,
      keyId: signer.keyId,
      custody: "undeclared" as const,
    })));
}
