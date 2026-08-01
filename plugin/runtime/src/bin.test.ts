import { describe, expect, test } from "vitest";

import { main, buildOwnedEnvSnapshot } from "./bin.js";
import { RUNTIME_VERSION } from "./version.js";

const io = (untilShutdown: () => Promise<void> = async () => {}) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    value: {
      writeOut: (line: string) => out.push(line),
      writeErr: (line: string) => err.push(line),
      homeDirectory: "/srv/default-home",
      untilShutdown,
    },
  };
};

describe("main", () => {
  test("health prints one JSON report line to stdout and exits zero", async () => {
    const { out, err, value } = io();
    await expect(main(["health"], {}, value)).resolves.toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ ok: true, version: RUNTIME_VERSION, checks: [] });
    expect(err.some((line) => JSON.parse(line).level === "error")).toBe(false);
  });

  test("serve waits for shutdown, then stops and exits zero", async () => {
    let released = () => {};
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const { err, value } = io(() => gate);
    const exit = main(["serve"], { JINN_PLUGIN_LOG_LEVEL: "debug" }, value);
    released();
    await expect(exit).resolves.toBe(0);
    const messages = err.map((line) => JSON.parse(line).message);
    expect(messages).toContain("runtime started");
    expect(messages).toContain("runtime stopped");
  });

  test("serve is the default command", async () => {
    const { value } = io();
    await expect(main([], {}, value)).resolves.toBe(0);
  });

  test("serve writes nothing to stdout — it is reserved for the MCP transport", async () => {
    const { out, value } = io();
    await main(["serve"], { JINN_PLUGIN_LOG_LEVEL: "debug" }, value);
    expect(out).toEqual([]);
  });

  test("the injected home directory is the default and the environment overrides it", async () => {
    const withDefault = io();
    await main(["health"], {}, withDefault.value);
    const overridden = io();
    await main(["health"], { JINN_PLUGIN_HOME: "/srv/from-env" }, overridden.value);
    const detail = (lines: string[]) =>
      lines.map((line) => JSON.parse(line)).find((entry) => entry.message === "configuration resolved")?.home;
    expect(detail(withDefault.err)).toBe("/srv/default-home");
    expect(detail(overridden.err)).toBe("/srv/from-env");
  });

  test("an unknown command prints usage to stderr and exits two", async () => {
    const { out, err, value } = io();
    await expect(main(["distill"], {}, value)).resolves.toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("usage: jinn-plugin-runtime");
  });

  test("invalid configuration exits two with the error on stderr", async () => {
    const { out, err, value } = io();
    await expect(main(["health"], { JINN_PLUGIN_LOG_LEVEL: "chatty" }, value)).resolves.toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("logLevel");
  });

  test("--help prints usage to stderr and exits zero", async () => {
    const { err, value } = io();
    await expect(main(["--help"], {}, value)).resolves.toBe(0);
    expect(err.join("\n")).toContain("usage: jinn-plugin-runtime");
  });

  test("--version prints the version to stdout and exits zero", async () => {
    const { out, value } = io();
    await expect(main(["--version"], {}, value)).resolves.toBe(0);
    expect(out).toEqual([RUNTIME_VERSION]);
  });

  test("R-C3-59 buildOwnedEnvSnapshot exposes only config keys and isolates mutation", () => {
    const raw = { JINN_PLUGIN_HOME: "/a", JINN_PLUGIN_LOG_LEVEL: "info", PATH: "/usr/bin", extra: "x" };
    const snapshot = buildOwnedEnvSnapshot(raw);
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.keys(snapshot).sort()).toEqual(["JINN_PLUGIN_HOME", "JINN_PLUGIN_LOG_LEVEL"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as Record<string, string>).JINN_PLUGIN_HOME = "/mutated";
    }).toThrow();
    expect(raw.JINN_PLUGIN_HOME).toBe("/a");
  });
});
