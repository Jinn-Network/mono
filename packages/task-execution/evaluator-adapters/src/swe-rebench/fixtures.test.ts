// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { SWE_REBENCH_FIXTURES } from "./fixtures.js";

describe("swe-rebench fixtures", () => {
  test("every fixture names its legacy provenance", () => {
    expect(SWE_REBENCH_FIXTURES.length).toBeGreaterThanOrEqual(12);
    for (const fixture of SWE_REBENCH_FIXTURES) {
      expect(fixture.provenance).toMatch(/^client\/(src|test)\/.+:\d+/u);
    }
  });

  test("fixture names are unique", () => {
    const names = SWE_REBENCH_FIXTURES.map((fixture) => fixture.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("both graded outcomes and every ungradeable class appear at least once", () => {
    const graded = SWE_REBENCH_FIXTURES.filter((f) => f.expect.kind === "graded");
    expect(graded.some((f) => f.expect.kind === "graded" && f.expect.passed)).toBe(true);
    expect(graded.some((f) => f.expect.kind === "graded" && !f.expect.passed)).toBe(true);
    const classes = new Set(
      SWE_REBENCH_FIXTURES.flatMap((f) =>
        f.expect.kind === "ungradeable" ? [f.expect.ungradeableClass] : []
      ),
    );
    for (const required of [
      "docker_unavailable",
      "patch_does_not_apply",
      "patch_corrupt",
      "workdir_not_git_repo",
      "venv_collision",
      "pytest_missing",
      "requests_dep_mismatch",
      "conftest_import_error",
      "eval_setup_error",
      "eval_report_malformed",
    ]) {
      expect(classes).toContain(required);
    }
  });
});
