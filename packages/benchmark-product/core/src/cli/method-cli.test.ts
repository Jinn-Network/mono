import { describe, expect, test } from "vitest";
import { runCli } from "./main.js";
import type { CliContext } from "./result.js";

function context(): CliContext {
  return { cwd: "/tmp", clock: () => "2026-08-18T00:00:00.000Z" };
}

function parseJson(stdout: string): {
  ok: boolean;
  result?: { catalog?: ReadonlyArray<{ id: string }> };
  error?: { code: string; detail: string };
} {
  return JSON.parse(stdout) as {
    ok: boolean;
    result?: { catalog?: ReadonlyArray<{ id: string }> };
    error?: { code: string; detail: string };
  };
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
    ["runtime", "inspect", "bind-judge"],
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
});

describe("method catalog list", () => {
  test("method with no operand lists the catalog as JSON without workspace or draft", async () => {
    const result = await runCli(["method", "--json"], context());
    expect(result.exitCode).toBe(0);
    const body = parseJson(result.stdout);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.result?.catalog)).toBe(true);
    expect(body.result?.catalog).toHaveLength(5);
    const ids = (body.result?.catalog ?? []).map((row) => row.id);
    expect(ids).toContain("terminal-bench-2.1");
    expect(ids).toContain("apex-swe-dev");
  });

  test("method list refuses flags other than --json", async () => {
    const result = await runCli(["method", "--workspace", "/tmp/ws", "--json"], context());
    expect(result.exitCode).toBe(2);
    const body = parseJson(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
    expect(body.error?.detail).toMatch(/unknown flag --workspace/);
  });
});

describe("method and verb help", () => {
  test("method --help names catalog ids, --host, and homemade SWE rows", async () => {
    const result = await runCli(["method", "--help"], context());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("terminal-bench-2.1");
    expect(result.stdout).toContain("--host");
    expect(result.stdout).toContain("swe-bench-verified");
    expect(result.stdout).toContain("homemade");
    expect(result.stdout).not.toContain("draft create");
  });

  test("help method prints the same method help, not the full USAGE", async () => {
    const result = await runCli(["help", "method"], context());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("terminal-bench-2.1");
    expect(result.stdout).toContain("--host");
    expect(result.stdout).toContain("swe-bench-verified");
    expect(result.stdout).toContain("homemade");
    expect(result.stdout).not.toContain("draft create");
  });

  test("--help still contains the full USAGE including draft create", async () => {
    const result = await runCli(["--help"], context());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("draft create");
  });

  test("other verbs' --help print that verb's USAGE stanza, not the full dump", async () => {
    const result = await runCli(["draft", "create", "--help"], context());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("draft create");
    expect(result.stdout).toContain("--name");
    expect(result.stdout).not.toContain("preview          --workspace");
  });
});

describe("method bind", () => {
  test("method with three words refuses invalid-invocation", async () => {
    const result = await runCli(["method", "a", "b", "--json"], context());
    expect(result.exitCode).toBe(2);
    const body = parseJson(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
    expect(body.error?.detail).toMatch(/exactly one operand/);
  });

  test("method bind accepts --n rather than treating it as an unknown flag", async () => {
    const result = await runCli(["method", "x", "--n", "1", "--json"], context());
    const body = parseJson(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.detail).not.toMatch(/unknown flag --n/);
  });
});
