import { describe, expect, test } from "vitest";
import { firstCommand, usesPrimaryWrapperHelp } from "./help-routing.js";

describe("public CLI help routing", () => {
  test("firstCommand skips flags and stops at --", () => {
    expect(firstCommand([])).toBeUndefined();
    expect(firstCommand(["--help"])).toBeUndefined();
    expect(firstCommand(["--help", "method"])).toBe("method");
    expect(firstCommand(["method", "--help"])).toBe("method");
    expect(firstCommand(["--json", "method", "terminal-bench-2.1"])).toBe("method");
    expect(firstCommand(["--", "method"])).toBeUndefined();
    expect(firstCommand(["method", "--", "foo"])).toBe("method");
  });

  test("wrapper --help stays on demo, open, and bare help", () => {
    expect(usesPrimaryWrapperHelp(["--help"])).toBe(true);
    expect(usesPrimaryWrapperHelp(["demo", "--help"])).toBe(true);
    expect(usesPrimaryWrapperHelp(["open", "--help"])).toBe(true);
    expect(usesPrimaryWrapperHelp(["help", "--help"])).toBe(true);
  });

  test("method --help and GNU-mixed --help method leave the wrapper", () => {
    expect(usesPrimaryWrapperHelp(["method", "--help"])).toBe(false);
    expect(usesPrimaryWrapperHelp(["--help", "method"])).toBe(false);
    expect(usesPrimaryWrapperHelp(["help", "method"])).toBe(false);
    expect(usesPrimaryWrapperHelp(["method"])).toBe(false);
    expect(usesPrimaryWrapperHelp([])).toBe(false);
  });
});
