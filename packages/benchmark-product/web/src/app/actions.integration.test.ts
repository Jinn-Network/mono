import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { GuiActionState } from "@/lib/action-state";
import {
  PRINCIPAL_ENV,
  readProductServerConfiguration,
  WORKSPACE_ENV,
} from "@/lib/server/product-context";
import { GUI_SERVER_ACTIONS } from "@/lib/server/gui-action-registry";
import { executeOperation } from "@/lib/server/action-support";

const revalidatePathMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const IDLE: GuiActionState = { status: "idle" };
const workspaces: string[] = [];

function form(fields: Readonly<Record<string, string>> = {}): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

async function invoke(action: keyof typeof GUI_SERVER_ACTIONS, fields: Readonly<Record<string, string>> = {}) {
  return GUI_SERVER_ACTIONS[action](IDLE, form(fields));
}

afterEach(() => {
  delete process.env[WORKSPACE_ENV];
  delete process.env[PRINCIPAL_ENV];
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  revalidatePathMock.mockClear();
});

describe.sequential("server action layer against a real workspace", () => {
  test("fails closed when workspace or principal configuration is absent", async () => {
    const outcome = await invoke("draft.list");
    expect(outcome).toMatchObject({ status: "error", error: { code: "invalid-invocation" } });
  });

  test("configuration exposes only workspace and principal, never ambient secrets", () => {
    const workspace = mkdtempSync(join(tmpdir(), "bp31-context-"));
    workspaces.push(workspace);
    const configuration = readProductServerConfiguration({
      [WORKSPACE_ENV]: workspace,
      [PRINCIPAL_ENV]: "sponsor-1",
      PRIVATE_SIGNING_KEY: "-----BEGIN PRIVATE KEY-----",
    });
    expect(configuration).toEqual({ workspaceDir: workspace, principal: "sponsor-1" });
    expect(JSON.stringify(configuration)).not.toContain("PRIVATE KEY");
  });

  test("unexpected pre-operation errors do not expose internal details", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bp31-redaction-"));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    const outcome = await executeOperation(() => {
      throw new Error(`private path: ${workspace}/venue/report-signing-key.pem`);
    });
    expect(outcome).toMatchObject({ status: "error", error: { code: "invalid-invocation" } });
    expect(JSON.stringify(outcome)).not.toContain(workspace);
    expect(JSON.stringify(outcome)).not.toContain("signing-key.pem");
  });

  test("authority role transport parsing fails closed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bp31-role-"));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    await invoke("workspace.init");
    const outcome = await invoke("authority.grant", { principalId: "agent-1", role: "owner", operations: "lock" });
    expect(outcome).toMatchObject({ status: "error", error: { code: "invalid-invocation" } });
  });

  test(
    "walks init, draft, sample, arms, authority, REAL preview, quote, and gated lock",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "bp31-actions-"));
      workspaces.push(workspace);
      process.env[WORKSPACE_ENV] = workspace;
      process.env[PRINCIPAL_ENV] = "sponsor-1";

      expect(await invoke("workspace.init")).toMatchObject({ status: "success" });
      expect(revalidatePathMock).toHaveBeenCalledWith("/workspace");
      expect(await invoke("draft.create", {
        draftId: "gui-walkthrough",
        name: "GUI walkthrough",
        description: "A real server-action integration run",
      })).toMatchObject({ status: "success" });
      expect(await invoke("draft.update", {
        draftId: "gui-walkthrough",
        patch: JSON.stringify({ assurance: { preset: "direct-check" } }),
      })).toMatchObject({ status: "success" });
      expect(await invoke("intake.sample", { draftId: "gui-walkthrough" })).toMatchObject({ status: "success" });

      expect(await invoke("arm.add", {
        draftId: "gui-walkthrough",
        armId: "baseline",
        pinning: JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } }),
      })).toMatchObject({ status: "success" });
      expect(await invoke("arm.add", {
        draftId: "gui-walkthrough",
        armId: "sample",
        pinning: JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } }),
      })).toMatchObject({ status: "success" });

      expect(await invoke("authority.grant", {
        principalId: "agent-1",
        role: "delegated-agent",
        operations: "lock",
      })).toMatchObject({ status: "success" });
      expect(await invoke("authority.show")).toMatchObject({ status: "success" });
      expect(await invoke("authority.revoke", {
        principalId: "agent-1",
        operations: "lock",
      })).toMatchObject({ status: "success" });

      const preview = await invoke("run.preview", { draftId: "gui-walkthrough", items: "1" });
      expect(preview, JSON.stringify(preview)).toMatchObject({
        status: "success",
        result: { preview: { scope: "solve-cells-only", itemCount: 1, cellCount: 2 } },
      });

      const quote = await invoke("run.quote", { draftId: "gui-walkthrough" });
      expect(quote, JSON.stringify(quote)).toMatchObject({
        status: "success",
        result: { presentation: { runSize: { solveCells: 6 } } },
      });
      const locked = await invoke("run.lock", { draftId: "gui-walkthrough" });
      expect(locked, JSON.stringify(locked)).toMatchObject({
        status: "success",
        result: { draft: { state: "locked" } },
      });
      expect(await invoke("draft.show", { draftId: "gui-walkthrough" })).toMatchObject({
        status: "success",
        result: { draft: { state: "locked" } },
      });
      expect(await invoke("draft.inspect", { draftId: "gui-walkthrough" })).toMatchObject({ status: "success" });
      expect(await invoke("draft.list")).toMatchObject({ status: "success" });
      expect(await invoke("arm.list", { draftId: "gui-walkthrough" })).toMatchObject({ status: "success" });
    },
    120_000,
  );
});
