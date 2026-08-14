import { cloudEventsFields, referenceBearingFields, sealJson } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
  REPORT_V2_RECORD_KIND,
  RUN_RECORD_KIND,
} from "./identifiers.js";
import {
  benchmarkAccountingProfile,
  benchmarkProfile,
  matrixProfile,
  reportProfile,
  signedReportProfile,
  runProfile,
} from "./profiles.js";

// Pinned-digest golden documents (plan Task 6.2): each facts profile is a
// sealed, digest-pinned document. Update these only when a field or key
// ordering changes deliberately.
const EXPECTED_DIGESTS: Record<string, string> = {
  benchmark: "sha256:46e35e23cf24bc3b3eff79d6e25e9bc9f595f1cb53f05caabd6ce57e08e32fdd",
  run: "sha256:c7cd601d477aa308994c6f135f6026967d51a6f8700c735b58c885ae33ba9732",
  matrix: "sha256:80458de1c987bb7a68a73b3a0e0673cbbeb4106abe610ef916e4d09e99bdb76a",
  report: "sha256:85c7392b237da814e4dbdfdee1b4c7d9eb71663237d585e41320c3fb547f0b35",
  reportV2: "sha256:23e0de1dc0b30dc1cf8fa3eac8941fb9235240cc46c139b64b91eda4968a984f",
  accounting: "sha256:05344dba20f0ad2b229ce45b1d15a77e3982b396ccad5b592c690f0e2cc0ec50",
};

function expectPinnedDigest(name: string, digest: string) {
  const expected = EXPECTED_DIGESTS[name];
  if (expected === undefined || expected === "sha256:PENDING") {
    throw new Error(
      `No pinned digest for "${name}" yet -- actual digest: ${digest}\n`
        + "Paste this into EXPECTED_DIGESTS and re-run.",
    );
  }
  expect(digest).toBe(expected);
}

describe("facts/benchmarking profile documents (program §7.128)", () => {
  it("benchmark profile labels digest/author/version and CloudEvents author/benchversion", () => {
    expect(benchmarkProfile.kind).toBe(BENCHMARK_RECORD_KIND);
    expect(benchmarkProfile.fields.map((field) => field.name)).toEqual([
      "benchmarkDigest",
      "author",
      "version",
    ]);
    expect(referenceBearingFields(benchmarkProfile)).toEqual([]);
    expect(
      cloudEventsFields(benchmarkProfile).map((field) => [
        field.name,
        field.cloudEvents?.attribute,
      ]),
    ).toEqual([
      ["author", "author"],
      ["version", "benchversion"],
    ]);
    expectPinnedDigest("benchmark", sealJson(benchmarkProfile).digest);
  });

  it("run profile labels digest/owner/benchmarkDigest and CloudEvents owner/benchmark", () => {
    expect(runProfile.kind).toBe(RUN_RECORD_KIND);
    expect(runProfile.fields.map((field) => field.name)).toEqual([
      "runDigest",
      "owner",
      "benchmarkDigest",
    ]);
    expect(referenceBearingFields(runProfile)).toEqual(["benchmarkDigest"]);
    expect(
      cloudEventsFields(runProfile).map((field) => [
        field.name,
        field.cloudEvents?.attribute,
      ]),
    ).toEqual([
      ["owner", "owner"],
      ["benchmarkDigest", "benchmark"],
    ]);
    expectPinnedDigest("run", sealJson(runProfile).digest);
  });

  it("matrix profile labels digest/runDigest/runOutcome and CloudEvents run/runoutcome", () => {
    expect(matrixProfile.kind).toBe(MATRIX_RECORD_KIND);
    expect(matrixProfile.fields.map((field) => field.name)).toEqual([
      "matrixDigest",
      "runDigest",
      "runOutcome",
    ]);
    expect(referenceBearingFields(matrixProfile)).toEqual(["runDigest"]);
    expect(
      cloudEventsFields(matrixProfile).map((field) => [
        field.name,
        field.cloudEvents?.attribute,
      ]),
    ).toEqual([
      ["runDigest", "run"],
      ["runOutcome", "runoutcome"],
    ]);
    expectPinnedDigest("matrix", sealJson(matrixProfile).digest);
  });

  it("report profile labels plural matrixDigests (non-CloudEvents) plus method/author/preregistered", () => {
    expect(reportProfile.kind).toBe(REPORT_RECORD_KIND);
    expect(reportProfile.fields.map((field) => field.name)).toEqual([
      "matrixDigests",
      "methodId",
      "methodVersion",
      "author",
      "preregistered",
    ]);
    expect(referenceBearingFields(reportProfile)).toEqual(["matrixDigests"]);
    expect(
      cloudEventsFields(reportProfile).map((field) => [
        field.name,
        field.cloudEvents?.attribute,
      ]),
    ).toEqual([
      ["methodId", "methodid"],
      ["author", "author"],
    ]);
    expect(
      reportProfile.fields.find((field) => field.name === "matrixDigests")?.cloudEvents,
    ).toBeUndefined();
    expectPinnedDigest("report", sealJson(reportProfile).digest);
  });

  it("signed Report v2 declares envelope and payload identities separately from legacy v1", () => {
    expect(signedReportProfile.kind).toBe(REPORT_V2_RECORD_KIND);
    expect(signedReportProfile.fields.map((field) => field.name)).toEqual([
      "reportRecordDigest",
      "reportPayloadDigest",
      "recordMediaType",
      "payloadMediaType",
      "matrixDigests",
      "methodId",
      "methodVersion",
      "author",
      "preregistered",
    ]);
    expect(referenceBearingFields(signedReportProfile)).toEqual(["matrixDigests"]);
    expectPinnedDigest("reportV2", sealJson(signedReportProfile).digest);
  });

  it("BenchmarkAccounting exposes declared scope, registration, and authority without a trust result", () => {
    expect(benchmarkAccountingProfile.kind).toBe(BENCHMARK_ACCOUNTING_RECORD_KIND);
    expect(benchmarkAccountingProfile.fields.map((field) => field.name)).toEqual([
      "accountingDigest",
      "recordMediaType",
      "runDigest",
      "publisher",
      "procedureId",
      "procedureVersion",
      "closeAt",
      "closeAnchorChain",
      "closeAnchorBlockNumber",
      "closeAnchorBlockHash",
      "scopeStreamCount",
      "scopeStreams",
      "publicRegistrationStatus",
      "publisherAuthorityKind",
      "publisherAuthorizationDigest",
      "cellCount",
      "dispatchCount",
    ]);
    expect(referenceBearingFields(benchmarkAccountingProfile)).toEqual([
      "runDigest",
      "publisherAuthorizationDigest",
    ]);
    expectPinnedDigest("accounting", sealJson(benchmarkAccountingProfile).digest);
  });

  it("no benchmarking facts profile declares a substrate field", () => {
    for (const profile of [
      benchmarkProfile,
      runProfile,
      matrixProfile,
      reportProfile,
      signedReportProfile,
      benchmarkAccountingProfile,
    ]) {
      expect(profile.fields.some((field) => field.class === "substrate")).toBe(false);
    }
  });
});
