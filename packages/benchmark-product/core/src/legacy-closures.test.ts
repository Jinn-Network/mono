import { describe, expect, test } from "vitest";
import * as verifier from "@colophon-claims/verify";
import * as producer from "./legacy-closures.js";

/**
 * The producer names the legacy closures in its own module because it must keep naming them until
 * the `/8` cutover, and the verifier keeps its copy forever. Two copies of a frozen fact drift
 * silently: a producer that stamped a different pinned command, member list, or claim-package id
 * than the verifier guards would emit bundles no released reader accepts. This is the drift guard.
 */
describe("the producer's legacy closures match the verifier's", () => {
  test("format literals", () => {
    expect(producer.BUNDLE_FORMAT).toBe(verifier.BUNDLE_FORMAT);
    expect(producer.BUNDLE_V4_FORMAT).toBe(verifier.BUNDLE_V4_FORMAT);
    expect(producer.BUNDLE_V6_FORMAT).toBe(verifier.BUNDLE_V6_FORMAT);
    expect(producer.BUNDLE_V7_FORMAT).toBe(verifier.BUNDLE_V7_FORMAT);
  });

  test("reader-instruction rows and check arrays are single-sourced, not copied", () => {
    expect(producer.PUBLIC_BUNDLE_VERIFICATION_CHECKS).toBe(verifier.PUBLIC_BUNDLE_VERIFICATION_CHECKS);
    expect(producer.PUBLIC_BUNDLE_V6_CHECKS).toBe(verifier.PUBLIC_BUNDLE_V6_CHECKS);
    expect(producer.PUBLIC_BUNDLE_V7_CHECKS).toBe(verifier.PUBLIC_BUNDLE_V7_CHECKS);
    expect(producer.PUBLIC_BUNDLE_VERIFICATION_COMMAND).toBe(verifier.PUBLIC_BUNDLE_VERIFICATION_COMMAND);
    expect(producer.PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND)
      .toBe(verifier.PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND);
    expect(producer.PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND).toBe(verifier.PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND);
    expect(producer.PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND)
      .toBe(verifier.PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND);
    expect(producer.PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND).toBe(verifier.PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND);
    expect(producer.PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND)
      .toBe(verifier.PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND);
  });
});

describe("frozen producer values", () => {
  test("the claim-package ids", () => {
    expect(producer.CLAIM_PACKAGE_SCHEMA_ID).toBe("benchmark-product.claim-package/1");
    expect(producer.BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID).toBe("benchmark-product.claim-package/2");
    expect(producer.ANCHORED_CLAIM_PACKAGE_SCHEMA_ID).toBe("benchmark-product.claim-package/4");
    expect(producer.ANCHORED_BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID)
      .toBe("benchmark-product.claim-package/5");
  });

  test("the qualification claims' pinned commands", () => {
    expect(producer.BINARY_QUALIFICATION_VERIFICATION_COMMAND)
      .toBe("npx @colophon-claims/verify@0.1.0 <bundle-dir>");
    expect(producer.BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND)
      .toBe("npx @colophon-claims/verify@0.1 <bundle-dir>");
    expect(producer.PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND)
      .toBe("npx @colophon-claims/verify@0.2.1 <bundle-dir>");
    expect(producer.LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND)
      .toBe("npx @colophon-claims/verify@0.2.0 <bundle-dir>");
    expect(producer.PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND)
      .toBe("npx @colophon-claims/verify@0.2 <bundle-dir>");
  });

  /**
   * The verifier does not publish its member lists — it reaches them through its own closure
   * table — so the two copies are pinned to the same literal on each side rather than compared
   * across the package boundary. A drift in either copy fails its own pin.
   */
  test("the member lists, in order", () => {
    expect(producer.PUBLIC_BUNDLE_FILES).toEqual([
      "static-bundle.json", "benchmark.json", "run.json", "matrix.json", "report.json",
      "report-envelope.json", "claim-package.json", "verdicts.json", "evidence.json",
      "verification/assembly.jsonl", "trust/public-keys.json", "index.html", "badge.svg",
      "social-card.svg", "README.md", "share.txt",
    ]);
    expect(producer.PUBLIC_BUNDLE_V4_FILES).toEqual([
      "static-bundle.json", "benchmark.json", "run.json", "matrix.json", "report.json",
      "report-envelope.json", "claim-package.json", "qualification.json", "verdicts.json",
      "evidence.json", "verification/assembly.jsonl", "trust/public-keys.json", "index.html",
      "badge.svg", "social-card.svg", "README.md", "share.txt",
    ]);
  });
});
