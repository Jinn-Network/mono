import { describe, expect, test } from "vitest";

import * as runtime from "./index.js";

describe("public surface", () => {
  test("exports exactly the runtime's public names", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "ENVIRONMENT_KEYS",
      "PluginRuntimeError",
      "RUNTIME_ERROR_CODES",
      "RUNTIME_VERSION",
      "RuntimeConfigFileSchema",
      "createLineLogger",
      "createPluginRuntime",
      "createSilentLogger",
      "resolveRuntimeConfig",
      "summarizeHealth",
    ]);
  });

  test("does not export the binary's entry point", () => {
    expect("main" in runtime).toBe(false);
    expect("BinIo" in runtime).toBe(false);
  });

  test("a consumer can build and run a runtime from the public surface alone", async () => {
    const config = runtime.resolveRuntimeConfig({ env: {}, homeDirectory: "/srv/consumer" });
    const instance = runtime.createPluginRuntime({ config });
    await instance.start();
    await expect(instance.health()).resolves.toEqual({
      ok: true,
      version: runtime.RUNTIME_VERSION,
      checks: [],
    });
    await instance.stop();
  });
});
