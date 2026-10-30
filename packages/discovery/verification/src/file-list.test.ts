// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { FileListError, parseFileList } from "./file-list.js";

const digest = "a".repeat(64);
const entry = (path: unknown, overrides: Record<string, unknown> = {}) => ({ path, bytes: 1, sha256: digest, ...overrides });
const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const parse = (value: unknown) => parseFileList(encode(value), "bundle.json");
const problemsOf = (...files: readonly unknown[]) => parse({ files }).problems;

describe("a file list", () => {
  test("gives its entries in order", () => {
    const { entries, problems } = parse({ files: [entry("a"), entry("b/c")] });
    expect(problems).toEqual([]);
    expect(entries).toEqual([entry("a"), entry("b/c")]);
  });

  test("ignores other top-level members, which the root still commits to", () => {
    expect(parse({ format: "anything/10", capabilities: ["anchoring"], files: [entry("a")] }).problems).toEqual([]);
  });

  test("accepts a file of no bytes", () => {
    expect(problemsOf(entry("a", { bytes: 0 }))).toEqual([]);
  });

  test("sorts by UTF-16 code unit, so a dot comes before a slash and an astral character before U+FF5E", () => {
    expect(problemsOf(entry("Z"), entry("a"), entry("a.b"), entry("a/b"))).toEqual([]);
    expect(problemsOf(entry("\u{1F600}"), entry("～"))).toEqual([]);
    expect(problemsOf(entry("～"), entry("\u{1F600}"))).toHaveLength(1);
  });
});

describe("bytes that are not a file list at all", () => {
  test.each<[string, unknown]>([
    ["not JSON", "not json"],
    ["a repeated member", `{"files":[],"files":[${JSON.stringify(entry("a"))}]}`],
    ["a JSON array", [entry("a")]],
    ["a JSON string", "\"files\""],
    ["null", "null"],
    ["no files member", { format: "x" }],
    ["files not an array", { files: { a: 1 } }],
    ["no files listed", { files: [] }],
  ])("%s", (_name, value) => {
    expect(() => parse(value)).toThrow(FileListError);
  });

  test("bytes that are not UTF-8", () => {
    expect(() => parseFileList(new Uint8Array([0x7b, 0xff, 0x7d]), "bundle.json")).toThrow(FileListError);
  });
});

describe("an entry breaking the format", () => {
  test.each<[string, unknown, string]>([
    ["not an object", "a", "is not an object"],
    ["null", null, "is not an object"],
    ["an array", [], "is not an object"],
    ["a path that is not a string", entry(5), "is not relative and normalized"],
    ["a missing path", { bytes: 1, sha256: digest }, "is not relative and normalized"],
    ["an empty path", entry(""), "is not relative and normalized"],
    ["an absolute path", entry("/etc/passwd"), "is not relative and normalized"],
    ["a dot", entry("."), "is not relative and normalized"],
    ["a dot segment", entry("a/./b"), "is not relative and normalized"],
    ["a parent", entry(".."), "is not relative and normalized"],
    ["a parent segment", entry("a/../b"), "is not relative and normalized"],
    ["an empty segment", entry("a//b"), "is not relative and normalized"],
    ["a trailing slash", entry("a/"), "is not relative and normalized"],
    ["a backslash", entry("a\\b"), "is not relative and normalized"],
    ["a negative length", entry("a", { bytes: -1 }), "is not a length"],
    ["a fractional length", entry("a", { bytes: 1.5 }), "is not a length"],
    ["a length past what a double counts", entry("a", { bytes: 2 ** 53 }), "is not a length"],
    ["a length that is a string", entry("a", { bytes: "1" }), "is not a length"],
    ["uppercase digest", entry("a", { sha256: "A".repeat(64) }), "is not a SHA-256 in lowercase hex"],
    ["a short digest", entry("a", { sha256: "a".repeat(63) }), "is not a SHA-256 in lowercase hex"],
    ["a digest with its algorithm", entry("a", { sha256: `sha256:${digest}` }), "is not a SHA-256 in lowercase hex"],
    ["a missing digest", { path: "a", bytes: 1 }, "is not a SHA-256 in lowercase hex"],
    ["a member too many", entry("a", { note: "x" }), "holds something other than path, bytes and sha256"],
    ["the list itself", entry("bundle.json"), "names the list itself"],
  ])("%s", (_name, value, expected) => {
    const problems = problemsOf(value);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^entry 1: /u);
    expect(problems[0]).toContain(expected);
  });

  test("a repeated path", () => {
    expect(problemsOf(entry("a"), entry("a"))).toEqual(["entry 2: a is listed twice"]);
  });

  test("paths out of order", () => {
    expect(problemsOf(entry("b"), entry("a"))).toEqual(["entry 2: a is out of order"]);
  });

  test("every broken entry is named, and the good ones are still compared for order", () => {
    expect(problemsOf(entry("b"), entry("../x"), entry("a"))).toEqual([
      'entry 2: path "../x" is not relative and normalized',
      "entry 3: a is out of order",
    ]);
  });
});
