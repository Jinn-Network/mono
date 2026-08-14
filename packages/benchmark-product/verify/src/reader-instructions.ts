import { VERIFIER_VERSION } from "./version.js";

export const PUBLIC_BUNDLE_VERIFICATION_CHECKS = [
  "manifest",
  "evidence-closure",
  "trust",
  "matrix-rederivation",
  "report-verification",
  "claim-consistency",
] as const;

export const PUBLIC_BUNDLE_VERIFIER_MAJOR = VERIFIER_VERSION.split(".", 1)[0]!;

/** Exact producer-side verifier for byte-for-byte reproduction. */
export const PUBLIC_BUNDLE_VERIFICATION_COMMAND =
  `npx @colophon-claims/verify@${VERIFIER_VERSION} <bundle-dir>` as const;

/** Compatible major line for fixes that preserve this bundle-format contract. */
export const PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND =
  `npx @colophon-claims/verify@${PUBLIC_BUNDLE_VERIFIER_MAJOR} <bundle-dir>` as const;
