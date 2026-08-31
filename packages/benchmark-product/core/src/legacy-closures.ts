/**
 * The producer's view of the frozen legacy public-bundle closures:
 * `benchmark-product-public-bundle/2`, `/4`, `/6`, `/7`.
 *
 * Every legacy closure fact the producer names — the format literals, the mandatory member lists,
 * the claim-package schema ids, the pinned reader instructions, and the check arrays the claim
 * builder stamps — is read from here and nowhere else. The verifier keeps the mirror of this file
 * (`@colophon-claims/verify`'s own `legacy-closures`) forever; this one exists so the C5 cutover to
 * the composed `/8` generation is the deletion of one import surface rather than a hunt through the
 * producer for hand-allocated numbers
 * (`docs/superpowers/specs/2026-08-29-bundle-capability-composition-design.md` §10 step 1, §13
 * packet C2).
 *
 * **Closed.** Existing bundles never change: no re-materialization, no re-signing, no digest churn.
 * Nothing in here is edited again, and no fifth cell is added — a new combination is declared by a
 * `/8` bundle's capability vector and derived by the registry (packets C1/C3).
 *
 * Out of scope, and deliberately not here: `/3`, the accounting-only publication projection with
 * its own minimum closure, which keeps its constant in `bundle/manifest.ts`; and `/5`, the
 * evidence-native lineage (design §12).
 */

// The reader-instruction rows and check arrays are single-sourced in the verifier package — the
// producer's pinned command and the verifier's guard on it must be the same string or a claim
// would name a reader that cannot read its own bundle. Re-exported here so the producer still has
// exactly one legacy surface to read.
export {
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_CHECKS,
  PUBLIC_BUNDLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_CHECKS,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
} from "@colophon-claims/verify";

// ── Format literals ────────────────────────────────────────────────────────────────────────────

/** Legacy portable product bundle format. Kept immutable for existing bundles. */
export const BUNDLE_FORMAT = "benchmark-product-public-bundle/2" as const;
/** Binary-instrument qualification bundle. V2 and the unrelated accounting-only v3 stay frozen. */
export const BUNDLE_V4_FORMAT = "benchmark-product-public-bundle/4" as const;
/**
 * The anchored closure (anchor-evidence design §7.4). A bundle emits this version exactly when its
 * run carries at least one AnchorEvidence record; every other bundle keeps the version it already
 * had, byte for byte. The evidence-native v5 is unrelated and untouched.
 */
export const BUNDLE_V6_FORMAT = "benchmark-product-public-bundle/6" as const;
/**
 * The anchored binary-qualification closure (issue #3205). A bundle emits this version exactly when
 * its run both carries an anchor and projects a binary qualification — v6 is v2 plus `anchors/`,
 * this is v4 plus `anchors/`. Every other bundle keeps the version it already had, byte for byte.
 */
export const BUNDLE_V7_FORMAT = "benchmark-product-public-bundle/7" as const;

// ── Member lists ───────────────────────────────────────────────────────────────────────────────

export const PUBLIC_BUNDLE_FILES = [
  "static-bundle.json",
  "benchmark.json",
  "run.json",
  "matrix.json",
  "report.json",
  "report-envelope.json",
  "claim-package.json",
  "verdicts.json",
  "evidence.json",
  "verification/assembly.jsonl",
  "trust/public-keys.json",
  "index.html",
  "badge.svg",
  "social-card.svg",
  "README.md",
  "share.txt",
] as const;

export const PUBLIC_BUNDLE_V4_FILES = [
  ...PUBLIC_BUNDLE_FILES.slice(0, 7),
  "qualification.json",
  ...PUBLIC_BUNDLE_FILES.slice(7),
] as const;

// ── Claim-package ids and their pinned commands ────────────────────────────────────────────────

export const CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/1";
export const BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/2";
/**
 * The anchored claim package (anchor-evidence design §7.4): claim-package/1 plus the `anchors`
 * section, carried by `benchmark-product-public-bundle/6`. The allocation is the next free number
 * in the classic path; the evidence-native claim-package/3 adopts the same anchor surface in its
 * own later allocation.
 */
export const ANCHORED_CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/4";
/**
 * The anchored binary-qualification claim package (issue #3205): claim-package/2's exact
 * qualification projection plus claim-package/4's `anchors` section, carried by
 * `benchmark-product-public-bundle/7`. This is the "later allocation" both earlier guards named:
 * /2 has no anchors slot and /4 has no qualification slot, so before this number existed an
 * anchored run of a binary-instrument benchmark could not produce a claim at all. The allocation is
 * an ADDITION — /1, /2, /3, and /4 keep their meanings and their bytes.
 */
export const ANCHORED_BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/5";
export const BINARY_QUALIFICATION_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.1.0 <bundle-dir>" as const;
export const BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.1 <bundle-dir>" as const;
/** Prompted-screening v2 claims require the verifier release that carries that admission surface. */
export const PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.2.1 <bundle-dir>" as const;
/** Previously materialized prompted bundles remain valid under their immutable 0.2.0 claim. */
export const LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.2.0 <bundle-dir>" as const;
export const PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.2 <bundle-dir>" as const;
