import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./main.js";
import type { CliContext } from "./result.js";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";

let root: string;
let context: CliContext;
let profilePath: string;
let keyPath: string;
let executablePath: string;
const secret = "cli-secret-must-not-be-rendered";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "colophon-agent-cli-"));
  executablePath = join(root, "claude");
  writeFileSync(executablePath, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '1.0.0 (Claude Code)'; else echo claude; fi\n");
  chmodSync(executablePath, 0o700);
  profilePath = join(root, "profile.json");
  writeFileSync(profilePath, JSON.stringify({
    format: "colophon-agent/1",
    agentId: "claude-main",
    adapter: "claude-code",
    executable: { path: executablePath, sha256: createHash("sha256").update(readFileSync(executablePath)).digest("hex"), version: "1.0.0" },
    model: "claude-sonnet",
    effort: "high",
    network: "provider-required",
  }));
  keyPath = join(root, "key.txt");
  writeFileSync(keyPath, secret, { mode: 0o600 });
  const agentDataDir = join(root, "user-data");
  context = {
    cwd: root,
    clock: () => "2026-08-13T00:00:00Z",
    agentDataDir,
    runtimeHost: createDefaultBenchmarkRuntimeHost({ agentDataDir }),
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("agent CLI", () => {
  it("observes and stores an exact executable profile without requiring hand-authored JSON", async () => {
    const result = await runCli([
      "agent", "add",
      "--agent", "claude-low",
      "--adapter", "claude-code",
      "--model", "claude-haiku-4-5-20251001",
      "--effort", "low",
      "--executable", executablePath,
      "--json",
    ], context);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: {
        agentId: "claude-low",
        adapter: "claude-code",
        model: "claude-haiku-4-5-20251001",
        effort: "low",
        executable: {
          path: realpathSync(executablePath),
          version: "1.0.0",
          sha256: createHash("sha256").update(readFileSync(executablePath)).digest("hex"),
        },
      },
    });

    const alias = await runCli([
      "agent", "add",
      "--agent", "claude-alias",
      "--adapter", "claude-code",
      "--model", "sonnet",
      "--effort", "low",
      "--executable", executablePath,
      "--json",
    ], context);
    expect(alias.exitCode).toBe(1);
    expect(alias.stdout).toContain("exact provider model identifier");
  });

  it("stores an explicit profile and protected API key without writing the value to output", async () => {
    const add = await runCli(["agent", "add", "--file", profilePath, "--json"], context);
    expect(add.exitCode).toBe(0);
    const credentials = await runCli(["agent", "credentials", "--agent", "claude-main", "--api-key-file", keyPath, "--json"], context);
    expect(credentials.exitCode).toBe(0);
    expect(credentials.stdout).not.toContain(secret);
    expect(readFileSync(join(root, "user-data", "credentials", "claude-main.json"), "utf8")).not.toContain(secret);
  });

  it("does not fake a harness login when qualification is absent", async () => {
    await runCli(["agent", "add", "--file", profilePath], context);
    const result = await runCli(["agent", "login", "--agent", "claude-main", "--json"], context);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not qualified");
    expect(result.stdout).not.toContain(secret);
  });

  it("requires and reports provider network/cost acknowledgement before quote, lock, launch, and resume", async () => {
    const workspace = join(root, "workspace");
    const rowsPath = join(root, "swebench.json");
    writeFileSync(rowsPath, JSON.stringify([{
      instance_id: "swe-rebench-2024-00042",
      repo: "psf/requests",
      base_commit: "d8bdd423ab2df9f87b7975cdb32b31f3002a20c0",
      problem_statement: "Fix the connection pool leak when retries are exhausted.",
      language: "python",
      image: { uri: "https://example.org/image", digest: { sha256: "e8d6cfe4f52e87a1292f3897bf0bea28e4bde32703e6792bb9b1bc60d3024817" } },
      testMaterial: [{ uri: "https://example.org/test.py" }],
      parser: { id: "jinn.parser.pytest-json-report", version: "1.0.0", digest: "sha256:d2136b44c86f551b2494d616a8ee7afd58e6f90681f1beb84441113154a13897" },
      transitions: { failToPass: ["test_pool.py::test_retry_releases_connection"], passToPass: ["test_pool.py::test_basic_get"] },
      timeout: 1800,
    }]));
    const base = ["--workspace", workspace, "--principal", "sponsor-1"];
    expect((await runCli(["init", ...base, "--json"], context)).exitCode).toBe(0);
    expect((await runCli(["draft", "create", ...base, "--id", "provider", "--name", "Provider", "--json"], context)).exitCode).toBe(0);
    expect((await runCli(["import", "swebench", ...base, "--draft", "provider", "--file", rowsPath, "--json"], context)).exitCode).toBe(0);
    expect((await runCli(["agent", "add", "--file", profilePath, "--json"], context)).exitCode).toBe(0);
    expect((await runCli(["agent", "credentials", "--agent", "claude-main", "--api-key-file", keyPath, "--json"], context)).exitCode).toBe(0);
    expect((await runCli(["arm", "add", ...base, "--draft", "provider", "--arm", "claude", "--agent", "claude-main", "--json"], context)).exitCode).toBe(0);
    expect((await runCli([
      "arm", "add", ...base, "--draft", "provider", "--arm", "sample",
      "--pinning", JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } }), "--json",
    ], context)).exitCode).toBe(0);

    const quoteRefused = await runCli(["quote", ...base, "--draft", "provider", "--json"], context);
    expect(quoteRefused.exitCode).toBe(2);
    expect(quoteRefused.stdout).toContain("may create charges");

    const quote = await runCli(["quote", ...base, "--draft", "provider", "--ack-provider-network-costs", "--json"], context);
    expect(quote.exitCode, quote.stdout).toBe(0);
    expect(JSON.parse(quote.stdout).result.providerNetworkCostAcknowledged).toBe(true);

    const lockRefused = await runCli(["lock", ...base, "--draft", "provider", "--json"], context);
    expect(lockRefused.exitCode).toBe(2);
    const progress: string[] = [];
    const lock = await runCli(
      ["lock", ...base, "--draft", "provider", "--ack-provider-network-costs"],
      { ...context, progress: (line) => progress.push(line) },
    );
    expect(lock.exitCode, lock.stderr).toBe(0);
    expect(progress.join("\n")).toContain("Provider calls may create charges");

    for (const verb of ["launch", "resume"]) {
      const refused = await runCli([verb, ...base, "--draft", "provider", "--json"], context);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toContain("ack-provider-network-costs");
    }
  });
});
