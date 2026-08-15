import { describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import { convertSweBenchRows } from "./swebench.js";

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

function catchError(fn: () => unknown): BenchmarkProductError {
  let caught: unknown;
  try {
    fn();
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(BenchmarkProductError);
  return caught as BenchmarkProductError;
}

describe("convertSweBenchRows", () => {
  test("the golden row converts to a sealed benchmark with one item, deterministically", () => {
    const first = convertSweBenchRows([GOLDEN_ROW], OPTS);
    expect(first.imported.tasks).toHaveLength(1);
    expect(first.imported.benchmark.record.items).toHaveLength(1);

    const second = convertSweBenchRows([GOLDEN_ROW], OPTS);
    expect(second.imported.benchmark.digest).toBe(first.imported.benchmark.digest);
    expect(second.imported.tasks[0]?.digest).toBe(first.imported.tasks[0]?.digest);
  });

  test("the same row twice in one file refuses validation naming benchmark-item-distinctness", () => {
    const error = catchError(() => convertSweBenchRows([GOLDEN_ROW, GOLDEN_ROW], OPTS));
    expect(error.code).toBe("validation");
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.path).toBe("benchmark-item-distinctness");
  });

  test("an invalid provenanceTimestamp refuses validation naming benchmark-judgeability", () => {
    const error = catchError(() =>
      convertSweBenchRows([GOLDEN_ROW], { ...OPTS, provenanceTimestamp: "not-a-timestamp" }),
    );
    expect(error.code).toBe("validation");
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.path).toBe("benchmark-judgeability");
  });

  test("malformed rows fail before any platform call, naming rows.<index>.<field>", () => {
    const { base_commit: _omit, ...rowMissingBaseCommit } = GOLDEN_ROW;
    const rowBadTimeout = { ...GOLDEN_ROW, timeout: 0 };

    const error = catchError(() => convertSweBenchRows([rowMissingBaseCommit, rowBadTimeout], OPTS));
    expect(error.code).toBe("validation");
    const paths = error.issues.map((issue) => issue.path);
    expect(paths).toContain("rows.0.base_commit");
    expect(paths).toContain("rows.1.timeout");
  });

  test("non-array input refuses validation", () => {
    const error = catchError(() => convertSweBenchRows({ not: "an array" }, OPTS));
    expect(error.code).toBe("validation");
  });
});
