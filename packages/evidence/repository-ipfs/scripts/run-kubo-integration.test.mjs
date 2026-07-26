// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { describe, test } from "vitest";

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
});

function fakeChild() {
  const child = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}
