import { describe, expect, test } from "vitest";

import type { RuntimeCapability } from "./capability.js";
import { resolveRuntimeConfig } from "./config.js";
import { PluginRuntimeError } from "./errors.js";
import { createLineLogger } from "./logger.js";
import { createPluginRuntime } from "./runtime.js";
import { RUNTIME_VERSION } from "./version.js";

const config = resolveRuntimeConfig({ env: {}, homeDirectory: "/srv/home" });

const recorder = () => {
  const events: string[] = [];
  const capability = (name: string, overrides: Partial<RuntimeCapability> = {}): RuntimeCapability => ({
    name,
    start: async () => {
      events.push(`start:${name}`);
    },
    stop: async () => {
      events.push(`stop:${name}`);
    },
    ...overrides,
  });
  return { events, capability };
};

describe("createPluginRuntime", () => {
  test("starts with no capabilities and reports a healthy, empty report", async () => {
    const runtime = createPluginRuntime({ config });
    await runtime.start();
    await expect(runtime.health()).resolves.toEqual({
      ok: true,
      version: RUNTIME_VERSION,
      checks: [],
    });
    await runtime.stop();
  });

  test("starts capabilities in order and stops them in reverse", async () => {
    const { events, capability } = recorder();
    const runtime = createPluginRuntime({
      config,
      capabilities: [capability("first"), capability("second")],
    });
    await runtime.start();
    await runtime.stop();
    expect(events).toEqual(["start:first", "start:second", "stop:second", "stop:first"]);
  });

  test("passes the config and a logger to each capability", async () => {
    let seen: { home?: string } = {};
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        {
          name: "probe",
          start: async (context) => {
            seen = { home: context.config.homeDirectory };
            context.log.info("probing");
          },
        },
      ],
    });
    await runtime.start();
    await runtime.stop();
    expect(seen.home).toBe("/srv/home");
  });

  test("a capability without hooks is accepted", async () => {
    const runtime = createPluginRuntime({ config, capabilities: [{ name: "inert" }] });
    await runtime.start();
    await expect(runtime.health()).resolves.toMatchObject({ ok: true, checks: [] });
    await runtime.stop();
  });

  test("rejects duplicate capability names before starting anything", async () => {
    const { events, capability } = recorder();
    const runtime = createPluginRuntime({
      config,
      capabilities: [capability("same"), capability("same")],
    });
    await expect(runtime.start()).rejects.toThrow(/duplicate capability/);
    expect(events).toEqual([]);
  });

  test("a failing start unwinds the capabilities that already started", async () => {
    const { events, capability } = recorder();
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        capability("good"),
        capability("bad", {
          start: async () => {
            events.push("start:bad");
            throw new Error("boom");
          },
        }),
        capability("never"),
      ],
    });
    await expect(runtime.start()).rejects.toMatchObject({ code: "capability-start-failed" });
    expect(events).toEqual(["start:good", "start:bad", "stop:good"]);
  });

  test("a failing start names the capability and preserves the cause", async () => {
    const cause = new Error("boom");
    const runtime = createPluginRuntime({
      config,
      capabilities: [{ name: "bad", start: async () => { throw cause; } }],
    });
    await expect(runtime.start()).rejects.toMatchObject({
      message: expect.stringContaining("bad"),
      cause,
    });
  });

  test("starting twice is an error", async () => {
    const runtime = createPluginRuntime({ config });
    await runtime.start();
    await expect(runtime.start()).rejects.toMatchObject({ code: "runtime-already-started" });
    await runtime.stop();
  });

  test("health before start is an error", async () => {
    const runtime = createPluginRuntime({ config });
    await expect(runtime.health()).rejects.toMatchObject({ code: "runtime-not-started" });
  });

  test("stop before start is a no-op, and stop is idempotent", async () => {
    const { events, capability } = recorder();
    const runtime = createPluginRuntime({ config, capabilities: [capability("one")] });
    await runtime.stop();
    expect(events).toEqual([]);
    await runtime.start();
    await runtime.stop();
    await runtime.stop();
    expect(events).toEqual(["start:one", "stop:one"]);
  });

  test("stop attempts every capability even when one throws, then reports the failure", async () => {
    const { events, capability } = recorder();
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        capability("first"),
        capability("bad", {
          stop: async () => {
            events.push("stop:bad");
            throw new Error("stuck");
          },
        }),
        capability("last"),
      ],
    });
    await runtime.start();
    await expect(runtime.stop()).rejects.toMatchObject({ code: "capability-stop-failed" });
    expect(events).toEqual([
      "start:first",
      "start:bad",
      "start:last",
      "stop:last",
      "stop:bad",
      "stop:first",
    ]);
  });

  test("hostile thrown values at start are normalized without running coercion hooks", async () => {
    const hostile = {
      toString() {
        throw new Error("toString ran");
      },
    };
    const runtime = createPluginRuntime({
      config,
      capabilities: [{ name: "bad", start: async () => { throw hostile; } }],
    });
    await expect(runtime.start()).rejects.toMatchObject({
      code: "capability-start-failed",
      message: expect.stringContaining("an unknown error occurred"),
    });
  });

  test("logger failure during stop cleanup still attempts every capability stop", async () => {
    const events: string[] = [];
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        {
          name: "first",
          start: async () => { events.push("start:first"); },
          stop: async () => {
            events.push("stop:first");
            throw new Error("first stuck");
          },
        },
        {
          name: "second",
          start: async () => { events.push("start:second"); },
          stop: async () => { events.push("stop:second"); },
        },
      ],
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {
          throw new Error("logger failed");
        },
      },
    });
    await runtime.start();
    await expect(runtime.stop()).rejects.toMatchObject({ code: "capability-stop-failed" });
    expect(events).toEqual(["start:first", "start:second", "stop:second", "stop:first"]);
  });

  test("health folds every capability's checks in registration order", async () => {
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        {
          name: "archive",
          healthChecks: async () => [
            { name: "archive-writable", ok: true, detail: "writable", remedy: null },
          ],
        },
        {
          name: "mirror",
          healthChecks: async () => [
            { name: "mirror-fresh", ok: false, detail: "never synced", remedy: "run sync" },
          ],
        },
      ],
    });
    await runtime.start();
    const report = await runtime.health();
    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.name)).toEqual([
      "archive-writable",
      "mirror-fresh",
    ]);
    await runtime.stop();
  });

  test("hostile capability health payloads raise health-invalid", async () => {
    const runtime = createPluginRuntime({
      config,
      capabilities: [{
        name: "hostile",
        healthChecks: async () => [{ name: "a", ok: "false" as unknown as boolean, detail: "x", remedy: null }],
      }],
    });
    await runtime.start();
    await expect(runtime.health()).rejects.toMatchObject({ code: "health-invalid" });
    await runtime.stop();
  });

  test("a capability whose health check throws yields a failing check, not a thrown report", async () => {
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        { name: "flaky", healthChecks: async () => { throw new Error("unavailable"); } },
      ],
    });
    await runtime.start();
    const report = await runtime.health();
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([
      {
        name: "flaky",
        ok: false,
        detail: "the capability could not report its health: unavailable",
        remedy: null,
      },
    ]);
    await runtime.stop();
  });

  test("lifecycle transitions are logged at debug level", async () => {
    const lines: string[] = [];
    const runtime = createPluginRuntime({
      config,
      log: createLineLogger("debug", (line) => lines.push(line)),
    });
    await runtime.start();
    await runtime.stop();
    const messages = lines.map((line) => JSON.parse(line).message);
    expect(messages).toContain("runtime started");
    expect(messages).toContain("runtime stopped");
  });

  test("errors raised by the runtime are PluginRuntimeError", async () => {
    const runtime = createPluginRuntime({ config });
    await expect(runtime.health()).rejects.toBeInstanceOf(PluginRuntimeError);
    await expect(runtime.start()).resolves.toBeUndefined();
    await expect(runtime.start()).rejects.toBeInstanceOf(PluginRuntimeError);
    await runtime.stop();
  });

  test("concurrent starts invoke capability start exactly once", async () => {
    let startCount = 0;
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const runtime = createPluginRuntime({
      config,
      capabilities: [{
        name: "slow",
        start: async () => {
          startCount += 1;
          await gate;
        },
      }],
    });
    const first = runtime.start();
    await Promise.resolve();
    await expect(runtime.start()).rejects.toMatchObject({ code: "runtime-busy" });
    releaseStart();
    await first;
    expect(startCount).toBe(1);
    await runtime.stop();
  });

  test("throwing startup logger rolls back so retry succeeds", async () => {
    let debugAttempts = 0;
    const runtime = createPluginRuntime({
      config,
      capabilities: [{ name: "one", start: async () => {} }],
      log: {
        debug: () => {
          debugAttempts += 1;
          if (debugAttempts === 1) throw new Error("logger failed");
        },
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    await expect(runtime.start()).rejects.toMatchObject({ code: "capability-start-failed" });
    await runtime.start();
    await runtime.stop();
  });

  test("start failure aggregates rollback stop failures", async () => {
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        {
          name: "first",
          start: async () => {},
          stop: async () => { throw new Error("stop-one"); },
        },
        {
          name: "second",
          start: async () => { throw new Error("start-two"); },
        },
      ],
    });
    await expect(runtime.start()).rejects.toMatchObject({
      code: "capability-start-failed",
      message: expect.stringMatching(/start-two.*rollback failures.*stop-one/s),
    });
  });

  test("stop during start reports runtime-busy", async () => {
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const runtime = createPluginRuntime({
      config,
      capabilities: [{
        name: "slow",
        start: async () => { await gate; },
      }],
    });
    const starting = runtime.start();
    await Promise.resolve();
    await expect(runtime.stop()).rejects.toMatchObject({ code: "runtime-busy" });
    releaseStart();
    await starting;
    await runtime.stop();
  });
});
