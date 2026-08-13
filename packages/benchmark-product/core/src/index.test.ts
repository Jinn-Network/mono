import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as entry from "./index.js";
import { BENCHMARKING_PROTOCOL, PRODUCT_VERSION } from "./index.js";
import type {
  PreviewArtifact,
  QuoteArmSize,
  QuoteCoverageRefusal,
  QuoteEstimatedWallTime,
  QuotePresentation,
  RunPreviewDeps,
  RunPreviewInput,
  RunPreviewResult,
  RunDriverStatus,
  RunLaunchDeps,
  RunResultsDocument,
  RunResultsReport,
  RunStatusResult,
} from "./index.js";

type PublicPreviewAndQuoteTypes = [
  PreviewArtifact,
  RunPreviewDeps,
  RunPreviewInput,
  RunPreviewResult,
  QuoteArmSize,
  QuoteCoverageRefusal,
  QuoteEstimatedWallTime,
  QuotePresentation,
  RunDriverStatus,
  RunLaunchDeps,
  RunStatusResult,
  RunResultsDocument,
  RunResultsReport,
];

const publicTypesCompile: PublicPreviewAndQuoteTypes | undefined = undefined;

describe("PRODUCT_VERSION", () => {
  test("mirrors package.json's version field", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(PRODUCT_VERSION).toBe(packageJson.version);
  });
});

describe("platform seam", () => {
  test("re-exports BENCHMARKING_PROTOCOL from @jinn-network/benchmarking-records", () => {
    expect(BENCHMARKING_PROTOCOL).toBe("https://spec.jinn.network/protocols/benchmarking/v1");
  });
});

describe("public surface", () => {
  test("the operations facade, domain model, and CLI are all exported from the entry", () => {
    for (const name of [
      "initWorkspace", "createDraft", "updateDraft", "getDraft", "listDrafts", "inspectDraft",
      "transition", "isDraftMutable", "resolveAssurance", "parseDraftSpec", "draftIdFromName",
      "putSealedBytes", "getSealedBytes", "readAuditEntries", "toErrorEnvelope", "runCli",
      "sampleInit", "importSweBenchRows", "selectInspectEvaluation", "armAdd", "armUpdate", "armRemove", "armList",
      "authorityGrant", "authorityRevoke", "authorityShow", "buildSampleBenchmark", "convertSweBenchRows",
      "runPreview", "runQuote", "runLock", "runLaunch", "runResume", "runStatus", "runCancel", "runCollect", "runResults",
      "runReport", "runVerify", "runPublish", "listRuntimeAdapters", "runtimeNativeArtifactPublicationPolicy", "createRuntimeVenue",
      "createDefaultBenchmarkRuntimeHost", "resolveHarborSelection", "createHarborDirectVenue", "harborEvidenceContribution",
    ] as const) {
      expect(typeof entry[name], name).toBe("function");
    }
    expect(entry.LIFECYCLE_STATES).toContain("published-bundle");
    expect(entry.GATED_OPERATIONS).toContain("lock");
    expect(entry.LOCAL_VENUE_LIMITS).toContainEqual(expect.stringContaining("self-run"));
    expect(entry.HARBOR_ADAPTER_ID).toBe("harbor");
    expect(publicTypesCompile).toBeUndefined();
  });
});
