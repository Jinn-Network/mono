import { describe, expect, it } from "vitest";
import { AdmissionRefusalError } from "./refusals.js";
import { normalizeRepositoryPath, targetTestCommandForPath } from "./test-paths.js";

const record = {
  workspace: "/testbed",
  invocations: {
    test: [{ bin: "python", args: ["-m", "pytest", "-rA"], cwd: "/testbed" }],
  },
} as never;

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("normalizeRepositoryPath", () => {
  it("normalizes a relative path to its canonical segments", () => {
    expect(normalizeRepositoryPath("tests/./unit/test_thing.py", "test path"))
      .toBe("tests/unit/test_thing.py");
  });

  it.each([
    ["", "must not be empty"],
    ["/etc/passwd", "must be repository-relative"],
    ["../outside/test_thing.py", "must not contain traversal"],
    ["tests/../../test_thing.py", "must not contain traversal"],
    ["-rf/test_thing.py", "must not contain option-shaped segments"],
  ])("refuses %s as invalid-candidate", (rawPath, fragment) => {
    const refusal = refusalOf(() => normalizeRepositoryPath(rawPath, "test path"));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain(fragment);
  });
});

describe("targetTestCommandForPath", () => {
  it("appends exactly one workspace-relative target to the single test command", () => {
    expect(targetTestCommandForPath(record, "tests/unit/test_thing.py")).toStrictEqual({
      bin: "python",
      args: ["-m", "pytest", "-rA", "tests/unit/test_thing.py"],
      cwd: "/testbed",
    });
  });

  it("scopes the target to a nested command cwd", () => {
    const nested = {
      workspace: "/testbed",
      invocations: { test: [{ bin: "pytest", args: [], cwd: "/testbed/pkg" }] },
    } as never;
    expect(targetTestCommandForPath(nested, "pkg/tests/test_thing.py").args)
      .toStrictEqual(["tests/test_thing.py"]);
  });

  it("refuses a path outside the test command's working directory", () => {
    const nested = {
      workspace: "/testbed",
      invocations: { test: [{ bin: "pytest", args: [], cwd: "/testbed/pkg" }] },
    } as never;
    const refusal = refusalOf(() => targetTestCommandForPath(nested, "other/test_thing.py"));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("outside the test command workspace");
  });

  it("refuses a record whose test scope is not a single targetable command", () => {
    const twoCommands = {
      workspace: "/testbed",
      invocations: { test: [{ bin: "pytest", args: [] }, { bin: "tox", args: [] }] },
    } as never;
    const refusal = refusalOf(() => targetTestCommandForPath(twoCommands, "tests/test_thing.py"));
    expect(refusal.code).toBe("invalid-environment-record");
    expect(refusal.detail).toContain("exactly one targetable test command");
  });

  it("refuses a record whose workspace is not a safe absolute path", () => {
    const unsafe = {
      workspace: "/testbed/../etc",
      invocations: { test: [{ bin: "pytest", args: [], cwd: "/testbed/pkg" }] },
    } as never;
    const refusal = refusalOf(() => targetTestCommandForPath(unsafe, "pkg/tests/test_thing.py"));
    expect(refusal.code).toBe("invalid-environment-record");
    expect(refusal.detail).toContain("workspace is unsafe");
  });

  it("preserves a command's declared env without aliasing it", () => {
    // The declared env object is held in its own binding: `withEnv` is cast to `never` for the
    // record parameter, and `never` carries no readable properties.
    const declaredEnv = { PYTHONHASHSEED: "0" };
    const withEnv = {
      workspace: "/testbed",
      invocations: { test: [{ bin: "pytest", args: [], env: declaredEnv }] },
    } as never;
    const command = targetTestCommandForPath(withEnv, "tests/test_thing.py");
    expect(command.env).toStrictEqual({ PYTHONHASHSEED: "0" });
    expect(command.env).not.toBe(declaredEnv);
  });
});
