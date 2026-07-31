import { describe, expect, test } from "vitest";

import { PluginRuntimeError } from "./errors.js";
import { resolveRuntimeConfig } from "./config.js";

const HOME = "/srv/hermes-home/.jinn-plugin";

const base = { env: {}, homeDirectory: HOME } as const;

describe("resolveRuntimeConfig", () => {
  test("derives every path from the home directory", () => {
    expect(resolveRuntimeConfig(base)).toEqual({
      homeDirectory: HOME,
      archiveDirectory: `${HOME}/archive`,
      captureDirectory: `${HOME}/capture`,
      captureRetentionDays: 30,
      captureArchiveBusyTimeoutMs: 10_000,
      catalogPath: `${HOME}/catalog.sqlite`,
      indexPath: `${HOME}/index.sqlite`,
      mirrorStatePath: `${HOME}/mirror-state.json`,
      logLevel: "info",
      mirrorCatalogPath: `${HOME}/mirror/catalog.sqlite`,
      mirrorObjectsDirectory: `${HOME}/mirror/objects`,
      mirrorLockPath: `${HOME}/mirror-sync.lock`,
      corpus: {
        sources: [],
        maxEntriesPerSync: 500,
        syncTimeoutMs: 30_000,
        acknowledgeUnverifiedChain: false,
      },
    });
  });

  test("normalizes the home directory", () => {
    const config = resolveRuntimeConfig({ ...base, homeDirectory: "/srv/./a/../home/" });
    expect(config.homeDirectory).toBe("/srv/home");
    expect(config.archiveDirectory).toBe("/srv/home/archive");
  });

  test("rejects a relative home directory", () => {
    expect(() => resolveRuntimeConfig({ ...base, homeDirectory: "relative/home" })).toThrow(
      PluginRuntimeError,
    );
  });

  test("the environment overrides the file, which overrides the defaults", () => {
    const fromFile = resolveRuntimeConfig({
      ...base,
      file: { home: "/from/file", logLevel: "debug" },
    });
    expect(fromFile.homeDirectory).toBe("/from/file");
    expect(fromFile.logLevel).toBe("debug");

    const fromEnv = resolveRuntimeConfig({
      env: { JINN_PLUGIN_HOME: "/from/env", JINN_PLUGIN_LOG_LEVEL: "warn" },
      homeDirectory: HOME,
      file: { home: "/from/file", logLevel: "debug" },
    });
    expect(fromEnv.homeDirectory).toBe("/from/env");
    expect(fromEnv.logLevel).toBe("warn");
  });

  test("an empty environment value does not override", () => {
    const config = resolveRuntimeConfig({
      env: { JINN_PLUGIN_HOME: "", JINN_PLUGIN_LOG_LEVEL: "" },
      homeDirectory: HOME,
    });
    expect(config.homeDirectory).toBe(HOME);
    expect(config.logLevel).toBe("info");
  });

  test("rejects an unknown log level with an issue path", () => {
    try {
      resolveRuntimeConfig({ env: { JINN_PLUGIN_LOG_LEVEL: "chatty" }, homeDirectory: HOME });
      throw new Error("expected PluginRuntimeError");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginRuntimeError);
      expect((error as PluginRuntimeError).code).toBe("config-invalid");
      expect((error as PluginRuntimeError).message).toContain("logLevel");
    }
  });

  test("rejects an unknown key in the config file", () => {
    expect(() => resolveRuntimeConfig({ ...base, file: { hoem: "/typo" } })).toThrow(
      PluginRuntimeError,
    );
  });

  test("rejects a non-object config file", () => {
    expect(() => resolveRuntimeConfig({ ...base, file: "not an object" })).toThrow(
      PluginRuntimeError,
    );
  });

  test("an absent config file is not an error", () => {
    expect(resolveRuntimeConfig({ ...base, file: undefined }).logLevel).toBe("info");
  });

  test("the result is frozen so a capability cannot mutate shared configuration", () => {
    expect(Object.isFrozen(resolveRuntimeConfig(base))).toBe(true);
  });

  test("resolution is pure: the same source yields an equal result", () => {
    expect(resolveRuntimeConfig(base)).toEqual(resolveRuntimeConfig({ ...base }));
  });
});
