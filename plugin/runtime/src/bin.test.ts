import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DsseSigner } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import { main, buildMirrorCapabilities, buildOwnedEnvSnapshot, buildServeCapabilities } from "./bin.js";
import { createNodeRuntimeConfigFileReader } from "./bin-node-fs.js";
import { resolveRuntimeConfig } from "./config.js";
import { createLineLogger } from "./logger.js";
import { createPluginRuntime, type PluginRuntime } from "./runtime.js";
import { resolveCorpusBinIoFields } from "./session-host-corpus.js";
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

  test("mirror runs until shutdown, then stops and exits zero", async () => {
    let released = () => {};
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const home = await mkdtemp(join(tmpdir(), "jinn-bin-mirror-"));
    const err: string[] = [];
    const exit = main(["mirror"], {}, {
      writeOut: () => {},
      writeErr: (line) => err.push(line),
      homeDirectory: home,
      untilShutdown: () => gate,
      ...resolveCorpusBinIoFields({ env: {}, homeDirectory: home }),
    });
    released();
    await expect(exit).resolves.toBe(0);
    expect(err.join("\n")).toContain("corpus.mirror.cycle");
  });

  test("mirror without the corpus ports fails loudly rather than syncing nothing", async () => {
    const home = await writableHome();
    const { err, value } = io(async () => {}, { homeDirectory: home });
    const code = await main(["mirror"], {}, value);
    expect(code).not.toBe(0);
    expect(err.join("\n")).toContain("corpus ports");
  });

  test("--help lists mirror", async () => {
    const { err, value } = io();
    await expect(main(["--help"], {}, value)).resolves.toBe(0);
    expect(err.join("\n")).toContain("mirror");
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

describe("the composed corpus ports", () => {
  test("main serve accepts them and reports the corpus capability started", async () => {
    const home = await mkdtemp(join(tmpdir(), "jinn-bin-corpus-"));
    const err: string[] = [];
    const code = await main(["serve"], {}, {
      writeOut: () => {},
      writeErr: (line) => err.push(line),
      homeDirectory: home,
      untilShutdown: async () => {},
      ...resolveCorpusBinIoFields({ env: {}, homeDirectory: home }),
    });
    expect(code).toBe(0);
    // Without the ports this line never appeared: `hasCorpusPorts` was false
    // for every in-repo entry point, so the capability was never constructed.
    expect(err.join("\n")).toContain("corpus.capability.started");
    expect(err.join("\n")).not.toContain("corpus ports not injected");
  });

  test("the mirror command composes the corpus capability and the sync loop, and no MCP surface", async () => {
    const home = await mkdtemp(join(tmpdir(), "jinn-bin-mirror-compose-"));
    const binIo = {
      writeOut: () => {},
      writeErr: () => {},
      homeDirectory: home,
      untilShutdown: async () => {},
      ...resolveCorpusBinIoFields({ env: {}, homeDirectory: home }),
    };
    expect(buildMirrorCapabilities(binIo).map((capability) => capability.name)).toEqual([
      "corpus",
      "corpus-sync",
    ]);
  });

  test("a default install with no config file is aggregate-healthy", async () => {
    // The serve path never renders a report — the composed `runtimeHealth`
    // closure is what the MCP `health` tool returns — so this composes the
    // capability set exactly as `main` does and reads the report directly.
    // Constructing the corpus capability on every real launch (which the
    // injected ports now do) must not make that report permanently red: a
    // default install writes no configuration file, so the reader below yields
    // `undefined`, `corpus.trust` is `undefined`, and its remedy would name
    // keys nothing has declared.
    const home = await mkdtemp(join(tmpdir(), "jinn-bin-corpus-health-"));
    const readConfigFile = createNodeRuntimeConfigFileReader(home);
    const binIo = {
      writeOut: () => {},
      writeErr: () => {},
      homeDirectory: home,
      untilShutdown: async () => {},
      readConfigFile,
      ...resolveCorpusBinIoFields({ env: {}, homeDirectory: home, readConfigFile }),
    };
    let runtime: PluginRuntime;
    runtime = createPluginRuntime({
      config: resolveRuntimeConfig({ env: {}, homeDirectory: home, file: readConfigFile() }),
      log: createLineLogger("info", () => {}),
      capabilities: buildServeCapabilities("tools", binIo, () => runtime.health()),
    });
    await runtime.start();
    const report = await runtime.health();
    await runtime.stop();

    expect(report.checks.find((check) => check.name === "corpus-trust-policy")).toMatchObject({
      ok: true,
      remedy: null,
    });
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("the runtime configuration file", () => {
  /** The `main` invocation every test below shares, minus the document under test. */
  async function serveWithConfigFile(home: string): Promise<{ code: number; err: string }> {
    const err: string[] = [];
    const code = await main(["serve"], {}, {
      writeOut: () => {},
      writeErr: (line) => err.push(line),
      homeDirectory: home,
      untilShutdown: async () => {},
      readConfigFile: createNodeRuntimeConfigFileReader(home),
    });
    return { code, err: err.join("\n") };
  }

  test("an absent file reads as no document at all, not as a failure", async () => {
    // A default install has none, and the defaults are the whole configuration.
    expect(createNodeRuntimeConfigFileReader(await writableHome())()).toBeUndefined();
  });

  test("a present file reaches main, and its home key relocates the tree", async () => {
    // Also pins the precedence: the document is read from the PRE-resolution
    // home, so a `home` key inside it moves the data tree and not the file.
    const home = await writableHome();
    const relocated = await writableHome();
    await writeFile(join(home, "config.json"), JSON.stringify({ home: relocated }));
    const { code, err } = await serveWithConfigFile(home);
    expect(code).toBe(0);
    expect(err).toContain(relocated);
  });

  test("a malformed file fails loud instead of resolving an empty configuration", async () => {
    // Swallowing this would follow no archives while the operator who wrote
    // the corpus block believes their sources are live.
    const home = await writableHome();
    await writeFile(join(home, "config.json"), "{ not json");
    const { code, err } = await serveWithConfigFile(home);
    expect(code).toBe(2);
    expect(err).toContain("configuration failed");
    expect(err).toContain("is not valid JSON");
  });

  test("a schema-invalid corpus block still reaches the operator", async () => {
    const home = await writableHome();
    await writeFile(join(home, "config.json"), JSON.stringify({ corpus: { sources: [{ agent: "a" }] } }));
    const { code, err } = await serveWithConfigFile(home);
    expect(code).toBe(2);
    expect(err).toContain("corpus configuration is invalid");
  });
});
