import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import { summarizeHealth } from "./health.js";
import { RUNTIME_VERSION } from "./version.js";

const ok = (name: string) => ({ name, ok: true, detail: "ready", remedy: null });

describe("summarizeHealth", () => {
  test("an empty check list is healthy", () => {
    expect(summarizeHealth("0.1.0", [])).toEqual({ ok: true, version: "0.1.0", checks: [] });
  });

  test("every check passing is healthy", () => {
    expect(summarizeHealth("0.1.0", [ok("a"), ok("b")]).ok).toBe(true);
  });

  test("one failing check fails the report", () => {
    const report = summarizeHealth("0.1.0", [
      ok("a"),
      { name: "b", ok: false, detail: "the archive directory is unreadable", remedy: "chmod u+rwx <archive>" },
    ]);
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(2);
  });

  test("a failing check may name a state that is not fixable from this machine", () => {
    const report = summarizeHealth("0.1.0", [
      {
        name: "runtime-pin",
        ok: false,
        detail: "the pinned runtime version is not published — channel issue",
        remedy: null,
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.remedy).toBeNull();
  });

  test("checks keep their given order and the report is frozen", () => {
    const report = summarizeHealth("0.1.0", [ok("z"), ok("a")]);
    expect(report.checks.map((check) => check.name)).toEqual(["z", "a"]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.checks)).toBe(true);
  });

  test("rejects two checks with the same name", () => {
    expect(() => summarizeHealth("0.1.0", [ok("a"), ok("a")])).toThrow(PluginRuntimeError);
    try {
      summarizeHealth("0.1.0", [ok("a"), ok("a")]);
    } catch (error) {
      expect(error).toMatchObject({ code: RUNTIME_ERROR_CODES.healthInvalid });
    }
  });

  test("rejects a check with an empty name", () => {
    expect(() =>
      summarizeHealth("0.1.0", [{ name: "  ", ok: true, detail: "ready", remedy: null }]),
    ).toThrow(PluginRuntimeError);
    try {
      summarizeHealth("0.1.0", [{ name: "  ", ok: true, detail: "ready", remedy: null }]);
    } catch (error) {
      expect(error).toMatchObject({ code: RUNTIME_ERROR_CODES.healthInvalid });
    }
  });

  test("rejects a check with an empty detail", () => {
    expect(() =>
      summarizeHealth("0.1.0", [{ name: "a", ok: false, detail: "", remedy: null }]),
    ).toThrow(PluginRuntimeError);
    try {
      summarizeHealth("0.1.0", [{ name: "a", ok: false, detail: "", remedy: null }]);
    } catch (error) {
      expect(error).toMatchObject({ code: RUNTIME_ERROR_CODES.healthInvalid });
    }
  });
});

describe("RUNTIME_VERSION", () => {
  test("matches the package manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(RUNTIME_VERSION).toBe(manifest.version);
  });
});
