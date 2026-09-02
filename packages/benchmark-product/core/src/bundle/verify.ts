/**
 * Compatibility surface for full-product callers.
 *
 * The reader verifier is owned by the smaller Colophon package so that this
 * path and `colophon-check` cannot drift into two implementations. This
 * adapter preserves core's typed operation-error identity; it does not
 * implement or reinterpret a verification check.
 */
import { verifyPublicBundle as verifyReaderBundle } from "@colophon-claims/check";
import { BenchmarkProductError, PRODUCT_ERROR_CODES, type ProductIssue } from "../errors.js";
import type { PublicBundleVerificationResult, VerifyPublicBundleDeps } from "@colophon-claims/check";

function isIssue(value: unknown): value is ProductIssue {
  return typeof value === "object" && value !== null
    && typeof (value as { path?: unknown }).path === "string"
    && typeof (value as { message?: unknown }).message === "string";
}

export async function verifyPublicBundle(
  bundleDir: string,
  deps: VerifyPublicBundleDeps = {},
): Promise<PublicBundleVerificationResult> {
  try {
    return await verifyReaderBundle(bundleDir, deps);
  } catch (cause) {
    if (cause instanceof BenchmarkProductError) throw cause;
    if (typeof cause === "object" && cause !== null) {
      const code = (cause as { code?: unknown }).code;
      const message = (cause as { message?: unknown }).message;
      const issues = (cause as { issues?: unknown }).issues;
      if (
        typeof code === "string"
        && (PRODUCT_ERROR_CODES as readonly string[]).includes(code)
        && typeof message === "string"
        && Array.isArray(issues)
        && issues.every(isIssue)
      ) {
        throw new BenchmarkProductError(code as (typeof PRODUCT_ERROR_CODES)[number], message, issues);
      }
    }
    throw cause;
  }
}

export type {
  PublicBundleVerificationCheck,
  PublicBundleVerificationResult,
  VerifyPublicBundleDeps,
} from "@colophon-claims/check";
