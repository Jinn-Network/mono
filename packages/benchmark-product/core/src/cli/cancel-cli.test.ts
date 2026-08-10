import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authorityGrant } from "../operations/authority-ops.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { draftPath } from "../workspace/layout.js";
import { runCli, USAGE } from "./main.js";
import type { CliContext } from "./result.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp22-cancel-cli-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function clock(): string {
  return "2026-08-05T00:00:00Z";
}

function operationContext(principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

function cliContext(): CliContext {
  return { cwd: workspaceDir, clock };
}

function forceRunningDraft(draftId: string): void {
  const draft = readDraftDocument(workspaceDir, draftId);
  atomicWriteFileSync(draftPath(workspaceDir, draftId), JSON.stringify({ ...draft, state: "running" }, null, 2));
}

describe("cancel CLI verb (BP-22)", () => {
  test("USAGE exposes cancel as a first-class verb", () => {
    expect(USAGE).toContain("cancel           --workspace <dir> --principal <id> --draft <draftId>");
  });

  test("--json dispatches to the typed cancel operation and preserves authority-denied exit 3", async () => {
    initWorkspace(operationContext());
    createDraft(operationContext(), { draftId: "draft-1", name: "Cancel CLI" });
    forceRunningDraft("draft-1");
    authorityGrant(operationContext(), { principalId: "agent-1", operations: [] });

    const result = await runCli(
      ["cancel", "--workspace", workspaceDir, "--principal", "agent-1", "--draft", "draft-1", "--json"],
      cliContext(),
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "authority-denied" },
    });
  });

  test("a sponsor invocation reaches the lifecycle guard as a typed illegal-transition", async () => {
    initWorkspace(operationContext());
    createDraft(operationContext(), { draftId: "draft-1", name: "Cancel CLI" });

    const result = await runCli(
      ["cancel", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "draft-1", "--json"],
      cliContext(),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "illegal-transition" },
    });
  });
});
