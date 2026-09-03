// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  buildGoldenDocuments,
  GOLDEN_RECORD_KINDS,
  type GoldenRecordKind,
} from "./golden-documents.js";
import {
  loadGoldenRecordBytes,
  loadGoldenRecordDigest,
  loadGoldenRecordJson,
} from "./fixtures.js";
import { documentDigest } from "./hashing.js";
import { parseExecutionBatchCapture, parseExecutionBatchIntent } from "./batch.js";
import { parseBenchmarkDefinitionV2 } from "./benchmark.js";
import { parseBenchmarkAnalysisManifest } from "./manifest.js";
import { parseEvidenceCohort } from "./cohort.js";
import { parseMatrixV2 } from "./matrix.js";
import { parseEvidenceNativeReportV2 } from "./report.js";
import { parseHumanLabelResolutionPayload } from "./human-label-resolution.js";
import { parseExecutionCommissioningLink } from "./commissioning.js";
import {
  parseEvidenceNativeBundleManifestV5,
  parseEvidenceNativeClaimPackageV3,
} from "./portable.js";

const PARSERS: Record<GoldenRecordKind, (bytes: Uint8Array) => unknown> = {
  "execution-batch-intent": parseExecutionBatchIntent,
  "execution-batch-capture": parseExecutionBatchCapture,
  "benchmark-v2": parseBenchmarkDefinitionV2,
  "analysis-manifest": parseBenchmarkAnalysisManifest,
  "evidence-cohort": parseEvidenceCohort,
  "matrix-v2": parseMatrixV2,
  "report-v2": parseEvidenceNativeReportV2,
  "human-label-resolution": parseHumanLabelResolutionPayload,
  "execution-commissioning-link": parseExecutionCommissioningLink,
  "claim-package-v3": parseEvidenceNativeClaimPackageV3,
  "bundle-manifest-v5": parseEvidenceNativeBundleManifestV5,
};

describe("pinned tier-2 golden fixtures (#3341)", () => {
  const built = buildGoldenDocuments();

  test("every tier-2 record kind has a fixture directory", () => {
    expect(Object.keys(built).sort()).toEqual([...GOLDEN_RECORD_KINDS].sort());
  });

  for (const kind of GOLDEN_RECORD_KINDS) {
    test(`${kind}/valid: stored bytes match the pinned digest, parse, and re-seal`, async () => {
      const bytes = await loadGoldenRecordBytes(kind);
      const pinnedDigest = await loadGoldenRecordDigest(kind);

      // Consumer check: the stored bytes are already canonical, so digest them as-is rather than
      // re-canonicalizing -- re-canonicalizing would hide exactly the drift this fixture pins.
      expect(documentDigest(bytes)).toBe(pinnedDigest);

      // The stored bytes are schema-valid and exact-canonical (parseExact* enforces both).
      expect(() => PARSERS[kind](bytes)).not.toThrow();

      // Producer check: today's builder still reproduces the pinned bytes, byte for byte.
      expect(built[kind].digest).toBe(pinnedDigest);
      expect(built[kind].bytes).toEqual(bytes);

      // The stored file is the same logical document a reader would parse out of it.
      expect(await loadGoldenRecordJson(kind)).toEqual(JSON.parse(new TextDecoder().decode(bytes)));
    });
  }
});
