import { describe, expect, test } from "vitest";
import { runCli } from "./main.js";
import type { CliContext } from "./result.js";

function context(): CliContext {
  return { cwd: "/tmp", clock: () => "2026-08-18T00:00:00.000Z" };
}

function parseJson(stdout: string): { ok: boolean; error?: { code: string; detail: string } } {
  return JSON.parse(stdout) as { ok: boolean; error?: { code: string; detail: string } };
}

describe("retired per-suite verbs", () => {
  test.each([
    ["runtime", "inspect", "select"],
    ["runtime", "harbor", "select"],
    ["runtime", "terminal-bench-2", "select"],
    ["runtime", "terminal-bench-2-1", "select"],
    ["runtime", "terminal-bench-3-0", "select"],
    ["runtime", "swe-bench-verified", "select"],
    ["runtime", "apex-agents", "select"],
    ["runtime", "apex-swe-dev", "select"],
    ["runtime", "deep-swe-v1.1", "select"],
    ["runtime", "inspect", "eval", "select"],
    ["runtime", "inspect", "eval", "export"],
    ["hub", "export"],
    ["swebench", "export"],
    ["apex-agents", "export"],
    ["apex-swe", "export"],
    ["deepswe", "export"],
  ])("unknown command %s", async (...words) => {
    const result = await runCli([...words, "--json"], context());
    expect(result.exitCode).toBe(2);
    const body = parseJson(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
    expect(body.error?.detail).toBe(`unknown command "${words.join(" ")}"`);
  });

  test("method without an operand refuses invalid-invocation", async () => {
    const result = await runCli([
      "method",
      "--workspace", "/tmp/ws",
      "--principal", "sponsor-1",
      "--draft", "one",
      "--json",
    ], context());
    expect(result.exitCode).toBe(2);
    const body = parseJson(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
    expect(body.error?.detail).toMatch(/exactly one operand/);
  });
});
