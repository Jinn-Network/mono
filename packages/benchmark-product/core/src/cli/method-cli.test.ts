import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CLI_VERB_NAMES, runCli, USAGE } from "./main.js";
import type { CliContext } from "./result.js";
import { STANDALONE_CLI_VERBS } from "./parity-map.js";

function context(): CliContext {
  return { cwd: "/tmp", clock: () => "2026-08-18T00:00:00.000Z" };
}

function parseJson(stdout: string): {
  ok: boolean;
  result?: {
    catalog?: ReadonlyArray<{ id: string }>;
    catalogId?: string;
    official?: boolean;
    selectionManifestSha256?: string;
    benchmarkSha256?: string;
    draft?: { draftId: string };
  };
  error?: { code: string; detail: string };
} {
  return JSON.parse(stdout) as {
    ok: boolean;
    result?: {
      catalog?: ReadonlyArray<{ id: string }>;
      catalogId?: string;
      official?: boolean;
      selectionManifestSha256?: string;
      benchmarkSha256?: string;
      draft?: { draftId: string };
    };
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
    ["runtime", "terminal-bench", "migrate"],
    ["runtime", "inspect", "eval", "select"],
    ["runtime", "inspect", "eval", "export"],
    ["runtime", "inspect", "bind-judge"],
    ["hub", "export"],
    ["swebench", "export"],
    ["apex-agents", "export"],
    ["apex-swe", "export"],
    ["deepswe", "export"],
    ["demo1", "prereg", "verify"],
  ])("unknown command %s", async (...words) => {
    const result = await runCli([...words, "--json"], context());
    expect(result.exitCode).toBe(2);
    const body = parseJson(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
    expect(body.error?.detail).toBe(`unknown command "${words.join(" ")}"`);
  });
});

describe("Demo-1 / SkillsBench method removal", () => {
  test("USAGE says the method is gone", () => {
    expect(USAGE).toContain(
      "The Demo-1 / SkillsBench method is gone, including demo1 prereg verify. Colophon creates no benchmarks.",
    );
  });

  test("the verb is not in the dispatch table or standalone map", () => {
    expect(CLI_VERB_NAMES).not.toContain("demo1 prereg verify");
    expect(STANDALONE_CLI_VERBS).not.toHaveProperty("demo1 prereg verify");
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

describe("method bind catalog identity", () => {
  let root: string;
  let workspaceDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "method-cli-bind-"));
    workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("catalog bind with empty host.json seals identity without a selection hash", async () => {
    const hostPath = join(root, "host.json");
    writeFileSync(hostPath, "{}");
    const ctx: CliContext = { cwd: root, clock: () => "2026-08-18T00:00:00.000Z" };
    expect((await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1", "--json"], ctx)).exitCode).toBe(0);
    const created = await runCli(
      ["draft", "create", "--workspace", workspaceDir, "--principal", "sponsor-1", "--name", "One", "--json"],
      ctx,
    );
    expect(created.exitCode).toBe(0);
    const draftId = parseJson(created.stdout).result?.draft?.draftId;
    expect(draftId).toBe("one");
    const bound = await runCli(
      [
        "method", "terminal-bench-2.1",
        "--workspace", workspaceDir,
        "--principal", "sponsor-1",
        "--draft", "one",
        "--slice", "1",
        "--host", hostPath,
        "--json",
      ],
      ctx,
    );
    expect(bound.exitCode, bound.stdout).toBe(0);
    const body = parseJson(bound.stdout);
    expect(body.ok).toBe(true);
    expect(body.result?.catalogId).toBe("terminal-bench-2.1");
    expect(body.result?.official).toBe(true);
    expect(body.result?.selectionManifestSha256).toBeUndefined();
    expect(body.result?.benchmarkSha256).toMatch(/^[a-f0-9]{64}$/u);
    const createdTwo = await runCli(
      ["draft", "create", "--workspace", workspaceDir, "--principal", "sponsor-1", "--name", "Two", "--json"],
      ctx,
    );
    expect(createdTwo.exitCode).toBe(0);
    const text = await runCli(
      [
        "method", "terminal-bench-2.1",
        "--workspace", workspaceDir,
        "--principal", "sponsor-1",
        "--draft", "two",
        "--slice", "1",
        "--host", hostPath,
      ],
      ctx,
    );
    expect(text.exitCode, text.stdout).toBe(0);
    expect(text.stdout).toBe(`bound official terminal-bench-2.1 method ${body.result?.benchmarkSha256} for draft two\n`);
  });
});
