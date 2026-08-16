export const PUBLIC_BUNDLE_VERIFICATION_CHECKS = [
  "manifest",
  "evidence-closure",
  "trust",
  "matrix-rederivation",
  "report-verification",
  "claim-consistency",
] as const;

/** V2 claim-package/1 literals are a frozen part of existing bundle bytes. */
export const PUBLIC_BUNDLE_VERIFIER_MAJOR = "1" as const;
export const PUBLIC_BUNDLE_V4_VERIFIER_MAJOR = "2" as const;

/** Exact producer-side verifier for byte-for-byte reproduction. */
export const PUBLIC_BUNDLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@1.0.0 <bundle-dir>" as const;

/** Compatible major line for fixes that preserve this bundle-format contract. */
export const PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@1 <bundle-dir>" as const;

export const PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@2.0.0 <bundle-dir>" as const;
export const PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@2 <bundle-dir>" as const;

/** Format-scoped commands keep v2 reproduction literals immutable while v4 uses reader2. */
export const PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS = {
  [BUNDLE_FORMAT]: {
    command: PUBLIC_BUNDLE_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V4_FORMAT]: {
    command: PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND,
  },
} as const;
import { BUNDLE_FORMAT, BUNDLE_V4_FORMAT } from "./manifest.js";
