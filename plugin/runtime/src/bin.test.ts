import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DsseSigner } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import { main, buildOwnedEnvSnapshot } from "./bin.js";
import { RUNTIME_VERSION } from "./version.js";

const testSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3]), keyid: "test-key" },
];

const io = (
  untilShutdown: () => Promise<void> = async () => {},
  options: { homeDirectory?: string; captureSigner?: DsseSigner } = {},
) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    value: {
      writeOut: (line: string) => out.push(line),
      writeErr: (line: string) => err.push(line),
      homeDirectory: options.homeDirectory ?? "/srv/default-home",
      untilShutdown,
      ...(options.captureSigner === undefined ? {} : { captureSigner: options.captureSigner }),
    },
  };
};

async function writableHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jinn-bin-"));
}

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
    const home = await writableHome();
    const { err, value } = io(() => gate, { homeDirectory: home });
    const exit = main(["serve", "--role", "tools"], { JINN_PLUGIN_LOG_LEVEL: "debug" }, value);
    released();
    await expect(exit).resolves.toBe(0);
    const messages = err.map((line) => JSON.parse(line).message);
    expect(messages).toContain("runtime started");
    expect(messages).toContain("runtime stopped");
  });

  test("serve is the default command", async () => {
    const home = await writableHome();
    const { value } = io(async () => {}, { homeDirectory: home, captureSigner: testSigner });
    await expect(main(["serve"], {}, value)).resolves.toBe(0);
  });

  test("serve writes nothing to stdout — it is reserved for the MCP transport", async () => {
    const home = await writableHome();
    const { out, value } = io(async () => {}, { homeDirectory: home });
    await main(["serve", "--role", "tools"], { JINN_PLUGIN_LOG_LEVEL: "debug" }, value);
    expect(out).toEqual([]);
  });

  test("serve defaults to the tools role even when captureSigner is injected", async () => {
    const home = await writableHome();
    const { err, value } = io(async () => {}, { homeDirectory: home, captureSigner: testSigner });
    const code = await main(["serve"], {}, value);
    expect(code).toBe(0);
    expect(err.join("")).toContain("role=tools");
    expect(err.map((line) => JSON.parse(line).message)).toContain("mcp server listening (role=tools)");
  });

  test("bare serve without --role or captureSigner succeeds as tools", async () => {
    const home = await writableHome();
    const { err, value } = io(async () => {}, { homeDirectory: home });
    const code = await main(["serve"], {}, value);
    expect(code).toBe(0);
    expect(err.join("")).toContain("role=tools");
  });

  test("serve --role tools starts the read-only surface", async () => {
    const home = await writableHome();
    const { err, value } = io(async () => {}, { homeDirectory: home });
    const code = await main(["serve", "--role", "tools"], {}, value);
    expect(code).toBe(0);
    expect(err.join("")).toContain("role=tools");
  });

  test("serve --role session without captureSigner fails with config-invalid", async () => {
    const home = await writableHome();
    const { err, value } = io(async () => {}, { homeDirectory: home });
    const code = await main(["serve", "--role", "session"], {}, value);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("F-C4-T13-2");
    expect(err.join("\n")).toContain("captureSigner");
  });

  test("an unknown role fails loudly with config-invalid", async () => {
    const home = await writableHome();
    const { err, value } = io(async () => {}, { homeDirectory: home });
    const code = await main(["serve", "--role", "admin"], {}, value);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--role must be one of");
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
    expect(err.join("\n")).toContain("--role");
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
