import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assessAgentRuntimeReadiness } from "../runtime/agent-readiness.js";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let root: string;
let workspaceDir: string;
let agentDataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "colophon-agent-readiness-"));
  workspaceDir = join(root, "workspace");
  agentDataDir = join(root, "agent-data");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function clock(): string {
  return "2026-08-13T00:00:00.000Z";
}

function context(runtime = false): OperationContext {
  return {
    workspaceDir,
    principal: "operator",
    clock,
    ...(runtime ? { runtimeHost: createDefaultBenchmarkRuntimeHost({ agentDataDir }) } : {}),
  };
}

const REAL_PINNING = {
  harness: { id: "codex", version: "1.2.3", digest: "a".repeat(64) },
  model: { id: "gpt-test" },
  effort: "low",
};

async function setUpRealAgentDraft(): Promise<void> {
  initWorkspace(context());
  createDraft(context(), { draftId: "draft-1", name: "Real agent gate" });
  await sampleInit(context(), { draftId: "draft-1" });
  armAdd(context(), { draftId: "draft-1", armId: "candidate", pinning: REAL_PINNING });
  armAdd(context(), {
    draftId: "draft-1",
    armId: "baseline",
    pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } },
  });
}

describe("real-agent readiness gate", () => {
  test("refuses quote before venue creation when the exact real profile is unavailable", async () => {
    await setUpRealAgentDraft();

    const outcome = await runQuote(context(true), { draftId: "draft-1" });

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "venue-unavailable",
        issues: [{ path: "arms.candidate.pinning" }],
      },
    });
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("draft");
  });

  test("re-checks readiness at lock so a profile cannot go stale after quote", async () => {
    await setUpRealAgentDraft();
    const quoted = await runQuote(context(), { draftId: "draft-1" });
    expect(quoted.ok).toBe(true);

    const outcome = runLock(context(true), { draftId: "draft-1" });

    expect(outcome).toMatchObject({ ok: false, error: { code: "venue-unavailable" } });
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("quoted");
  });

  test("browser-safe findings never expose a stored executable path", () => {
    const secretPath = "/private/operator/bin/codex-secret-location";
    mkdirSync(join(agentDataDir, "agents"), { recursive: true });
    writeFileSync(join(agentDataDir, "agents", "codex-local.json"), JSON.stringify({
      format: "colophon-agent/1",
      agentId: "codex-local",
      adapter: "codex",
      executable: { path: secretPath, sha256: "a".repeat(64), version: "1.2.3" },
      model: "gpt-test",
      effort: "low",
      network: "provider-required",
    }));

    const [finding] = assessAgentRuntimeReadiness(agentDataDir, [{ armId: "candidate", pinning: REAL_PINNING }]);

    expect(finding).toMatchObject({ ready: false, code: "executable-not-ready", armId: "candidate" });
    expect(JSON.stringify(finding)).not.toContain(secretPath);
  });

  test("sample arms do not require a provider profile", () => {
    expect(assessAgentRuntimeReadiness(undefined, [{
      armId: "sample",
      pinning: { harness: { id: "sample-uniform", version: "0.1.0" } },
    }])).toEqual([]);
  });
});
