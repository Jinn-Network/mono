// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { EnvironmentVerificationError } from "./errors.js";
import {
  buildEnvironmentCandidatesFromRows,
  type UpstreamEnvironmentRow,
} from "./import-source.js";

const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;

function row(overrides: Partial<UpstreamEnvironmentRow> = {}): UpstreamEnvironmentRow {
  return {
    instance_id: "owner__name-1",
    repo: "owner/name",
    base_commit: "0".repeat(40),
    image_name: `registry.test/owner/name@${IMAGE_A}`,
    install_config: { test_cmd: "pytest -q tests", log_parser: "pytest" },
    parser_version: "1.0.0",
    parser_digest: `sha256:${"e".repeat(64)}`,
    source_license: "MIT",
    dataset: "nebius/SWE-rebench",
    revision: "2026-06-01",
    ...overrides,
  };
}

describe("buildEnvironmentCandidatesFromRows", () => {
  it("collapses rows sharing the full identity tuple into one record", () => {
    const records = buildEnvironmentCandidatesFromRows([
      row(),
      row({ instance_id: "owner__name-2" }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]!.image.manifestDigest).toBe(IMAGE_A);
    expect(records[0]!.lineage?.upstream.keys).toEqual(["owner__name-1", "owner__name-2"]);
  });

  it("splits on any divergence in the identity tuple", () => {
    const cases: Partial<UpstreamEnvironmentRow>[] = [
      { base_commit: "1".repeat(40) },
      { image_name: `registry.test/owner/name@${IMAGE_B}` },
      { platform: "linux/arm64" },
      { install_config: { test_cmd: "pytest -q tests/unit", log_parser: "pytest" } },
      { install_config: { test_cmd: "pytest -q tests", log_parser: "pytest-json" } },
      { parser_version: "2.0.0" },
    ];
    for (const override of cases) {
      const records = buildEnvironmentCandidatesFromRows([
        row(),
        row({ instance_id: "owner__name-2", ...override }),
      ]);
      expect(records).toHaveLength(2);
    }
  });

  it("emits records that round-trip through the record package's own parser", () => {
    const [record] = buildEnvironmentCandidatesFromRows([row()]);
    expect(record!.kind).toBe("https://jinn.network/records/environment/1.0");
    expect(record!.invocations.test).toEqual([{ bin: "pytest", args: ["-q", "tests"] }]);
    expect(record!.workspace).toBe("/testbed");
    expect(record!.build.reproducibilityTier).toBe(0);
    expect(record!.rights.sourceLicense).toBe("MIT");
  });

  it("refuses rows whose image reference is not digest-qualified", () => {
    expect(() => buildEnvironmentCandidatesFromRows([
      row({ image_name: "registry.test/owner/name:latest" }),
    ])).toThrow(/owner__name-1/u);
  });

  it("refuses shell-bearing commands rather than tokenizing them", () => {
    for (const test_cmd of ["pytest -q && echo done", "pytest $ARGS", "pytest -q | tee log"]) {
      expect(() => buildEnvironmentCandidatesFromRows([
        row({ install_config: { test_cmd, log_parser: "pytest" } }),
      ])).toThrow(EnvironmentVerificationError);
    }
  });

  it("refuses a group whose rows disagree on upstream lineage", () => {
    expect(() => buildEnvironmentCandidatesFromRows([
      row(),
      row({ instance_id: "owner__name-2", revision: "2026-07-01" }),
    ])).toThrow(/lineage/u);
  });

  it("refuses a row with no declared source license", () => {
    expect(() => buildEnvironmentCandidatesFromRows([
      row({ source_license: undefined }),
    ])).toThrow(/source_license/u);
  });
});
