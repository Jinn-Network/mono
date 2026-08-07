import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { GuiActionState } from "@/lib/action-state";
import {
  ENABLE_TEST_CONTROLS_ENV,
  PRINCIPAL_ENV,
  readRunDriverTestingDeps,
  readProductServerConfiguration,
  TEST_SOLVE_DELAY_MS_ENV,
  WORKSPACE_ENV,
} from "@/lib/server/product-context";
import { GUI_SERVER_ACTIONS } from "@/lib/server/gui-action-registry";
import { executeOperation } from "@/lib/server/action-support";
import { executeBackgroundOperation } from "@/lib/server/background-operation";

const revalidatePathMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
const afterState = vi.hoisted(() => ({ tasks: [] as Promise<unknown>[] }));
vi.mock("next/server", () => ({
  after(task: Promise<unknown> | (() => unknown)) {
    afterState.tasks.push(typeof task === "function" ? Promise.resolve().then(task) : Promise.resolve(task));
  },
}));

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

afterEach(async () => {
  await Promise.allSettled(afterState.tasks.splice(0));
  delete process.env[WORKSPACE_ENV];
  delete process.env[PRINCIPAL_ENV];
  delete process.env[ENABLE_TEST_CONTROLS_ENV];
  delete process.env[TEST_SOLVE_DELAY_MS_ENV];
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  revalidatePathMock.mockClear();
}, 120_000);

async function prepareLockedDraft(draftId: string): Promise<void> {
  expect(await invoke("draft.create", { draftId, name: `Run ${draftId}` })).toMatchObject({ status: "success" });
  expect(await invoke("intake.sample", { draftId })).toMatchObject({ status: "success" });
  expect(await invoke("arm.add", {
    draftId,
    armId: "baseline",
    pinning: JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } }),
  })).toMatchObject({ status: "success" });
  expect(await invoke("arm.add", {
    draftId,
    armId: "sample",
    pinning: JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } }),
  })).toMatchObject({ status: "success" });
  expect(await invoke("run.quote", { draftId })).toMatchObject({ status: "success" });
  expect(await invoke("run.lock", { draftId })).toMatchObject({ status: "success" });
}

async function waitForDurableStatus(
  draftId: string,
  predicate: (result: Record<string, unknown>) => boolean,
): Promise<GuiActionState> {
  let last: GuiActionState = IDLE;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await invoke("run.status", { draftId });
    last = status;
    if (status.status === "success" && predicate(status.result as Record<string, unknown>)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`durable status for ${draftId} did not reach the expected condition: ${JSON.stringify(last)}`);
}

describe.sequential("server action layer against a real workspace", () => {
  test("a post-ownership delayed failure crosses the response boundary through Next after()", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bp32-after-failure-"));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    const outcome = await executeBackgroundOperation("launch", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return { ok: false as const, error: { code: "venue-unavailable" as const, detail: "delayed probe" } };
    });
    expect(outcome).toMatchObject({ status: "scheduled", result: { operation: "launch" } });
    const [completion] = await Promise.all(afterState.tasks.splice(0));
    expect(completion).toMatchObject({ ok: false, error: { code: "venue-unavailable" } });
  });

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

  test.each(["execution", "venue-unavailable", "venue-unverifiable"] as const)(
    "typed %s runtime failures retain their code but redact browser detail",
    async (code) => {
      const workspace = mkdtempSync(join(tmpdir(), "bp32-operation-redaction-"));
      workspaces.push(workspace);
      process.env[WORKSPACE_ENV] = workspace;
      process.env[PRINCIPAL_ENV] = "sponsor-1";
      const sentinel = "/private/workspace/report-signing-key-VERY_SECRET.pem";
      const outcome = await executeOperation(() => ({
        ok: false as const,
        error: { code, detail: sentinel },
      }));
      expect(outcome).toMatchObject({ status: "error", error: { code } });
      expect(JSON.stringify(outcome)).toContain("server logs");
      expect(JSON.stringify(outcome)).not.toContain(sentinel);
      expect(JSON.stringify(outcome)).not.toContain("VERY_SECRET");
    },
  );

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

  test("test-only solve delay requires both explicit server-side opt-ins", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bp32-test-control-"));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    await invoke("workspace.init");
    await prepareLockedDraft("gated-delay");
    process.env[TEST_SOLVE_DELAY_MS_ENV] = "30000";

    const denied = await invoke("run.launch", { draftId: "gated-delay" });
    expect(denied).toMatchObject({ status: "error", error: { code: "invalid-invocation" } });
    expect(JSON.stringify(denied)).toContain(ENABLE_TEST_CONTROLS_ENV);
  }, 120_000);

  test("test-only solve delay accepts the core maximum and refuses one millisecond beyond it", () => {
    expect(readRunDriverTestingDeps({
      [ENABLE_TEST_CONTROLS_ENV]: "1",
      [TEST_SOLVE_DELAY_MS_ENV]: "60000",
    })).toEqual({ solveStartDelayMsForTesting: 60_000 });
    expect(() => readRunDriverTestingDeps({
      [ENABLE_TEST_CONTROLS_ENV]: "1",
      [TEST_SOLVE_DELAY_MS_ENV]: "60001",
    })).toThrow(/1 to 60000/);
  });

  test(
    "slow REAL venue remains observable, cancels requested→draining→cancelled, and accounts every cell",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "bp32-real-cancel-"));
      workspaces.push(workspace);
      process.env[WORKSPACE_ENV] = workspace;
      process.env[PRINCIPAL_ENV] = "sponsor-1";
      process.env[ENABLE_TEST_CONTROLS_ENV] = "1";
      process.env[TEST_SOLVE_DELAY_MS_ENV] = "30000";
      await invoke("workspace.init");
      await prepareLockedDraft("slow-real");

      const launched = await invoke("run.launch", { draftId: "slow-real" });
      let finalized = false;
      try {
        expect(launched).toMatchObject({ status: "scheduled", result: { phase: "scheduled", operation: "launch" } });
        const live = await waitForDurableStatus("slow-real", (result) => {
          const counts = result["counts"] as { dispatched?: number } | undefined;
          return result["state"] === "running"
            && (result["driver"] as { status?: string } | undefined)?.status === "active"
            && (counts?.dispatched ?? 0) > 0;
        });
        expect(live).toMatchObject({ status: "success", result: { state: "running", cancelRequested: false } });
        const requested = await invoke("run.cancel", { draftId: "slow-real" });
        expect(requested).toMatchObject({
          status: "success",
          result: { phase: "requested", reason: "venue-contention" },
        });
        const draining = await invoke("run.status", { draftId: "slow-real" });
        expect(draining).toMatchObject({ status: "success", result: { state: "running", cancelRequested: true } });

        await Promise.all(afterState.tasks.splice(0));
        const attemptDirectories = readdirSync(join(workspace, "venue", "backend-state", "attempts"));
        expect(attemptDirectories).toHaveLength(1);
        const attemptJournal = readFileSync(join(
          workspace,
          "venue",
          "backend-state",
          "attempts",
          attemptDirectories[0]!,
          "meta",
          "journal.jsonl",
        ), "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
          type: string;
          details: Record<string, unknown>;
        });
        expect(attemptJournal.filter((event) => event.type === "cancel-requested")).toHaveLength(1);
        expect(attemptJournal.find((event) => event.type === "exec-finished")?.details["termSignal"])
          .toMatch(/^SIG(?:TERM|KILL)$/u);
        expect(attemptJournal.find((event) => event.type === "attempt-terminal")?.details["state"])
          .toBe("cancelled");

        const cancelled = await invoke("run.cancel", { draftId: "slow-real" });
        expect(cancelled).toMatchObject({ status: "success", result: { phase: "cancelled" } });
        const retry = await invoke("run.cancel", { draftId: "slow-real" });
        expect(retry).toMatchObject({ status: "success", result: { phase: "cancelled" } });
        const terminal = await invoke("run.status", { draftId: "slow-real" });
        expect(terminal).toMatchObject({
          status: "success",
          result: { state: "closed", cancelRequested: true, counts: { expected: 6 } },
        });
        if (terminal.status !== "success") return;
        const cells = (terminal.result as { cells: Array<{ status: string }> }).cells;
        expect(cells).toHaveLength(6);
        expect(cells.every((cell) => !["pending", "dispatched", "claimed", "delivered"].includes(cell.status))).toBe(true);
        finalized = true;
      } finally {
        if (!finalized) await invoke("run.cancel", { draftId: "slow-real" });
        await Promise.allSettled(afterState.tasks.splice(0));
        const current = await invoke("run.status", { draftId: "slow-real" });
        if (current.status === "success" && (current.result as { state?: string }).state === "running") {
          await invoke("run.cancel", { draftId: "slow-real" });
        }
      }
    },
    240_000,
  );

  test("natural launch, durable status, resume, and collect use the public core operations", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bp32-real-complete-"));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    await invoke("workspace.init");
    await prepareLockedDraft("natural-real");

    const launched = await invoke("run.launch", { draftId: "natural-real" });
    expect(["scheduled", "success"]).toContain(launched.status);
    await Promise.all(afterState.tasks.splice(0));
    const status = await invoke("run.status", { draftId: "natural-real" });
    expect(status).toMatchObject({
      status: "success",
      result: { state: "running", counts: { expected: 6, delivered: 6, judged: 6, failed: 0 } },
    });
    const resumed = await invoke("run.resume", { draftId: "natural-real" });
    expect(["scheduled", "success"]).toContain(resumed.status);
    await Promise.all(afterState.tasks.splice(0));
    const collected = await invoke("run.collect", { draftId: "natural-real" });
    expect(collected).toMatchObject({ status: "success", result: { draft: { state: "closed" } } });
  }, 240_000);
});
