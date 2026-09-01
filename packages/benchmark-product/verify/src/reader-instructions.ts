export const PUBLIC_BUNDLE_VERIFICATION_CHECKS = [
  "manifest",
  "evidence-closure",
  "trust",
  "matrix-rederivation",
  "report-verification",
  "claim-consistency",
] as const;

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
export const PUBLIC_BUNDLE_V5_VERIFICATION_COMMAND = PUBLIC_BUNDLE_VERIFICATION_COMMAND;
export const PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND =
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND;
export const PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND = PUBLIC_BUNDLE_VERIFICATION_COMMAND;
export const PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND =
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND;

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

/**
 * The disclosed closure's check list (disclosure-specification-record design §7, issue #2839): v7's
 * seven plus `disclosure-specification`, **last**. It runs after `claim-consistency` because the
 * claim's `disclosure` section is among the things it compares, and it is **always present** on this
 * format — a disclosed bundle whose record was stripped is a closure failure, not a shorter list.
 */
export const PUBLIC_BUNDLE_V8_CHECKS = [
  ...PUBLIC_BUNDLE_V7_CHECKS,
  "disclosure-specification",
] as const;

/**
 * Like v7 and for the same reason: no released reader before 0.2.1 understands
 * `benchmark-product-public-bundle/8`, and a claim naming a reader that cannot read it would be an
 * instruction to fail. The disclosed closure ships in the same unpublished 0.2.1 line as v7, so it
 * pins that line rather than minting a third.
 */
export const PUBLIC_BUNDLE_V8_VERIFICATION_COMMAND = PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND;
export const PUBLIC_BUNDLE_V8_COMPATIBLE_VERIFICATION_COMMAND =
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND;

/** Every format through v6 stamps the same first public 0.1 line; v7 is the first that cannot. */
export const PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS = {
  [BUNDLE_FORMAT]: {
    command: PUBLIC_BUNDLE_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V4_FORMAT]: {
    command: PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V5_FORMAT]: {
    command: PUBLIC_BUNDLE_V5_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V6_FORMAT]: {
    command: PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V7_FORMAT]: {
    command: PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V8_FORMAT]: {
    command: PUBLIC_BUNDLE_V8_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V8_COMPATIBLE_VERIFICATION_COMMAND,
  },
} as const;
import {
  BUNDLE_FORMAT,
  BUNDLE_V4_FORMAT,
  BUNDLE_V5_FORMAT,
  BUNDLE_V6_FORMAT,
  BUNDLE_V7_FORMAT,
  BUNDLE_V8_FORMAT,
} from "./manifest.js";
