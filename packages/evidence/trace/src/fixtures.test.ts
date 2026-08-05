import { describe, expect, test } from "vitest";

import { traceFixtureUrl } from "./fixtures.js";

describe("trace fixture paths", () => {
  test("rejects raw traversal", () => {
    expect(() => traceFixtureUrl("../secret.json")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects percent-encoded traversal", () => {
    expect(() => traceFixtureUrl("..%2F..%2Fsecret.json")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects raw backslashes", () => {
    expect(() => traceFixtureUrl("..\\..\\outside")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects percent-encoded backslashes", () => {
    expect(() => traceFixtureUrl("..%5c..%5coutside")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
    expect(() => traceFixtureUrl("..%5C..%5Coutside")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects percent-encoded slashes", () => {
    expect(() => traceFixtureUrl("trace%2fvalid.json")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
    expect(() => traceFixtureUrl("trace%2Fvalid.json")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects double-encoded separators", () => {
    expect(() => traceFixtureUrl("%252e%252e/outside")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects query and hash suffixes", () => {
    expect(() => traceFixtureUrl("trace/valid.json?x=1")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
    expect(() => traceFixtureUrl("trace/valid.json#frag")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("accepts contained relative paths", () => {
    expect(traceFixtureUrl("trace/valid.json").pathname).toContain(
      "/fixtures/trace/valid.json",
    );
    expect(traceFixtureUrl("adversarial-v1/nested-native-trace-key/document.json").pathname).toContain(
      "/fixtures/adversarial-v1/nested-native-trace-key/document.json",
    );
  });

  test("rejects http and https scheme prefixes", () => {
    expect(() => traceFixtureUrl("https://example.com/outside")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
    expect(() => traceFixtureUrl("HTTP://example.com/outside")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects file and data schemes", () => {
    expect(() => traceFixtureUrl("file:///etc/passwd")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
    expect(() => traceFixtureUrl("data:text/plain,hello")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects scheme-relative and backslash authority paths", () => {
    expect(() => traceFixtureUrl("//host/outside")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
    expect(() => traceFixtureUrl("\\\\host\\outside")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects drive-style paths", () => {
    expect(() => traceFixtureUrl("C:/Windows/outside")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects encoded scheme revealed by decoding", () => {
    expect(() => traceFixtureUrl("https%3a//example.com/outside")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });

  test("rejects nul and control characters", () => {
    expect(() => traceFixtureUrl("trace/valid\u0000.json")).toThrow(
      "trace fixture paths must stay inside fixtures/",
    );
  });
});
