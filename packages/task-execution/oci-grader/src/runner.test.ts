// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePinnedOciImage,
  runPinnedOciGrader,
  type GraderChildProcess,
  type GraderProcessSpawner,
} from "./runner.js";
import type { PinnedOciGraderInput } from "./invocation.js";

const IMAGE = `example.registry/sweb.eval.x86_64.acme__widget-1@sha256:${"b".repeat(64)}`;

class FakeChild extends EventEmitter implements GraderChildProcess {
  killed: NodeJS.Signals | undefined;
  kill(signal: NodeJS.Signals): boolean {
    this.killed = signal;
    // A real child_process only emits "exit" once the OS actually reaps the killed process —
    // asynchronously, after the signal is delivered. boundedExit's promise deliberately waits for
    // that "exit" event rather than resolving the instant kill() is called (see runner.ts), so the
    // fake must mirror that: emit its own "exit" (code null — the real Node convention for a
    // signal-terminated process) rather than resolving synchronously inside kill().
    queueMicrotask(() => this.emit("exit", null));
    return true;
  }
  exit(code: number | null): void {
    queueMicrotask(() => this.emit("exit", code));
  }
  fail(error: Error): void {
    queueMicrotask(() => this.emit("error", error));
  }
}

/**
 * Flushes the microtask queue completely. `boundedExit` chains a promise executor through
 * `.catch()` and an `async function` return, which costs several microtask turns per hop — more
 * than a single `await Promise.resolve()` drains. A macrotask boundary (`setImmediate`) only runs
 * after every pending microtask has settled, so it is a turn-count-independent way to wait until a
 * chained `boundedExit` call has reached its next `child.on(...)` registration.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function recordingSpawner(children: FakeChild[]): {
  spawn: GraderProcessSpawner;
  calls: { command: string; args: readonly string[] }[];
} {
  const calls: { command: string; args: readonly string[] }[] = [];
  let index = 0;
  return {
    calls,
    spawn: (command, args) => {
      calls.push({ command, args });
      const child = children[index++];
      if (child === undefined) throw new Error("spawner ran out of pre-seeded children");
      return child;
    },
  };
}

function scratchInput(): PinnedOciGraderInput {
  const root = mkdtempSync(join(tmpdir(), "jinn-oci-runner-"));
  const inputs = join(root, "inputs");
  const output = join(root, "output");
  mkdirSync(inputs, { mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  const config = join(inputs, "config.json");
  writeFileSync(config, "{}", { mode: 0o600 });
  return {
    runtime: "docker",
    image: IMAGE,
    platform: "linux/amd64",
    inputs: [{ source: config, targetName: "config.json" }],
    outputDirectory: output,
    command: ["/jinn/input/grader.py"],
    entrypoint: "python3",
    timeoutMs: 5_000,
    profileRequiresNetwork: false,
  };
}

describe("ensurePinnedOciImage", () => {
  it("skips the pull when the digest is already present locally", async () => {
    const inspect = new FakeChild();
    const { spawn, calls } = recordingSpawner([inspect]);
    const promise = ensurePinnedOciImage(
      { runtime: "docker", image: IMAGE, platform: "linux/amd64", timeoutMs: 60_000 },
      { spawn },
    );
    inspect.exit(0);
    await promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["image", "inspect", IMAGE]);
  });

  it("pulls by digest then positively re-inspects when absent", async () => {
    const missing = new FakeChild();
    const pull = new FakeChild();
    const verify = new FakeChild();
    const { spawn, calls } = recordingSpawner([missing, pull, verify]);
    const promise = ensurePinnedOciImage(
      { runtime: "docker", image: IMAGE, platform: "linux/amd64", timeoutMs: 60_000 },
      { spawn },
    );
    missing.exit(1);
    await flushMicrotasks();
    pull.exit(0);
    await flushMicrotasks();
    verify.exit(0);
    await promise;

    expect(calls.map((call) => call.args[0])).toEqual(["image", "pull", "image"]);
    expect(calls[1]!.args).toEqual(["pull", "--platform", "linux/amd64", IMAGE]);
  });

  it("refuses an unpinned image before spawning anything", async () => {
    const { spawn, calls } = recordingSpawner([]);
    await expect(ensurePinnedOciImage(
      { runtime: "docker", image: "swerebench/sweb.eval:latest", platform: "linux/amd64", timeoutMs: 60_000 },
      { spawn },
    )).rejects.toThrow(/pinned by sha256 digest/u);
    expect(calls).toHaveLength(0);
  });
});

describe("runPinnedOciGrader", () => {
  it("returns the exact bytes the container left at the statement path", async () => {
    const input = scratchInput();
    const inspect = new FakeChild();
    const run = new FakeChild();
    const { spawn, calls } = recordingSpawner([inspect, run]);
    const promise = runPinnedOciGrader(input, { spawn });
    inspect.exit(0);
    await flushMicrotasks();
    writeFileSync(join(input.outputDirectory, "verdict"), '{"log":"ok","report":{}}', { mode: 0o600 });
    run.exit(0);

    expect(new TextDecoder().decode(await promise)).toBe('{"log":"ok","report":{}}');
    const runArgs = calls[1]!.args;
    const getuid = process.getuid;
    const getgid = process.getgid;
    if (getuid === undefined || getgid === undefined) throw new Error("test requires a POSIX host");
    expect(runArgs.slice(runArgs.indexOf("--user"), runArgs.indexOf("--user") + 2))
      .toEqual(["--user", `${getuid()}:${getgid()}`]);
  });

  it("returns a completed grade even when removing the isolated network afterwards fails", async () => {
    // A `finally` block that throws replaces whatever the try block produced. Before the fix, a
    // failing `network rm` after a successful grade discarded the grade and surfaced a generic
    // "network could not be removed" instead.
    const input = { ...scratchInput(), profileRequiresNetwork: true };
    const inspect = new FakeChild();
    const created = new FakeChild();
    const run = new FakeChild();
    const remover = new FakeChild();
    const { spawn, calls } = recordingSpawner([inspect, created, run, remover]);
    const promise = runPinnedOciGrader(input, { spawn });
    inspect.exit(0);
    await flushMicrotasks();
    created.exit(0);
    await flushMicrotasks();
    writeFileSync(join(input.outputDirectory, "verdict"), '{"log":"ok","report":{}}', { mode: 0o600 });
    run.exit(0);
    await flushMicrotasks();
    remover.exit(1);

    expect(new TextDecoder().decode(await promise)).toBe('{"log":"ok","report":{}}');
    expect(calls.map((call) => call.args[0])).toEqual(["image", "network", "run", "network"]);
    expect(calls.at(-1)!.args.slice(0, 2)).toEqual(["network", "rm"]);
  });

  it("reports a nonzero grader exit as unavailable, not as a graded outcome", async () => {
    const input = scratchInput();
    const inspect = new FakeChild();
    const run = new FakeChild();
    const { spawn } = recordingSpawner([inspect, run]);
    const promise = runPinnedOciGrader(input, { spawn });
    inspect.exit(0);
    await flushMicrotasks();
    run.exit(3);

    await expect(promise).rejects.toThrow(/grader failed/u);
  });

  it("kills and force-removes a container that outruns its bound, then reports the deadline", async () => {
    const input = { ...scratchInput(), timeoutMs: 20 };
    const inspect = new FakeChild();
    const run = new FakeChild();
    const remover = new FakeChild();
    const { spawn, calls } = recordingSpawner([inspect, run, remover]);
    const promise = runPinnedOciGrader(input, { spawn });
    // Attach the rejection expectation before driving any fake exits. The removal step reuses
    // this test's 20ms timeoutMs as its own internal bound too, so — now that kill() self-emits
    // "exit" — the whole chain can settle on its own internal timers before the 60ms wait below
    // elapses. Waiting to attach `.rejects` until after that wait would race an already-settled
    // promise and trip Node's unhandled-rejection detection.
    const rejection = expect(promise).rejects.toThrow(/bounded time/u);
    inspect.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    remover.exit(0);

    await rejection;
    expect(run.killed).toBe("SIGKILL");
    expect(calls.at(-1)!.args.slice(0, 2)).toEqual(["rm", "-f"]);
  });

  it("reports the deadline, not a network cleanup failure, when the network rm also fails", async () => {
    // Before the fix, a `finally` block that threw its own "network could not be removed" here
    // replaced the deadlineExceeded already in flight, misreporting a timeout as a cleanup error.
    const input = { ...scratchInput(), timeoutMs: 20, profileRequiresNetwork: true };
    const inspect = new FakeChild();
    const created = new FakeChild();
    const run = new FakeChild();
    const containerRemover = new FakeChild();
    const networkRemover = new FakeChild();
    const { spawn, calls } = recordingSpawner([inspect, created, run, containerRemover, networkRemover]);
    const promise = runPinnedOciGrader(input, { spawn });
    const rejection = expect(promise).rejects.toThrow(/bounded time/u);
    inspect.exit(0);
    await flushMicrotasks();
    created.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    containerRemover.exit(0);
    await flushMicrotasks();
    networkRemover.exit(1);

    await rejection;
    expect(calls.at(-1)!.args.slice(0, 2)).toEqual(["network", "rm"]);
  });

  it("reports a runtime that cannot be spawned as unavailable", async () => {
    const input = scratchInput();
    const inspect = new FakeChild();
    const { spawn } = recordingSpawner([inspect]);
    const promise = runPinnedOciGrader(input, { spawn });
    inspect.fail(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));

    await expect(promise).rejects.toThrow(/runtime is unavailable/u);
  });

  it("reports a clean-exiting grader that wrote no output as a typed refusal, not a raw ENOENT", async () => {
    // A grader that exits 0 without leaving its statement is the ungradeable-without-output case.
    // It must reach the harness as an EvaluationOperationalError, never as a bare filesystem error.
    const input = scratchInput();
    const inspect = new FakeChild();
    const run = new FakeChild();
    const { spawn } = recordingSpawner([inspect, run]);
    const promise = runPinnedOciGrader(input, { spawn });
    const rejection = expect(promise).rejects.toMatchObject({
      name: "EvaluationOperationalError",
    });
    inspect.exit(0);
    await flushMicrotasks();
    run.exit(0);

    await rejection;
  });
});
