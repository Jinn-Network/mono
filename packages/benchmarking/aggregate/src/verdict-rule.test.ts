import { describe, expect, test } from "vitest";
import { reduceValidVerdicts } from "./verdict-rule.js";
import type { VerdictOutcome } from "./method.js";

const pass: VerdictOutcome = { verdict: "pass" };
const fail: VerdictOutcome = { verdict: "fail" };

describe("reduceValidVerdicts (design §9.2)", () => {
  test("sole: exactly one valid verdict resolves to its value", () => {
    expect(reduceValidVerdicts([pass], "sole")).toEqual({ value: "pass" });
    expect(reduceValidVerdicts([fail], "sole")).toEqual({ value: "fail" });
  });

  test("sole: more than one valid verdict is conflicted", () => {
    expect(reduceValidVerdicts([pass, pass], "sole")).toEqual({ conflicted: true });
  });

  test("sole: zero valid verdicts is conflicted", () => {
    expect(reduceValidVerdicts([], "sole")).toEqual({ conflicted: true });
  });

  test("unanimous (default): all verdicts agree", () => {
    expect(reduceValidVerdicts([pass, pass, pass], "unanimous")).toEqual({ value: "pass" });
    expect(reduceValidVerdicts([fail, fail], "unanimous")).toEqual({ value: "fail" });
    expect(reduceValidVerdicts([pass], "unanimous")).toEqual({ value: "pass" });
  });

  test("unanimous: disagreement is conflicted", () => {
    expect(reduceValidVerdicts([pass, fail], "unanimous")).toEqual({ conflicted: true });
  });

  test("any-pass: a single pass among any number of fails resolves to pass", () => {
    expect(reduceValidVerdicts([fail, fail, pass], "any-pass")).toEqual({ value: "pass" });
  });

  test("any-pass: all fail resolves to fail", () => {
    expect(reduceValidVerdicts([fail, fail], "any-pass")).toEqual({ value: "fail" });
  });

  test("any-pass: zero valid verdicts is conflicted", () => {
    expect(reduceValidVerdicts([], "any-pass")).toEqual({ conflicted: true });
  });

  test("majority: strict majority decides", () => {
    expect(reduceValidVerdicts([pass, pass, fail], "majority")).toEqual({ value: "pass" });
    expect(reduceValidVerdicts([pass, fail, fail], "majority")).toEqual({ value: "fail" });
  });

  test("majority: an exact tie is conflicted", () => {
    expect(reduceValidVerdicts([pass, fail], "majority")).toEqual({ conflicted: true });
  });

  test("majority: zero valid verdicts is conflicted", () => {
    expect(reduceValidVerdicts([], "majority")).toEqual({ conflicted: true });
  });

  test("an inconclusive-valued verdict never silently becomes pass or fail", () => {
    const inconclusive: VerdictOutcome = { verdict: "inconclusive", inconclusiveClass: "flaky" };
    expect(reduceValidVerdicts([inconclusive], "sole")).toEqual({ conflicted: true });
    expect(reduceValidVerdicts([pass, inconclusive], "unanimous")).toEqual({ conflicted: true });
    expect(reduceValidVerdicts([pass, pass, inconclusive], "majority")).toEqual({ conflicted: true });
  });
});
