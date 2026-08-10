/**
 * Branding isolation for the standalone benchmark product.
 *
 * See docs/superpowers/specs/2026-08-05-benchmark-product-design.md §9
 * ("Branding isolation") for the design rationale this module implements.
 */

/**
 * The product's name, tagline, and attribution — the single source consumed
 * everywhere a product name or attribution appears (CLI banner, GUI chrome,
 * report presentation, claim assets).
 *
 * `displayName` is plainly a placeholder: a later branding engagement
 * replaces it by editing this one module, with no architectural change.
 *
 * `attribution` is factual, and appears only in about/verification contexts
 * — never in the product name, primary navigation, category explanation, or
 * hero copy.
 */
export interface ProductBranding {
  readonly displayName: string;
  readonly tagline: string;
  readonly attribution: string;
}

export const PRODUCT_BRANDING: ProductBranding = {
  displayName: "Benchmark Product (placeholder name)",
  tagline: "Define a benchmark, run it, and hand every number to a verifier.",
  attribution: "Runs on Jinn benchmarking records — independently verifiable",
};
