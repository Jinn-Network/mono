import { cloudEventsFields, referenceBearingFields, sealJson } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
  RUN_RECORD_KIND,
} from "./identifiers.js";
import {
  benchmarkProfile,
  matrixProfile,
  reportProfile,
  runProfile,
} from "./profiles.js";

// Pinned-digest golden documents (plan Task 6.2): each facts profile is a
// sealed, digest-pinned document. Update these only when a field or key
// ordering changes deliberately.
const EXPECTED_DIGESTS: Record<string, string> = {
  benchmark: "sha256:0e53619e482fe5e1722f8eb630afafbb4428aba4fa62f256d77ebd7537538d05",
  run: "sha256:d3ef84d6941b81b98470c3b1b57c30b20a2140152dc4e2ccd4d354e1625a5d46",
  matrix: "sha256:a9b39bea6fa015466e85334075d9dc3409be7214c4c3576513ba226f3fbbbf9f",
  report: "sha256:b75d0e9a2e7d9100d34774878e394b02267903c2e9424b4ce866afcb4eb75e58",
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

  it("no benchmarking facts profile declares a substrate field", () => {
    for (const profile of [benchmarkProfile, runProfile, matrixProfile, reportProfile]) {
      expect(profile.fields.some((field) => field.class === "substrate")).toBe(false);
    }
  });
});
