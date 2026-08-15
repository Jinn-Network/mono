import { describe, expect, it } from "vitest";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { makeClaudeCodeLauncher } from "./claude-code.js";
import { makeCodexLauncher } from "./codex.js";

const view = { task: { instructions: "do the work", outputs: [] }, effectiveRequirements: {}, profile: { profile: "https://spec.jinn.network/task-profiles/repository-work/1.0" } } as unknown as TaskView;
const attempt = { attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000001", nonce: "n", attemptNumber: 1 } as AttemptIdentity;
const paths = {
  root: "/attempt", input: "/attempt/input", work: "/attempt/work", out: "/attempt/out",
  logs: "/attempt/logs", harnessState: "/attempt/harness", secrets: "/attempt/secrets",
  tmp: "/attempt/tmp", meta: "/attempt/meta",
} as WorkspacePaths;

describe("credential-qualified Claude Code and Codex launcher plans", () => {
  it("keeps default plans zero-forward", () => {
    const claude = makeClaudeCodeLauncher().plan(view, paths, attempt);
    const codex = makeCodexLauncher().plan(view, paths, attempt);
    expect(claude.secretForwards).toEqual([]);
    expect(codex.secretForwards).toEqual([]);
    expect(claude.argv[0]).toBe("claude");
    expect(codex.argv[0]).toBe("codex");
    expect(claude.env).not.toHaveProperty("JINN_ATTEMPT_SECRETS");
    expect(codex.env).not.toHaveProperty("JINN_ATTEMPT_SECRETS");
  });

  it("plans portable references and the supervisor-owned bridge only", () => {
    const claude = makeClaudeCodeLauncher({ credential: { kind: "api-key", secretBasename: "claude-api" } });
    const codex = makeCodexLauncher({ credential: { kind: "api-key", secretBasename: "openai-api" } });
    for (const [launcher, reference, variable] of [
      [claude, "secrets/claude-api", "ANTHROPIC_API_KEY"],
      [codex, "secrets/openai-api", "OPENAI_API_KEY"],
    ] as const) {
      const plan = launcher.plan(view, paths, attempt);
      expect(plan.secretForwards).toEqual([{ grantKey: reference.slice("secrets/".length), target: reference.slice("secrets/".length) }]);
      expect(plan.env[variable]).toBe(reference);
      expect(plan.argv[0]).toBe(process.execPath);
      expect(plan.argv[1]).toMatch(/task-execution\/backend-local\/supervisor\/(?:src|dist)\/credential-exec\.mjs$/u);
      expect(plan.argv[2]).toBe("--");
    }
  });

  it("uses an opaque host handle instead of a requester grant", () => {
    const plan = makeCodexLauncher({ hostCredential: { kind: "api-key", secretBasename: "codex-api", handle: "agent-codex" } }).plan(view, paths, attempt);
    expect(plan.secretForwards).toEqual([]);
    expect(plan.hostSecretForwards).toEqual([{ handle: "agent-codex", target: "codex-api", role: "harness" }]);
    expect(plan.env.OPENAI_API_KEY).toBe("secrets/codex-api");
  });

  it("rejects escaping targets and relative executable identities", () => {
    expect(() => makeClaudeCodeLauncher({ credential: { kind: "api-key", secretBasename: "../host-key" } }).plan(view, paths, attempt)).toThrow("portable basename");
    expect(() => makeCodexLauncher({ credential: { kind: "credential-artifact", secretBasename: "secrets/auth.json" } }).plan(view, paths, attempt)).toThrow("portable basename");
    expect(() => makeClaudeCodeLauncher({ executablePath: "relative/claude" }).plan(view, paths, attempt)).toThrow("must be absolute");
  });
});
