import { describe, expect, test } from "vitest";
import { colophonDataDir } from "./data-dir.js";

describe("Colophon machine-data location", () => {
  test("uses an explicit product-owned directory without consulting a harness home", () => {
    expect(colophonDataDir({ COLOPHON_DATA_HOME: "/safe/colophon", HOME: "/ignored/.codex" }, "linux")).toBe("/safe/colophon");
  });

  test("uses platform data conventions", () => {
    expect(colophonDataDir({ XDG_DATA_HOME: "/data" }, "linux")).toBe("/data/Colophon");
    expect(colophonDataDir({ HOME: "/Users/reader" }, "darwin")).toBe("/Users/reader/Library/Application Support/Colophon");
    expect(colophonDataDir({ HOME: "/home/reader" }, "linux")).toBe("/home/reader/.local/share/Colophon");
  });

  test("rejects a relative explicit location", () => {
    expect(() => colophonDataDir({ COLOPHON_DATA_HOME: "relative" }, "linux")).toThrow(/absolute/);
  });
});
