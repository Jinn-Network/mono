/**
 * The `publication serve` verb's own surface: flag validation, and the shutdown contract that
 * makes a verb which runs until interrupted testable at all. The serving behavior itself is
 * proved over a real socket in `../run/publication-serve.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWorkspaceLayout } from "../workspace/workspace.js";
import { runCli } from "./main.js";
import type { CliContext } from "./result.js";

let workspaceDir: string;

function contextFor(overrides: Partial<CliContext> = {}): CliContext {
  return { cwd: workspaceDir, clock: () => "2026-08-13T12:00:00Z", ...overrides };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "publication-serve-cli-"));
  createWorkspaceLayout(workspaceDir, "2026-08-13T12:00:00Z");
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the verb to report its bound URL");
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

const ARGV = ["publication", "serve", "--workspace", ".", "--principal", "sponsor-1", "--port", "0"] as const;

describe("publication serve", () => {
  test("serves until the shutdown signal it installs aborts", async () => {
    const shutdown = new AbortController();
    let installed = 0;
    const progress: string[] = [];
    const running = runCli([...ARGV, "--json"], contextFor({
      createShutdownSignal: () => { installed += 1; return shutdown.signal; },
      progress: (line) => progress.push(line),
    }));
    // The verb only reports its bound URL once it is listening, so polling for that line is what
    // makes the abort below prove the loop is the signal's rather than a timer's. A fixed sleep
    // would race the bind on a loaded machine.
    await waitFor(() => progress.length > 0);
    expect(progress.join("\n")).toMatch(/^serving http:\/\/127\.0\.0\.1:\d+ /);
    expect(installed).toBe(1);
    shutdown.abort();

    const result = await running;
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; result: { url: string; announced: boolean } };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.announced).toBe(false);
    await expect(fetch(envelope.result.url)).rejects.toThrow();
  });

  test("returns immediately when the shutdown signal is already aborted", async () => {
    const result = await runCli([...ARGV], contextFor({ createShutdownSignal: () => AbortSignal.abort() }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^served http:\/\/127\.0\.0\.1:\d+ until shutdown; /);
  });

  test("refuses without a process able to signal shutdown, and never installs one otherwise", async () => {
    const result = await runCli([...ARGV], contextFor());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/signal shutdown/);
    // Every other verb must leave the process's own SIGINT handling alone: a registered listener
    // replaces Node's default termination, so arming one for `status` would swallow a Ctrl-C.
    let installed = 0;
    await runCli(["draft", "list", "--workspace", ".", "--principal", "sponsor-1"], contextFor({
      createShutdownSignal: () => { installed += 1; return AbortSignal.abort(); },
    }));
    expect(installed).toBe(0);
  });

  test("refuses an out-of-range port and an unknown flag", async () => {
    const context = contextFor({ createShutdownSignal: () => AbortSignal.abort() });
    const port = await runCli(["publication", "serve", "--workspace", ".", "--principal", "sponsor-1", "--port", "70000"], context);
    expect(port.exitCode).not.toBe(0);
    expect(port.stderr).toMatch(/--port must be an integer/);
    const flag = await runCli([...ARGV, "--draft", "d-1"], context);
    expect(flag.exitCode).not.toBe(0);
    expect(flag.stderr).toMatch(/unknown flag --draft/);
  });
});
