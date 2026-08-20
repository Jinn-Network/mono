import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import { assertKnownFlags, optional, parseArgs, pathFrom, present, readJsonFile, readTextFile, required, type ParsedArgs } from "./args.js";

function catchError(run: () => void): BenchmarkProductError {
  try {
    run();
  } catch (cause) {
    expect(cause).toBeInstanceOf(BenchmarkProductError);
    return cause as BenchmarkProductError;
  }
  throw new Error("expected run() to throw");
}

describe("parseArgs", () => {
  test("splits leading positional words from trailing flags", () => {
    const args = parseArgs(["draft", "create", "--name", "My Bench"]);
    expect(args.words).toEqual(["draft", "create"]);
    expect(args.flags.get("name")).toBe("My Bench");
  });

  test("supports --flag=value", () => {
    const args = parseArgs(["init", "--workspace=./ws"]);
    expect(args.words).toEqual(["init"]);
    expect(args.flags.get("workspace")).toBe("./ws");
  });

  test("a valueless boolean flag at the end of argv is present with value \"\"", () => {
    const args = parseArgs(["draft", "list", "--json"]);
    expect(args.flags.has("json")).toBe(true);
    expect(args.flags.get("json")).toBe("");
  });

  test("a valueless boolean flag immediately followed by another flag stays boolean", () => {
    const args = parseArgs(["draft", "list", "--json", "--workspace", "./ws"]);
    expect(args.flags.get("json")).toBe("");
    expect(args.flags.get("workspace")).toBe("./ws");
  });

  test("a positional word after a valued flag is still a word", () => {
    const args = parseArgs(["draft", "create", "--name", "x", "extra"]);
    expect(args.words).toEqual(["draft", "create", "extra"]);
    expect(args.flags.get("name")).toBe("x");
  });

  test("interleaves a valued flag between positional words", () => {
    const args = parseArgs(["method", "--slice", "1", "terminal-bench-2.1"]);
    expect(args.words).toEqual(["method", "terminal-bench-2.1"]);
    expect(args.flags.get("slice")).toBe("1");
  });

  test("a boolean flag does not consume the following positional word", () => {
    const args = parseArgs(["method", "--json", "terminal-bench-2.1"]);
    expect(args.flags.has("json")).toBe(true);
    expect(args.flags.get("json")).toBe("");
    expect(args.words).toEqual(["method", "terminal-bench-2.1"]);
  });

  test("a -- terminator treats remaining tokens as words even when they start with --", () => {
    const args = parseArgs(["method", "--", "--not-a-flag"]);
    expect(args.words).toEqual(["method", "--not-a-flag"]);
    expect(args.flags.size).toBe(0);
  });

  test("a repeated flag refuses invalid-invocation", () => {
    const error = catchError(() => parseArgs(["init", "--workspace", "a", "--workspace", "b"]));
    expect(error.code).toBe("invalid-invocation");
  });
});

describe("assertKnownFlags", () => {
  test("passes silently when every supplied flag is known", () => {
    const args = parseArgs(["init", "--workspace", "a", "--principal", "sponsor-1"]);
    expect(() => assertKnownFlags(args, ["workspace", "principal", "json"])).not.toThrow();
  });

  test("refuses invalid-invocation on an unknown flag, listing the verb's known flags", () => {
    const args = parseArgs(["init", "--frobnicate", "x"]);
    const error = catchError(() => assertKnownFlags(args, ["workspace", "principal", "json"]));
    expect(error.code).toBe("invalid-invocation");
    expect(error.message).toContain("--workspace");
    expect(error.message).toContain("--frobnicate");
  });
});

describe("optional / present / required", () => {
  const args: ParsedArgs = parseArgs(["draft", "show", "--draft", "my-draft", "--json"]);

  test("optional returns the value when present, undefined otherwise", () => {
    expect(optional(args, "draft")).toBe("my-draft");
    expect(optional(args, "missing")).toBeUndefined();
  });

  test("present reports flag presence regardless of value", () => {
    expect(present(args, "json")).toBe(true);
    expect(present(args, "draft")).toBe(true);
    expect(present(args, "missing")).toBe(false);
  });

  test("required returns the value when present and non-empty", () => {
    expect(required(args, "draft")).toBe("my-draft");
  });

  test("required refuses invalid-invocation when the flag is missing", () => {
    const error = catchError(() => required(args, "missing"));
    expect(error.code).toBe("invalid-invocation");
  });

  test("required refuses invalid-invocation when the flag is present but empty (a valueless boolean)", () => {
    const error = catchError(() => required(args, "json"));
    expect(error.code).toBe("invalid-invocation");
  });
});

describe("pathFrom", () => {
  test("passes an absolute path through unchanged", () => {
    expect(pathFrom("/some/cwd", "/abs/path")).toBe("/abs/path");
  });

  test("resolves a relative path against cwd", () => {
    expect(pathFrom("/some/cwd", "relative/dir")).toBe(resolve("/some/cwd", "relative/dir"));
  });
});

describe("readJsonFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp10-args-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads and parses a well-formed JSON file", () => {
    const path = join(dir, "spec.json");
    writeFileSync(path, JSON.stringify({ replicates: 2 }));
    expect(readJsonFile(path)).toEqual({ replicates: 2 });
  });

  test("refuses validation naming the path when the file is missing", () => {
    const path = join(dir, "missing.json");
    const error = catchError(() => readJsonFile(path));
    expect(error.code).toBe("validation");
    expect(error.issues[0]?.path).toBe(path);
    expect(existsSync(path)).toBe(false);
  });

  test("refuses validation naming the path when the file is not JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "not json");
    const error = catchError(() => readJsonFile(path));
    expect(error.code).toBe("validation");
    expect(error.issues[0]?.path).toBe(path);
  });
});

describe("readTextFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "binary-jsonl-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("preserves exact valid UTF-8 text and rejects invalid UTF-8 bytes or a BOM", () => {
    const valid = join(dir, "valid.jsonl");
    writeFileSync(valid, "{\"text\":\"café\"}\n");
    expect(readTextFile(valid)).toBe("{\"text\":\"café\"}\n");

    const invalid = join(dir, "invalid.jsonl");
    writeFileSync(invalid, new Uint8Array([0xff, 0x0a]));
    const error = catchError(() => readTextFile(invalid));
    expect(error.code).toBe("validation");
    expect(error.issues[0]?.path).toBe(invalid);

    const bom = join(dir, "bom.jsonl");
    writeFileSync(bom, new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]));
    const bomError = catchError(() => readTextFile(bom));
    expect(bomError.code).toBe("validation");
    expect(bomError.issues[0]?.path).toBe(bom);
    expect(bomError.message).toContain("BOM");
  });
});
