import { parseEvidenceNativeClaimPackageV3 } from "@jinn-network/benchmarking-protocol";
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
 * Signers of a v2/v4/v6/v7 bundle, read from its already-authenticated `trust/public-keys.json`.
 * Both trust grammars pin `selfRun.custody: "workspace-minted"` and
 * `partyIndependence: "not-established"`, so same-operator custody is a fact of the parsed record
 * rather than an inference. Admission authorities are pinned to the report key, so they collapse
 * onto one `label-admission` entry rather than repeating the publisher's key per attestor role.
 */
export function legacyBundleSigners(trust: BundleTrust | BundleV4Trust): readonly PublicBundleSigner[] {
  const reviewers = new Set(
    "admission" in trust ? trust.admission.reviewers.map((entry) => entry.evaluator) : [],
  );
  return deduplicate([
    { role: "publisher", identity: trust.report.author, keyId: trust.report.keyId, custody: "same-operator" },
    ...trust.evaluators.map((entry) => ({
      role: reviewers.has(entry.evaluator) ? "human-reviewer" as const : "automated-grader" as const,
      identity: entry.evaluator,
      keyId: entry.keyId,
      custody: "same-operator" as const,
    })),
    ...("admission" in trust
      ? trust.admission.authorities.map((entry) => ({
        role: "label-admission" as const,
        identity: trust.report.author,
        keyId: entry.keyId,
        custody: "same-operator" as const,
      }))
      : []),
  ]);
}

const EVIDENCE_NATIVE_PURPOSE_ROLES = {
  report: "publisher",
  "automated-evaluator": "automated-grader",
  "human-reviewer": "human-reviewer",
  "label-admission": "label-admission",
} as const satisfies Record<string, PublicBundleSignerRole>;

/**
 * Signers of a v5 evidence-native bundle, read from the same authenticated `claim-package.json`
 * bytes the closure verified. The claim package declares no custody, so nothing here upgrades an
 * undeclared signer to same-operator.
 */
export function evidenceNativeBundleSigners(claimPackageBytes: Uint8Array): readonly PublicBundleSigner[] {
  return deduplicate(parseEvidenceNativeClaimPackageV3(claimPackageBytes).trust.signers.map((signer) => ({
    role: EVIDENCE_NATIVE_PURPOSE_ROLES[signer.purpose],
    identity: signer.identity,
    keyId: signer.keyId,
    custody: "undeclared" as const,
  })));
}
