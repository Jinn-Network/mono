/**
 * The frozen legacy public-bundle closures: `benchmark-product-public-bundle/2`, `/4`, `/6`, `/7`.
 *
 * Every fact a reader needs in order to verify one of those four bundles lives here and nowhere
 * else — the format literals, the mandatory member lists, the check arrays, the claim-package
 * schema ids, the reader-instruction rows, and the per-format guards that select among them.
 *
 * **This module is verification-only and closed.** Existing bundles never change: no
 * re-materialization, no re-signing, no digest churn (bundle-capability-composition design §10).
 * Nothing in here is edited again. The four cells below are the complete legacy zoo — a fifth
 * combination is not allocated here, it is declared by a `/8` bundle's capability vector and
 * derived by the registry that replaces this file's job for new bundles
 * (`docs/superpowers/specs/2026-08-29-bundle-capability-composition-design.md` §13, packets C1/C3).
 *
 * The producer still reads these constants until the C5 cutover makes `/8` its default; after it,
 * this module has exactly one consumer, the verifier, which keeps it forever.
 *
 * The unrelated lineages stay out: `/3` is the accounting-only publication projection and `/5` is
 * the evidence-native bundle (design §12). Anything spanning lineages — `SUPPORTED_BUNDLE_FORMATS`,
 * `BundleManifestSchema`, `PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS` — is composed from these pieces
 * at its own site rather than frozen here.
 */

import { z } from "zod";

// ── Format literals ────────────────────────────────────────────────────────────────────────────

export const BUNDLE_FORMAT = "benchmark-product-public-bundle/2" as const;
export const BUNDLE_V4_FORMAT = "benchmark-product-public-bundle/4" as const;
/** The anchored closure (anchor-evidence design §7.4). Additive: v2, v4, and v5 keep their check
 * lists, byte shapes, and values; the `anchors/` member and the `integrity-anchors` check exist
 * only here. */
export const BUNDLE_V6_FORMAT = "benchmark-product-public-bundle/6" as const;
/**
 * The anchored binary-qualification closure (issue #3205): v4's member list — `qualification.json`,
 * the v4 evidence catalog, the v4 trust document — plus v6's `anchors/` member and its
 * `integrity-anchors` check. Additive in exactly the same way v6 was: v2, v4, v5, and v6 keep their
 * member lists, check lists, and bytes, and only a run that is BOTH anchored and
 * qualification-projecting emits this one.
 */
export const BUNDLE_V7_FORMAT = "benchmark-product-public-bundle/7" as const;

export const LEGACY_BUNDLE_FORMATS = [
  BUNDLE_FORMAT,
  BUNDLE_V4_FORMAT,
  BUNDLE_V6_FORMAT,
  BUNDLE_V7_FORMAT,
] as const;

export type LegacyBundleFormat = (typeof LEGACY_BUNDLE_FORMATS)[number];

/** The legacy lineage's format admission. The object schema that carries it stays in
 * `manifest.ts`, which is where the shared file-entry grammar lives. */
export const LegacyBundleFormatSchema = z.union([
  z.literal(BUNDLE_FORMAT),
  z.literal(BUNDLE_V4_FORMAT),
  z.literal(BUNDLE_V6_FORMAT),
  z.literal(BUNDLE_V7_FORMAT),
]);

// ── Member lists ───────────────────────────────────────────────────────────────────────────────

/** Public bundle members required by the Colophon bundle profile. */
export const PUBLIC_BUNDLE_FILES = [
  "static-bundle.json", "benchmark.json", "run.json", "matrix.json", "report.json",
  "report-envelope.json", "claim-package.json", "verdicts.json", "evidence.json",
  "verification/assembly.jsonl", "trust/public-keys.json", "index.html", "badge.svg",
  "social-card.svg", "README.md", "share.txt",
] as const;

/** V4 is the fixed v2 graph with exactly one canonical qualification projection added. */
export const PUBLIC_BUNDLE_V4_FILES = [
  ...PUBLIC_BUNDLE_FILES.slice(0, 7),
  "qualification.json",
  ...PUBLIC_BUNDLE_FILES.slice(7),
] as const;

// ── Check arrays ───────────────────────────────────────────────────────────────────────────────

export const PUBLIC_BUNDLE_VERIFICATION_CHECKS = [
  "manifest",
  "evidence-closure",
  "trust",
  "matrix-rederivation",
  "report-verification",
  "claim-consistency",
] as const;

/**
 * The anchored closure's check list (anchor-evidence design §8): the six frozen checks plus
 * `integrity-anchors`, which is **always present** for this format — an anchored bundle whose
 * anchors were stripped is a closure failure, not a shorter list. Stated as a per-format constant
 * rather than as an append at the call site, the same way the evidence-native profile states
 * `EVIDENCE_NATIVE_BUNDLE_V5_CHECKS`.
 */
export const PUBLIC_BUNDLE_V6_CHECKS = [
  ...PUBLIC_BUNDLE_VERIFICATION_CHECKS,
  "integrity-anchors",
] as const;

/**
 * The anchored binary-qualification closure runs exactly the anchored list (issue #3205): the
 * qualification projection changes what `evidence-closure` and `claim-consistency` examine, not
 * which checks run.
 */
export const PUBLIC_BUNDLE_V7_CHECKS = PUBLIC_BUNDLE_V6_CHECKS;

// ── Reader-instruction rows ────────────────────────────────────────────────────────────────────

/** First public npm line. 0.x does not promise compatibility across minors. */
export const PUBLIC_BUNDLE_VERIFIER_MAJOR = "0.1" as const;
export const PUBLIC_BUNDLE_V4_VERIFIER_MAJOR = "0.1" as const;

/** Exact producer-side verifier for byte-for-byte reproduction. */
export const PUBLIC_BUNDLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.1.0 <bundle-dir>" as const;

/** Compatible 0.1.x line for fixes that preserve this bundle-format contract. */
export const PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.1 <bundle-dir>" as const;

export const PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND = PUBLIC_BUNDLE_VERIFICATION_COMMAND;
export const PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND =
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND;
export const PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND = PUBLIC_BUNDLE_VERIFICATION_COMMAND;
export const PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND =
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND;

/**
 * Unlike every earlier closure, this one does NOT stamp the first public 0.1 line: no released
 * verifier before 0.2.1 understands `benchmark-product-public-bundle/7`, and a claim naming a
 * reader that cannot read it would be an instruction to fail. 0.2.1 is also the line that carries
 * the prompted-screening admission surface a binary claim may need.
 */
export const PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.2.1 <bundle-dir>" as const;
export const PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.2 <bundle-dir>" as const;

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

// ── Per-format guards ──────────────────────────────────────────────────────────────────────────

/**
 * `anchors/<sha256>.bin` is allowlisted only by the closure versions that define it: an anchor
 * member in a v2 or v4 bundle is a non-allowlisted file, exactly as it was before these formats.
 */
export const LEGACY_ANCHOR_MEMBER_PATTERN = /^anchors\/[a-f0-9]{64}\.bin$/u;

export interface LegacyClosure {
  readonly format: LegacyBundleFormat;
  /** Decides the mandatory member list, the evidence-catalog grammar, and the trust grammar. */
  readonly carriesQualification: boolean;
  /** Decides the `anchors/` allowlist and the `integrity-anchors` check. */
  readonly carriesAnchors: boolean;
  readonly mandatoryFiles: readonly string[];
  readonly checks: readonly string[];
  readonly instructions: {
    readonly command: string;
    readonly compatibleCommand: string;
  };
}

/**
 * Two independent axes, four formats. v6 is v2 plus anchors, v7 is v4 plus anchors (issue #3205) —
 * neither axis reinterprets the other. Hand-enumerated because that is what the closure model is:
 * the composed derivation that replaces this table belongs to the `/8` registry, not here.
 */
export const LEGACY_CLOSURES: { readonly [F in LegacyBundleFormat]: LegacyClosure } = {
  [BUNDLE_FORMAT]: {
    format: BUNDLE_FORMAT,
    carriesQualification: false,
    carriesAnchors: false,
    mandatoryFiles: PUBLIC_BUNDLE_FILES,
    checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
    instructions: {
      command: PUBLIC_BUNDLE_VERIFICATION_COMMAND,
      compatibleCommand: PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
    },
  },
  [BUNDLE_V4_FORMAT]: {
    format: BUNDLE_V4_FORMAT,
    carriesQualification: true,
    carriesAnchors: false,
    mandatoryFiles: PUBLIC_BUNDLE_V4_FILES,
    checks: PUBLIC_BUNDLE_VERIFICATION_CHECKS,
    instructions: {
      command: PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND,
      compatibleCommand: PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND,
    },
  },
  [BUNDLE_V6_FORMAT]: {
    format: BUNDLE_V6_FORMAT,
    carriesQualification: false,
    carriesAnchors: true,
    mandatoryFiles: PUBLIC_BUNDLE_FILES,
    checks: PUBLIC_BUNDLE_V6_CHECKS,
    instructions: {
      command: PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
      compatibleCommand: PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
    },
  },
  [BUNDLE_V7_FORMAT]: {
    format: BUNDLE_V7_FORMAT,
    carriesQualification: true,
    carriesAnchors: true,
    mandatoryFiles: PUBLIC_BUNDLE_V4_FILES,
    checks: PUBLIC_BUNDLE_V7_CHECKS,
    instructions: {
      command: PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
      compatibleCommand: PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
    },
  },
};

export function legacyClosure(format: LegacyBundleFormat): LegacyClosure {
  return LEGACY_CLOSURES[format];
}
