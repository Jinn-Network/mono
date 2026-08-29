/**
 * Coverage for the `benchmark-judgeability` mapping in `convertSweBenchRows`.
 *
 * The platform's `importSweBench` runs `checkJudgeability` over the Benchmark it just sealed and
 * throws a plain `Error` when it fails; this product recovers that named check by matching the
 * message and surfaces it as a typed issue. The mapping used to be exercised through a malformed
 * batch `provenanceTimestamp`, which reached the check unvalidated. The platform now validates
 * that value at its own edge, so no public option reaches the judgeability throw any more — the
 * check is purely defensive against a future task-shape regression.
 *
 * Hence the stub: the mapping is real code with a real refusal contract and must stay covered, so
 * the one thing that cannot be produced through the public surface — the platform's throw — is
 * supplied here. The message below is a verbatim copy of the platform's template
 * (`packages/benchmarking/interop/src/import/swebench.ts`); if the platform ever rewords it, this
 * file is the pin that has to be updated alongside the matcher in `swebench.ts`.
 */

import { describe, expect, test, vi } from "vitest";

vi.mock("@jinn-network/benchmarking-interop", () => ({
  importSweBench: () => {
    throw new Error(
      `imported SWE-bench Benchmark failed checkJudgeability: ${JSON.stringify({
        ok: false,
        invalid: [{ taskDigest: "9194a45c228062a1", reason: "invalid-provenance" }],
        unresolved: [],
      })}`,
    );
  },
}));

const { BenchmarkProductError } = await import("../errors.js");
const { convertSweBenchRows } = await import("./swebench.js");

// The platform's own public importer fixture (packages/benchmarking/interop/fixtures/swebench/row.json).
const GOLDEN_ROW = {
  instance_id: "swe-rebench-2024-00042",
  repo: "psf/requests",
  base_commit: "d8bdd423ab2df9f87b7975cdb32b31f3002a20c0",
  problem_statement: "Fix the connection pool leak when retries are exhausted.",
  language: "python",
  image: {
    uri: "https://example.org/images/swe-rebench-runner:2024-00042",
    digest: { sha256: "e8d6cfe4f52e87a1292f3897bf0bea28e4bde32703e6792bb9b1bc60d3024817" },
  },
  testMaterial: [{ uri: "https://example.org/tests/swe-rebench-2024-00042/test_pool.py" }],
  parser: {
    id: "jinn.parser.pytest-json-report",
    version: "1.0.0",
    digest: "sha256:d2136b44c86f551b2494d616a8ee7afd58e6f90681f1beb84441113154a13897",
  },
  transitions: {
    failToPass: ["test_pool.py::test_retry_releases_connection"],
    passToPass: ["test_pool.py::test_basic_get"],
  },
  timeout: 1800,
};

const OPTS = { name: "swe-bench probe", description: "interop conversion test", version: "1.0.0" };

describe("convertSweBenchRows — platform judgeability failures", () => {
  test("a judgeability throw refuses validation naming benchmark-judgeability", () => {
    let caught: unknown;
    try {
      convertSweBenchRows([GOLDEN_ROW], OPTS);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(BenchmarkProductError);
    const error = caught as InstanceType<typeof BenchmarkProductError>;
    expect(error.code).toBe("validation");
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.path).toBe("benchmark-judgeability");
    // The platform's own message is carried through rather than restated.
    expect(error.issues[0]?.message).toContain("checkJudgeability");
  });
});
