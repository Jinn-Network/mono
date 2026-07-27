// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, test, vi } from "vitest";

import {
  createCommandSupervisor,
  runKuboIntegration,
} from "./run-kubo-integration.mjs";

describe("Kubo integration process cleanup", () => {
  test("terminates the exact active child on interruption", async () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const child = fakeChild();
      const supervisor = createCommandSupervisor(() => child);
      const pending = supervisor.run("fake-command", []);

      supervisor.interrupt(signal);

      await assert.rejects(pending, new RegExp(`interrupted by ${signal}`, "u"));
      assert.deepEqual(child.kills, [signal]);
    }
  });

  test("force-removes only the generated exact container name", async () => {
    const calls = [];
    const supervisor = {
      async cleanup(command, args) {
        calls.push({ args, command, cleanup: true });
      },
      async run(command, args) {
        calls.push({ args, command, cleanup: false });
        if (command === process.execPath) {
          throw new Error("test process interrupted");
        }
      },
    };

    await assert.rejects(
      runKuboIntegration({
        matrices: [
          {
            image: "example.invalid/kubo@sha256:exact",
            tests: ["test/example.integration.test.ts"],
            version: "9.9.9",
          },
        ],
        randomSuffix: () => "fixed",
        supervisor,
        waitForEndpoint: async () => "http://127.0.0.1:5001",
      }),
      /test process interrupted/u,
    );

    const exactName = "jinn-evidence-ipfs-9-9-9-fixed";
    assert.deepEqual(calls.at(-1), {
      args: ["rm", "-f", exactName],
      cleanup: true,
      command: "docker",
    });
    assert.equal(
      calls.some(
        (call) =>
          call.cleanup &&
          (call.args.includes("*") || call.args.includes("--all")),
      ),
      false,
    );
  });

  test("bounds a never-exiting exact-name cleanup child", async () => {
    vi.useFakeTimers();
    try {
      const calls = [];
      const child = fakeChild({ exitOnKill: false });
      const supervisor = createCommandSupervisor((command, args) => {
        calls.push({ args, command });
        return child;
      });
      let settled = false;
      const pending = supervisor.cleanup("docker", [
        "rm",
        "-f",
        "jinn-evidence-ipfs-exact",
      ]);
      void pending.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      assert.deepEqual(child.kills, ["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(1_000);
      assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
      await vi.advanceTimersByTimeAsync(1_000);
      assert.equal(settled, true);
      assert.equal(child.unrefs, 1);
      assert.equal(vi.getTimerCount(), 0);
      assert.deepEqual(calls, [
        {
          args: ["rm", "-f", "jinn-evidence-ipfs-exact"],
          command: "docker",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a repeated signal force-kills the current cleanup child", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild({ exitOnKill: false });
      const supervisor = createCommandSupervisor(() => child);
      supervisor.interrupt("SIGINT");
      const pending = supervisor.cleanup("docker", [
        "rm",
        "-f",
        "jinn-evidence-ipfs-exact",
      ]);

      supervisor.interrupt("SIGTERM");
      assert.deepEqual(child.kills, ["SIGKILL"]);
      await vi.advanceTimersByTimeAsync(3_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Kubo readiness interruption", () => {
  test("interrupts port discovery through the supervised command", async () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      let spawnCount = 0;
      let resolvePortStarted;
      const portStarted = new Promise((resolve) => {
        resolvePortStarted = resolve;
      });
      const supervisor = createCommandSupervisor(() => {
        spawnCount += 1;
        if (spawnCount === 2) {
          resolvePortStarted();
          return fakeChild();
        }
        return fakeChild({ exitCode: 0 });
      });
      const pending = runKuboIntegration({
        matrices: [readinessMatrix()],
        randomSuffix: () => "port",
        supervisor,
      });
      await portStarted;

      supervisor.interrupt(signal);

      await assert.rejects(
        settleWithin(pending, 100),
        new RegExp(`interrupted by ${signal}`, "u"),
      );
    }
  });

  test("interrupts an in-flight readiness fetch without waiting for its timeout", async () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const supervisor = readinessSupervisor();
      let fetchCalls = 0;
      let resolveFetchStarted;
      const fetchStarted = new Promise((resolve) => {
        resolveFetchStarted = resolve;
      });
      vi.stubGlobal("fetch", (_input, init) => {
        fetchCalls += 1;
        if (fetchCalls > 1) return Promise.resolve({ ok: true });
        resolveFetchStarted();
        return new Promise((resolve) => {
          init.signal.addEventListener(
            "abort",
            () => resolve({ ok: false }),
            { once: true },
          );
        });
      });
      const pending = runKuboIntegration({
        matrices: [readinessMatrix()],
        randomSuffix: () => "fetch",
        supervisor,
      });
      await fetchStarted;

      supervisor.interrupt(signal);
      const observed = await captureWithin(pending, 100);
      await pending.catch(() => {});

      vi.unstubAllGlobals();
      assert.match(String(observed), new RegExp(`interrupted by ${signal}`, "u"));
    }
  });

  test("interrupts the readiness retry delay without waiting for the next attempt", async () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const supervisor = readinessSupervisor();
      let fetchCalls = 0;
      let resolveFirstFetch;
      const firstFetch = new Promise((resolve) => {
        resolveFirstFetch = resolve;
      });
      vi.stubGlobal("fetch", () => {
        fetchCalls += 1;
        resolveFirstFetch();
        return Promise.resolve({ ok: fetchCalls > 1 });
      });
      const pending = runKuboIntegration({
        matrices: [readinessMatrix()],
        randomSuffix: () => "retry",
        supervisor,
      });
      await firstFetch;
      await new Promise((resolve) => setImmediate(resolve));

      supervisor.interrupt(signal);
      const observed = await captureWithin(pending, 100);
      await pending.catch(() => {});

      vi.unstubAllGlobals();
      assert.match(String(observed), new RegExp(`interrupted by ${signal}`, "u"));
    }
  });

  test("the CLI performs exact-name cleanup and exits 130/143 after readiness interruption", async () => {
    for (const [signal, expectedCode] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ]) {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "jinn-kubo-runner-signal-"),
      );
      const dockerPath = join(temporaryDirectory, "docker");
      const portMarker = join(temporaryDirectory, "port");
      const cleanupMarker = join(temporaryDirectory, "cleanup");
      const fakeDocker = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const command = process.argv[2];
const directory = process.env.JINN_FAKE_DOCKER_MARKER_DIR;
if (command === "run") {
  process.stdout.write("fake-container\\n");
} else if (command === "port") {
  writeFileSync(require("node:path").join(directory, "port"), "");
  process.stdout.write("127.0.0.1:9\\n");
} else if (command === "rm") {
  writeFileSync(require("node:path").join(directory, "cleanup"), "");
} else {
  process.exitCode = 1;
}
`;
      await writeFile(dockerPath, fakeDocker);
      await chmod(dockerPath, 0o755);
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./run-kubo-integration.mjs", import.meta.url),
          ),
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            ...process.env,
            JINN_FAKE_DOCKER_MARKER_DIR: temporaryDirectory,
            PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      try {
        await waitForFile(portMarker, 1_000);
        child.kill(signal);
        const result = await waitForChildExit(child, 2_000);

        assert.equal(result.signal, null, stderr);
        assert.equal(result.code, expectedCode, stderr);
        await access(cleanupMarker);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    }
  });
});

function fakeChild(options = {}) {
  const exitOnKill = options.exitOnKill ?? true;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.unrefs = 0;
  child.kill = (signal) => {
    child.kills.push(signal);
    if (exitOnKill) {
      queueMicrotask(() => child.emit("exit", null, signal));
    }
    return true;
  };
  child.unref = () => {
    child.unrefs += 1;
  };
  if (Object.hasOwn(options, "exitCode")) {
    queueMicrotask(() => child.emit("exit", options.exitCode));
  }
  return child;
}

function readinessMatrix() {
  return {
    image: "example.invalid/kubo@sha256:exact",
    tests: [],
    version: "9.9.9",
  };
}

function readinessSupervisor() {
  const supervisor = createCommandSupervisor(() => {
    throw new Error("readiness test must not spawn a child");
  });
  supervisor.run = async () => {};
  supervisor.output = async () => "127.0.0.1:45001";
  supervisor.cleanup = async () => {};
  return supervisor;
}

async function captureWithin(promise, timeoutMs) {
  try {
    await settleWithin(promise, timeoutMs);
    return "operation resolved instead of reporting interruption";
  } catch (error) {
    return error;
  }
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("readiness did not stop promptly")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForFile(path, timeoutMs) {
  const startedAt = Date.now();
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for ${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Kubo integration CLI did not exit promptly"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
