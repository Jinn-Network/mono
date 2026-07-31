import { describe, expect, test } from "vitest";

import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import { createLineLogger, type LogLevel } from "./logger.js";

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
      "capability-configuration-invalid",
      "capability-start-failed",
      "capability-stop-failed",
      "config-invalid",
      "health-invalid",
      "log-invalid",
      "runtime-already-started",
      "runtime-busy",
      "runtime-cleanup-required",
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
  test("rejects invalid log levels at construction", () => {
    const { lines, write } = collect();
    expect(() => createLineLogger("verbose" as LogLevel, write)).toThrow(PluginRuntimeError);
    expect(() => createLineLogger("" as LogLevel, write)).toThrow(PluginRuntimeError);
    expect(() => createLineLogger(new String("debug") as unknown as LogLevel, write)).toThrow(PluginRuntimeError);
    expect(lines).toEqual([]);
  });

  test("rejects dangerous object keys instead of silently dropping them", () => {
    const { lines, write } = collect();
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => createLineLogger("debug", write).debug("bad", { [key]: "x" })).toThrow(PluginRuntimeError);
    }
    expect(lines).toEqual([]);
  });

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

  test("rejects cyclic field graphs", () => {
    const { lines, write } = collect();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => createLineLogger("debug", write).debug("cyclic", { cyclic }))
      .toThrow(PluginRuntimeError);
    try {
      createLineLogger("debug", write).debug("cyclic", { cyclic });
    } catch (error) {
      expect(error).toMatchObject({ code: RUNTIME_ERROR_CODES.logInvalid });
    }
    expect(lines).toEqual([]);
  });

  test("rejects reserved toJSON fields", () => {
    const { lines, write } = collect();
    expect(() => createLineLogger("debug", write).debug("bad", {
      toJSON() {
        return { level: "error", message: "hijacked" };
      },
    })).toThrow(PluginRuntimeError);
    expect(lines).toEqual([]);
  });

  test("rejects getter-backed fields", () => {
    const { lines, write } = collect();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "probe", {
      enumerable: true,
      get: () => "leak",
    });
    expect(() => createLineLogger("debug", write).debug("bad", hostile)).toThrow(PluginRuntimeError);
    expect(lines).toEqual([]);
  });

  test("rejects proxy field objects", () => {
    const { lines, write } = collect();
    const hostile = new Proxy({ safe: "ok" }, {
      get(target, key) {
        return Reflect.get(target, key);
      },
    });
    expect(() => createLineLogger("debug", write).debug("bad", hostile)).toThrow(PluginRuntimeError);
    expect(lines).toEqual([]);
  });

  test("does not invoke nested toJSON hooks", () => {
    const { lines, write } = collect();
    let invoked = false;
    expect(() => createLineLogger("debug", write).debug("bad", {
      nested: {
        toJSON() {
          invoked = true;
          return { stolen: true };
        },
      },
    })).toThrow(PluginRuntimeError);
    expect(invoked).toBe(false);
    expect(lines).toEqual([]);
  });

  test("normalized output survives source mutation after logging", () => {
    const { lines, write } = collect();
    const fields = { count: 1 };
    createLineLogger("debug", write).debug("stable", fields);
    fields.count = 99;
    expect(JSON.parse(lines[0]!).count).toBe(1);
  });

  test("accepts valid nested data", () => {
    const { lines, write } = collect();
    createLineLogger("debug", write).debug("nested", { meta: { tier: 4, enabled: true } });
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "debug",
      message: "nested",
      meta: { tier: 4, enabled: true },
    });
  });

  test("rejects proxy arrays without running index getters", () => {
    const { lines, write } = collect();
    let getterRuns = 0;
    const hostile = new Proxy([1], {
      get(target, key) {
        if (key === "0") getterRuns += 1;
        return Reflect.get(target, key);
      },
    });
    expect(() => createLineLogger("debug", write).debug("bad", { hostile })).toThrow(PluginRuntimeError);
    expect(getterRuns).toBe(0);
    expect(lines).toEqual([]);
  });

  test("rejects sparse and augmented arrays", () => {
    const { lines, write } = collect();
    const sparse = [1, , 3];
    expect(() => createLineLogger("debug", write).debug("sparse", { sparse })).toThrow(PluginRuntimeError);
    const augmented = [1];
    (augmented as unknown as Record<string, unknown>).extra = 2;
    expect(() => createLineLogger("debug", write).debug("augmented", { augmented })).toThrow(PluginRuntimeError);
    expect(lines).toEqual([]);
  });

  test("allows shared DAG objects as duplicated values", () => {
    const { lines, write } = collect();
    const shared = { tier: 4 };
    createLineLogger("debug", write).debug("dag", { left: shared, right: shared });
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "debug",
      message: "dag",
      left: { tier: 4 },
      right: { tier: 4 },
    });
  });

  test("rejects mutual object-array cycles", () => {
    const { lines, write } = collect();
    const objectCycle: Record<string, unknown> = {};
    const arrayCycle: unknown[] = [];
    objectCycle.child = arrayCycle;
    arrayCycle.push(objectCycle);
    expect(() => createLineLogger("debug", write).debug("cycle", { objectCycle })).toThrow(PluginRuntimeError);
    expect(lines).toEqual([]);
  });

  test("rejects non-primitive message values", () => {
    const { lines, write } = collect();
    expect(() => createLineLogger("debug", write).debug(new String("bad") as unknown as string)).toThrow(PluginRuntimeError);
    expect(lines).toEqual([]);
  });

  test("rejects message hooks without invoking them", () => {
    const { lines, write } = collect();
    const hostile = {
      toString() {
        throw new Error("toString ran");
      },
      valueOf() {
        throw new Error("valueOf ran");
      },
      [Symbol.toPrimitive]() {
        throw new Error("primitive ran");
      },
    };
    expect(() => createLineLogger("debug", write).debug(hostile as unknown as string)).toThrow(PluginRuntimeError);
    expect(lines).toEqual([]);
  });

  test("rejects prototype-backed array fields without index lookup", () => {
    const { lines, write } = collect();
    let getterRuns = 0;
    const hostile = [1];
    Object.defineProperty(hostile, 0, {
      enumerable: true,
      get() {
        getterRuns += 1;
        return 1;
      },
    });
    expect(() => createLineLogger("debug", write).debug("bad", { hostile })).toThrow(PluginRuntimeError);
    expect(getterRuns).toBe(0);
    expect(lines).toEqual([]);
  });

  test("R-C3-49 preserves nested level and message fields exactly", () => {
    const { lines, write } = collect();
    createLineLogger("debug", write).debug("outer", {
      nested: { level: "inner-level", message: "inner-message" },
    });
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "debug",
      message: "outer",
      nested: { level: "inner-level", message: "inner-message" },
    });
  });

  test("R-C3-49 rejects symbol and non-enumerable field keys", () => {
    const { lines, write } = collect();
    const withSymbol: Record<string | symbol, unknown> = { safe: "ok" };
    withSymbol[Symbol("hidden")] = "nope";
    expect(() => createLineLogger("debug", write).debug("bad", withSymbol)).toThrow(PluginRuntimeError);
    const withHidden: Record<string, unknown> = { safe: "ok" };
    Object.defineProperty(withHidden, "hidden", { enumerable: false, value: "nope" });
    expect(() => createLineLogger("debug", write).debug("bad", withHidden)).toThrow(PluginRuntimeError);
    expect(lines).toEqual([]);
  });

  test("R-C3-49 rejects revoked proxy field objects", () => {
    const { lines, write } = collect();
    const { proxy, revoke } = Proxy.revocable({ safe: "ok" }, {});
    revoke();
    expect(() => createLineLogger("debug", write).debug("bad", { proxy })).toThrow(PluginRuntimeError);
    expect(lines).toEqual([]);
  });

  test("R-C3-55 rejects top-level revoked proxy fields before Array.isArray", () => {
    const { lines, write } = collect();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => createLineLogger("debug", write).debug("bad", proxy as unknown as Record<string, unknown>)).toThrow(
      expect.objectContaining({ code: RUNTIME_ERROR_CODES.logInvalid }),
    );
    expect(lines).toEqual([]);
  });

  test("R-C3-55 rejects deep nesting beyond the depth budget without RangeError", () => {
    const { lines, write } = collect();
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let index = 0; index < 65; index += 1) {
      deep = { nested: deep };
    }
    expect(() => createLineLogger("debug", write).debug("bad", deep)).toThrow(
      expect.objectContaining({ code: RUNTIME_ERROR_CODES.logInvalid }),
    );
    expect(lines).toEqual([]);
  });

  test("R-C3-55 rejects wide objects beyond the node budget", () => {
    const { lines, write } = collect();
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 10_001; index += 1) {
      wide[`k${index}`] = index;
    }
    expect(() => createLineLogger("debug", write).debug("bad", wide)).toThrow(
      expect.objectContaining({ code: RUNTIME_ERROR_CODES.logInvalid }),
    );
    expect(lines).toEqual([]);
  });

  test("R-C3-55 accepts depth and node budgets at the boundary", () => {
    const { lines, write } = collect();
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let index = 0; index < 63; index += 1) {
      deep = { nested: deep };
    }
    createLineLogger("debug", write).debug("deep", deep);
    expect(lines).toHaveLength(1);
  });
});
