import { parseEvidenceNativeClaimPackageV3, type EvidenceNativeClaimPackageV3 } from "@jinn-network/benchmarking-protocol";
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
    { role: "publisher", identity: trust.report.author, keyId: trust.report.keyId, custody: "same-operator" },
    ...trust.evaluators.flatMap((entry) => {
      const roles: PublicBundleSignerRole[] = [];
      // The trust set equals verdicts + reviewers, so "in neither" is unreachable; if a future
      // widening makes it reachable, a signer must still be shown rather than silently dropped.
      if (verdictEvaluators.has(entry.evaluator) || !reviewers.has(entry.evaluator)) roles.push("automated-grader");
      if (reviewers.has(entry.evaluator)) roles.push("human-reviewer");
      return roles.map((role) => ({
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

/**
 * Signers of a v5 evidence-native bundle, read from the same authenticated `claim-package.json`
 * bytes the closure verified.
 *
 * `claim.trust.signers` is a publisher-written declaration used by the closure only as a lookup
 * table: a surplus entry there is never contradicted, because no signature ever selects it. So this
 * keeps only the keys that actually carried a signature the closure accepted
 * (`verifiedSignerKeyIds`). Without that filter a bundle could declare a human reviewer, or a dozen
 * graders, that signed nothing and have the checker print them as fact. The claim package declares
 * no custody, so nothing here upgrades a signer to same-operator either.
 */
export function evidenceNativeBundleSigners(
  claimPackageBytes: Uint8Array,
  verifiedSignerKeyIds: readonly string[],
): readonly PublicBundleSigner[] {
  const verified = new Set(verifiedSignerKeyIds);
  return deduplicate(parseEvidenceNativeClaimPackageV3(claimPackageBytes).trust.signers
    .filter((signer) => verified.has(signer.keyId))
    .map((signer) => ({
      role: EVIDENCE_NATIVE_PURPOSE_ROLES[signer.purpose],
      identity: signer.identity,
      keyId: signer.keyId,
      custody: "undeclared" as const,
    })));
}
