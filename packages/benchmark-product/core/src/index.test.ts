import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      "sampleInit", "importSweBenchRows", "selectMethod", "exportDerivedBundle", "armAdd", "armUpdate", "armRemove", "armList",
      "authorityGrant", "authorityRevoke", "authorityShow", "buildSampleBenchmark", "convertSweBenchRows", "parseBinaryItemBankIntakeExtension",
      "runPreview", "runQuote", "runLock", "runAnchor", "anchoringConfigure", "runLaunch", "runResume", "runStatus", "runCancel", "runCollect", "runResults",
      "publicationConfigure", "publicationRegister", "publicationAccounting", "publicationStatus",
      "runReport", "runVerify", "runPublish", "listRuntimeAdapters", "runtimeNativeArtifactPublicationPolicy", "createRuntimeVenue",
      "createDefaultBenchmarkRuntimeHost", "resolveHarborSelection", "harborImagePinMatchesTaskToml", "harborTrialTaskName", "harborEvidenceContributionFromArchive",
    ] as const) {
      expect(typeof entry[name], name).toBe("function");
    }
    expect(entry.LIFECYCLE_STATES).toContain("published-bundle");
    expect(entry.GATED_OPERATIONS).toContain("lock");
    expect(entry.LOCAL_VENUE_LIMITS).toContainEqual(expect.stringContaining("self-run"));
    expect(entry.HARBOR_ADAPTER_ID).toBe("harbor");
    expect(publicTypesCompile).toBeUndefined();
  });

  // Issue #4957: the local app must act as a member of the workspace it opens, so a surface that
  // has no principal yet needs to read the members. The reader is what the operations boundary
  // already uses; this pins that it is reachable from the entry and still refuses a directory with none.
  test("exports the authority policy reader, which lists a founded workspace's members", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "bp-index-authority-"));
    try {
      let absent: unknown;
      try {
        entry.readAuthorityPolicy(workspaceDir);
      } catch (cause) {
        absent = cause;
      }
      expect(absent).toBeInstanceOf(entry.BenchmarkProductError);
      expect((absent as InstanceType<typeof entry.BenchmarkProductError>).code).toBe("not-found");

      const founded = entry.initWorkspace({ workspaceDir, principal: "me", clock: () => "2026-10-12T00:00:00.000Z" });
      expect(founded.ok).toBe(true);
      expect(entry.readAuthorityPolicy(workspaceDir).principals.map((principal) => principal.id)).toEqual(["me"]);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("keeps private Inspect host protocol and controller internals out of the product entry", () => {
    for (const name of [
      "createSandboxController",
      "sandboxPolicySha256",
      "SANDBOX_PROTOCOL",
      "SANDBOX_POLICY",
      "INSPECT_SANDBOX_PROTOCOL",
      "INSPECT_SANDBOX_POLICY",
      "INSPECT_SANDBOX_PROVIDER",
    ]) {
      expect(Object.hasOwn(entry, name), name).toBe(false);
    }
  });
});
