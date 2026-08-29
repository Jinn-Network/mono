/**
 * The `publication serve` verb's own surface: flag validation, and the shutdown contract that
 * makes a verb which runs until interrupted testable at all. The serving behaviour itself is
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

const ARGV = ["publication", "serve", "--workspace", ".", "--principal", "sponsor-1", "--port", "0"] as const;

describe("publication serve", () => {
  test("serves until the supplied shutdown signal aborts", async () => {
    const shutdown = new AbortController();
    const progress: string[] = [];
    const running = runCli([...ARGV, "--json"], contextFor({ shutdownSignal: shutdown.signal, progress: (line) => progress.push(line) }));
    // The verb only reports its bound URL once it is listening; aborting after that proves the
    // loop is the signal's, not a timer's.
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    expect(progress.join("\n")).toMatch(/^serving http:\/\/127\.0\.0\.1:\d+ /);
    shutdown.abort();

    const result = await running;
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; result: { url: string; announced: boolean } };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.announced).toBe(false);
    await expect(fetch(envelope.result.url)).rejects.toThrow();
  });

  test("returns immediately when the shutdown signal is already aborted", async () => {
    const result = await runCli([...ARGV], contextFor({ shutdownSignal: AbortSignal.abort() }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^served http:\/\/127\.0\.0\.1:\d+ until shutdown; /);
  });

  test("refuses without a process able to signal shutdown", async () => {
    const result = await runCli([...ARGV], contextFor());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/signal shutdown/);
  });

  test("refuses an out-of-range port and an unknown flag", async () => {
    const context = contextFor({ shutdownSignal: AbortSignal.abort() });
    const port = await runCli(["publication", "serve", "--workspace", ".", "--principal", "sponsor-1", "--port", "70000"], context);
    expect(port.exitCode).not.toBe(0);
    expect(port.stderr).toMatch(/--port must be an integer/);
    const flag = await runCli([...ARGV, "--draft", "d-1"], context);
    expect(flag.exitCode).not.toBe(0);
    expect(flag.stderr).toMatch(/unknown flag --draft/);
  });
});
