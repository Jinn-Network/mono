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

// MOCK_JUSTIFICATION: the platform package is the boundary, and its judgeability throw is no
// longer reachable through any public option (see the header). Stubbing that one throw is the
// only way left to exercise the product's mapping of it.
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

// `importSweBench` is stubbed, so the row content is inert — it only has to satisfy this module's
// own Zod row schema so the mapping under test is the thing that runs. Deliberately NOT a copy of
// the golden fixture: a copy would imply a coupling that does not exist here, and would rot.
const MINIMAL_ROW = {
  instance_id: "stub-0001",
  repo: "example/repo",
  base_commit: "0000000000000000000000000000000000000000",
  problem_statement: "stub",
  language: "python",
  image: { uri: "https://example.org/image" },
  testMaterial: [{ uri: "https://example.org/test.py" }],
  parser: { id: "jinn.parser.stub", version: "1.0.0", digest: "sha256:00" },
  transitions: { failToPass: ["a"], passToPass: ["b"] },
  timeout: 1,
};

const OPTS = { name: "swe-bench probe", description: "interop conversion test", version: "1.0.0" };

describe("convertSweBenchRows — platform judgeability failures", () => {
  test("a judgeability throw refuses validation naming benchmark-judgeability", () => {
    let caught: unknown;
    try {
      convertSweBenchRows([MINIMAL_ROW], OPTS);
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
