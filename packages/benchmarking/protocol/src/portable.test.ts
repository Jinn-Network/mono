// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE,
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE,
} from "./identifiers.js";
import {
  EvidenceNativeBundleManifestV5Schema,
  isMetadataFirstBundleProfile,
} from "./portable.js";

function manifest(profile: string): unknown {
  return {
    format: "benchmark-product-public-bundle/5",
    profile,
    files: [
      { path: "claim-package.json", sha256: "a".repeat(64), bytes: 12 },
      { path: "records/" + "b".repeat(64) + ".bin", sha256: "b".repeat(64), bytes: 34 },
    ],
  };
}

describe("evidence-native bundle v5 profiles", () => {
  test("accepts the full-evidence profile", () => {
    const parsed = EvidenceNativeBundleManifestV5Schema.parse(
      manifest(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE),
    );
    expect(parsed.profile).toBe(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE);
    expect(isMetadataFirstBundleProfile(parsed.profile)).toBe(false);
  });

  test("accepts the metadata-first profile", () => {
    const parsed = EvidenceNativeBundleManifestV5Schema.parse(
      manifest(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE),
    );
    expect(parsed.profile).toBe(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE);
    expect(isMetadataFirstBundleProfile(parsed.profile)).toBe(true);
  });

  test("the two profiles are distinct IRIs on one format", () => {
    expect(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE)
      .not.toBe(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE);
    expect(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE)
      .toBe(`${BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE}/metadata-first`);
  });

  test("refuses an undeclared profile", () => {
    expect(() => EvidenceNativeBundleManifestV5Schema.parse(
      manifest("https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/invented"),
    )).toThrow();
  });
});
