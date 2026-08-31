import { EVIDENCE_NATIVE_BUNDLE_V5_CHECKS } from "@jinn-network/benchmarking-evidence";
import {
  PUBLIC_BUNDLE_VERIFICATION_CHECKS,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V7_CHECKS,
  PUBLIC_BUNDLE_V8_CHECKS,
} from "./reader-instructions.js";
import type { PublicBundleVerificationResult } from "./verify.js";

/**
 * The one check a metadata-first `benchmark-product-public-bundle/5` defers (issue #2986): its
 * artifact digests are carried, its artifact bodies are not.
 */
export const NOT_FETCHED_CHECK = "artifact-integrity" as const;

export type VerificationCheckState = "passed" | "not fetched";

export interface VerificationCheckOutcome {
  readonly check: string;
  readonly state: VerificationCheckState;
}

export interface VerificationOutcome {
  readonly outcomes: readonly VerificationCheckOutcome[];
  /** Checks that actually passed. A deferred check is never counted here. */
  readonly passed: number;
  readonly notFetched: number;
  /** The check count the bundle's declared format promises. */
  readonly total: number;
  /** Present exactly when the bundle deferred artifact content. */
  readonly artifactContent?: {
    readonly notFetched: number;
    readonly notFetchedDigests: readonly string[];
  };
}

/**
 * The single derivation of what a verification result may be said to have proved. Every reader
 * surface -- the standalone CLI, the product CLI, the local viewer, the web action -- reads this
 * rather than counting `checks` itself, because a surface that counts for itself is a surface that
 * can print a pass over bytes nobody read (issue #2986).
 */
export function summarizeVerificationOutcome(result: PublicBundleVerificationResult): VerificationOutcome {
  const total = result.format === "benchmark-product-public-bundle/5"
    ? EVIDENCE_NATIVE_BUNDLE_V5_CHECKS.length
    : result.format === "benchmark-product-public-bundle/6"
      ? PUBLIC_BUNDLE_V6_CHECKS.length
      : result.format === "benchmark-product-public-bundle/7"
        ? PUBLIC_BUNDLE_V7_CHECKS.length
        : result.format === "benchmark-product-public-bundle/8"
          ? PUBLIC_BUNDLE_V8_CHECKS.length
          : PUBLIC_BUNDLE_VERIFICATION_CHECKS.length;
  const deferred = result.format === "benchmark-product-public-bundle/5"
    && result.artifactContent.status === "not-fetched"
    ? result.artifactContent
    : undefined;
  const outcomes = result.checks.map((check) => ({
    check,
    state: (deferred !== undefined && check === NOT_FETCHED_CHECK ? "not fetched" : "passed") as VerificationCheckState,
  }));
  const notFetched = outcomes.filter((outcome) => outcome.state === "not fetched").length;
  return {
    outcomes,
    passed: outcomes.length - notFetched,
    notFetched,
    total,
    ...(deferred === undefined ? {} : {
      artifactContent: {
        notFetched: deferred.notFetched,
        notFetchedDigests: deferred.notFetchedDigests,
      },
    }),
  };
}
