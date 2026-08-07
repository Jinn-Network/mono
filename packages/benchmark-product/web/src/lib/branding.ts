/**
 * Placeholder product identity for the web shell.
 *
 * TEMPORARY DUPLICATION, by design: the single branding source is the core
 * package's `PRODUCT_BRANDING` (product design spec §9); this skeleton
 * deliberately has no dependency on core yet, so it carries only the two
 * strings it renders. The wiring packet replaces this module with the core
 * import. `src/branding-isolation.test.ts` pins these strings byte-equal to
 * core's source so they cannot drift silently in the meantime.
 */
export const WEB_BRANDING = {
  displayName: "Benchmark Product (placeholder name)",
  tagline: "Define a benchmark, run it, and hand every number to a verifier.",
} as const;
