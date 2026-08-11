/**
 * Branding isolation for the standalone benchmark product.
 *
 * See docs/superpowers/specs/2026-08-05-benchmark-product-design.md §9
 * ("Branding isolation") for the design rationale this module implements.
 */

/**
 * The product's identity and attribution — the single source consumed
 * everywhere a product name or attribution appears (CLI banner, GUI chrome,
 * report presentation, claim assets).
 *
 * `attribution` is factual, and appears only in about/verification contexts
 * — never in the product name, primary navigation, category explanation, or
 * hero copy.
 */
export interface ProductBranding {
  readonly displayName: string;
  readonly categoryDescriptor: string;
  readonly tagline: string;
  readonly promise: string;
  readonly attribution: string;
  readonly commandName: string;
}

export const PRODUCT_BRANDING: ProductBranding = {
  displayName: "Colophon",
  categoryDescriptor: "Benchmark publishing for agent configurations",
  tagline: "Compare agents on the same work.",
  promise: "Publish benchmark claims people can check.",
  attribution: "Built on Jinn.",
  commandName: "colophon",
};
