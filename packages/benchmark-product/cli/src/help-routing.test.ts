import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { firstCommand, helpRequested, usesPrimaryWrapperHelp, verbOf } from "./help-routing.js";

const here = dirname(fileURLToPath(import.meta.url));

function booleanFlagsIn(path: string): string[] {
  const literal = readFileSync(path, "utf8").match(/const BOOLEAN_FLAGS = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  expect(literal, path).toBeDefined();
  return [...literal!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!).sort();
}

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
    expect(usesPrimaryWrapperHelp(["help", "method", "--help"])).toBe(false);
    expect(usesPrimaryWrapperHelp(["method"])).toBe(false);
    expect(usesPrimaryWrapperHelp([])).toBe(false);
  });

  // Issue #5197: the CLI keeps its own copy of core's boolean-flag list, and core does not export it.
  test("verbOf skips the same boolean flags as core's parseArgs", () => {
    expect(booleanFlagsIn(join(here, "help-routing.ts"))).toEqual(
      booleanFlagsIn(join(here, "..", "..", "core", "src", "cli", "args.ts")),
    );
  });

  describe("verbOf finds the verb the way core's parseArgs does", () => {
    test("reads the first word, with flags before it", () => {
      expect(verbOf(["quote"])).toBe("quote");
      expect(verbOf(["--json", "quote"])).toBe("quote");
      expect(verbOf(["--workspace", "ws", "quote"])).toBe("quote");
      expect(verbOf(["--principal=me", "quote"])).toBe("quote");
      expect(verbOf([])).toBeUndefined();
    });

    test("the word after -- is the verb, even when it starts with a dash", () => {
      expect(verbOf(["--workspace", "ws", "--principal", "me", "--draft", "d", "--", "quote"])).toBe("quote");
      expect(verbOf(["--", "-x"])).toBe("-x");
      expect(verbOf(["--"])).toBeUndefined();
    });

    test("a value flag at the end takes nothing, and an unknown flag takes the next token", () => {
      expect(verbOf(["--workspace"])).toBeUndefined();
      expect(verbOf(["--json", "--workspace"])).toBeUndefined();
      expect(verbOf(["--foo", "bar", "quote"])).toBe("quote");
      expect(verbOf(["--foo", "quote"])).toBeUndefined();
    });
  });

  // Issue #5198: core's parseArgs reads `--help` and `--help=<value>` as the help flag, and nothing after `--`.
  test("helpRequested agrees with core's parseArgs on the help flag", () => {
    expect(helpRequested(["quote", "--help"])).toBe(true);
    expect(helpRequested(["--help", "quote"])).toBe(true);
    expect(helpRequested(["quote", "--help=1"])).toBe(true);
    expect(helpRequested(["quote", "--help="])).toBe(true);
    expect(helpRequested(["quote", "--", "--help"])).toBe(false);
    expect(helpRequested(["quote", "--helpful"])).toBe(false);
    expect(helpRequested(["quote"])).toBe(false);
    expect(helpRequested([])).toBe(false);
  });
});
