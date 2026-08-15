// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
  expandIdentifiers,
  ftsColumnQuery,
  ftsPhrase,
  isSearchableTerm,
} from "./identifiers.js";

describe("identifier expansion", () => {
  test("splits camelCase and PascalCase", () => {
    expect(expandIdentifiers("parseTrajectory")).toBe("parse Trajectory");
    expect(expandIdentifiers("HttpDiscoveryAPI")).toBe("Http Discovery API");
  });

  test("splits letter/digit boundaries", () => {
    expect(expandIdentifiers("sha256Hex")).toBe("sha 256 Hex");
  });

  test("leaves separator-delimited identifiers alone (the tokenizer splits those)", () => {
    expect(expandIdentifiers("snake_case_thing")).toBe("snake_case_thing");
    expect(expandIdentifiers("operator/src/dashboard")).toBe("operator/src/dashboard");
  });

  test("expands every token in a longer text, preserving order", () => {
    expect(expandIdentifiers("call parseTrajectory then sealRecord")).toBe(
      "call parse Trajectory then seal Record",
    );
  });

  test("is a no-op on ordinary prose", () => {
    expect(expandIdentifiers("the build failed twice")).toBe("the build failed twice");
  });
});

describe("FTS query construction", () => {
  test("a term becomes a quoted phrase", () => {
    expect(ftsPhrase("dashboard")).toBe('"dashboard"');
    expect(ftsPhrase("yarn test --no-threads")).toBe('"yarn test --no-threads"');
  });

  test("embedded double quotes are doubled, not dropped", () => {
    expect(ftsPhrase('say "hi"')).toBe('"say ""hi"""');
  });

  test("FTS5 operators inside a term are inert", () => {
    expect(ftsPhrase("a OR b")).toBe('"a OR b"');
    expect(ftsPhrase("foo*")).toBe('"foo*"');
    expect(ftsPhrase("col : value")).toBe('"col : value"');
  });

  test("column-scoped queries name their columns", () => {
    expect(ftsColumnQuery(["summary", "summary_idents"], "flaky")).toBe(
      '{summary summary_idents} : "flaky"',
    );
  });

  test("a term with no alphanumeric content is not searchable", () => {
    expect(isSearchableTerm("---")).toBe(false);
    expect(isSearchableTerm("...")).toBe(false);
    expect(isSearchableTerm("")).toBe(false);
    expect(isSearchableTerm("v1")).toBe(true);
    expect(isSearchableTerm("客户端")).toBe(true);
  });
});
