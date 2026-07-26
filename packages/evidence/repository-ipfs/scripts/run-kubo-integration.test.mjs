// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

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

function fakeChild(options = {}) {
  const exitOnKill = options.exitOnKill ?? true;
  const child = new EventEmitter();
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
  return child;
}
