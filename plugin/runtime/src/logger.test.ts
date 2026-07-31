import { describe, expect, test } from "vitest";

import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import { createLineLogger } from "./logger.js";

const collect = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
};

describe("PluginRuntimeError", () => {
  test("carries a code and preserves the cause", () => {
    const cause = new Error("underlying");
    const error = new PluginRuntimeError("config-invalid", "bad config", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PluginRuntimeError");
    expect(error.code).toBe("config-invalid");
    expect(error.message).toBe("bad config");
    expect(error.cause).toBe(cause);
  });

  test("the code table is frozen and covers the runtime lifecycle", () => {
    expect(Object.isFrozen(RUNTIME_ERROR_CODES)).toBe(true);
    expect(Object.values(RUNTIME_ERROR_CODES).sort()).toEqual([
      "capability-start-failed",
      "capability-stop-failed",
      "config-invalid",
      "health-invalid",
      "runtime-already-started",
      "runtime-not-started",
    ]);
  });

  test("a component may define its own code without editing the base", () => {
    class MirrorError extends PluginRuntimeError {
      constructor(message: string) {
        super("mirror-sync-locked", message);
        this.name = "MirrorError";
      }
    }
    const error = new MirrorError("held");
    expect(error).toBeInstanceOf(PluginRuntimeError);
    expect(error.code).toBe("mirror-sync-locked");
  });
});

describe("createLineLogger", () => {
  test("writes one JSON line per record", () => {
    const { lines, write } = collect();
    createLineLogger("info", write).info("started", { capabilities: 0 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "info",
      message: "started",
      capabilities: 0,
    });
  });

  test("suppresses records below the configured level", () => {
    const { lines, write } = collect();
    const log = createLineLogger("warn", write);
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(["warn", "error"]);
  });

  test("silent suppresses everything", () => {
    const { lines, write } = collect();
    const log = createLineLogger("silent", write);
    log.error("e");
    expect(lines).toEqual([]);
  });

  test("fields never overwrite level or message", () => {
    const { lines, write } = collect();
    createLineLogger("debug", write).debug("real", { level: "fake", message: "fake" });
    expect(JSON.parse(lines[0]!)).toEqual({ level: "debug", message: "real" });
  });

  test("a field that cannot be serialized does not throw", () => {
    const { lines, write } = collect();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    createLineLogger("debug", write).debug("cyclic", { cyclic });
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "debug",
      message: "cyclic",
      cyclic: "[unserializable]",
    });
  });
});
