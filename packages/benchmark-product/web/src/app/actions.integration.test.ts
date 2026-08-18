import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GuiActionState } from "@/lib/action-state";
import {
  AGENT_DATA_ENV,
  ANCHOR_PROVIDERS_ENV,
  ENABLE_TEST_CONTROLS_ENV,
  PRINCIPAL_ENV,
  PUBLICATION_PUBLIC_BASE_URL_ENV,
  readRunDriverTestingDeps,
  readProductServerConfiguration,
  openAIConnectionReadiness,
  TEST_SOLVE_DELAY_MS_ENV,
  WORKSPACE_ENV,
} from "@/lib/server/product-context";
import { GUI_SERVER_ACTIONS } from "@/lib/server/gui-action-registry";
import { agentProfileArmAddAction } from "@/app/actions";
import { executeOperation } from "@/lib/server/action-support";
import { executeBackgroundOperation } from "@/lib/server/background-operation";
import { loadAgentProfilesForGui, loadDraftView, loadResultsView, loadWorkspaceView } from "@/lib/server/view-models";
import { storeAgentProfile } from "@colophon-claims/core";

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
const agentDataDir = join(tmpdir(), "colophon-web-agent-data-test");

function form(fields: Readonly<Record<string, string>> = {}): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function expectRecursivelyPlain(value: unknown, path = "action result"): void {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    expect(Object.getPrototypeOf(value), path).toBe(Array.prototype);
    value.forEach((entry, index) => expectRecursivelyPlain(entry, `${path}[${index}]`));
    return;
  }
  expect(typeof value, path).toBe("object");
  expect(Object.getPrototypeOf(value), `${path} prototype`).toBe(Object.prototype);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    expectRecursivelyPlain(entry, `${path}.${key}`);
  }
}

async function invoke(action: keyof typeof GUI_SERVER_ACTIONS, fields: Readonly<Record<string, string>> = {}) {
  return GUI_SERVER_ACTIONS[action](IDLE, form(fields));
}

afterEach(async () => {
  await Promise.allSettled(afterState.tasks.splice(0));
  delete process.env[WORKSPACE_ENV];
  delete process.env[AGENT_DATA_ENV];
  delete process.env[PRINCIPAL_ENV];
  delete process.env[ENABLE_TEST_CONTROLS_ENV];
  delete process.env[TEST_SOLVE_DELAY_MS_ENV];
  delete process.env[PUBLICATION_PUBLIC_BASE_URL_ENV];
  delete process.env[ANCHOR_PROVIDERS_ENV];
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  rmSync(agentDataDir, { recursive: true, force: true });
  revalidatePathMock.mockClear();
}, 120_000);

beforeEach(() => {
  process.env[AGENT_DATA_ENV] = agentDataDir;
});

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
  test("recursive plain-value assertion rejects nested class and null-prototype values", () => {
    class NonPlainReceipt {}
    expect(() => expectRecursivelyPlain({ nested: [new NonPlainReceipt()] })).toThrow();
    expect(() => expectRecursivelyPlain({ nested: Object.create(null) })).toThrow();
    expect(() => expectRecursivelyPlain({ nested: [{ digest: "a".repeat(64) }] })).not.toThrow();
  });

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
    const view = loadWorkspaceView();
    expect(view).toMatchObject({ ok: false });
    expect(JSON.stringify(view)).not.toContain(WORKSPACE_ENV);
    expect(JSON.stringify(view)).not.toContain(PRINCIPAL_ENV);
  });

  test("configuration retains agent data server-side and never exposes ambient secrets", () => {
    const workspace = mkdtempSync(join(tmpdir(), "bp31-context-"));
    workspaces.push(workspace);
    const configuration = readProductServerConfiguration({
      [WORKSPACE_ENV]: workspace,
      [AGENT_DATA_ENV]: agentDataDir,
      [PRINCIPAL_ENV]: "sponsor-1",
      PRIVATE_SIGNING_KEY: "-----BEGIN PRIVATE KEY-----",
    });
    expect(configuration).toEqual({ workspaceDir: workspace, agentDataDir, principal: "sponsor-1" });
    expect(JSON.stringify(configuration)).not.toContain("PRIVATE KEY");
  });

  test("refuses a missing or relative agent-data path", () => {
    const workspace = mkdtempSync(join(tmpdir(), "bp-agent-data-"));
    workspaces.push(workspace);
    expect(() => readProductServerConfiguration({ [WORKSPACE_ENV]: workspace, [PRINCIPAL_ENV]: "sponsor-1" }))
      .toThrow(AGENT_DATA_ENV);
    expect(() => readProductServerConfiguration({ [WORKSPACE_ENV]: workspace, [AGENT_DATA_ENV]: "relative", [PRINCIPAL_ENV]: "sponsor-1" }))
      .toThrow(`${AGENT_DATA_ENV} must be absolute`);
  });

  test("GUI publication configure requires and exclusively uses the server-owned archive mount", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "publication-server-authority-"));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    await invoke("workspace.init");
    await prepareLockedDraft("server-publication");

    const unavailable = await invoke("publication.configure", { draftId: "server-publication", publicBaseUrl: "https://attacker.example/archive" });
    expect(unavailable).toMatchObject({ status: "error", error: { code: "invalid-invocation" } });

    process.env[PUBLICATION_PUBLIC_BASE_URL_ENV] = "https://public.example/publication/";
    const configured = await invoke("publication.configure", { draftId: "server-publication", publicBaseUrl: "https://attacker.example/archive" });
    expect(configured).toMatchObject({ status: "success", result: { publicBaseUrl: "https://public.example/publication" } });
    expect(JSON.stringify(configured)).not.toContain("attacker.example");
  }, 120_000);

  test("GUI anchoring configure requires and exclusively uses the server-owned anchor providers", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "anchoring-server-authority-"));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    await invoke("workspace.init");

    // Nothing configured server-side: the action is unavailable, whatever the form carries.
    const unavailable = await invoke("anchoring.configure", { endpoint: "https://attacker.example/tsr" });
    expect(unavailable).toMatchObject({ status: "error", error: { code: "invalid-invocation" } });

    process.env[ANCHOR_PROVIDERS_ENV] = JSON.stringify([
      { providerProfile: "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1", endpoint: "https://tsa.example/tsr" },
    ]);
    const configured = await invoke("anchoring.configure", { endpoint: "https://attacker.example/tsr" });
    expect(configured).toMatchObject({
      status: "success",
      result: {
        anchoring: [{
          providerProfile: "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
          endpoint: "https://tsa.example/tsr",
        }],
      },
    });
    expect(JSON.stringify(configured)).not.toContain("attacker.example");

    // Turning anchoring off is the one anchoring decision the browser may make on its own.
    const cleared = await invoke("anchoring.configure", { clear: "clear-anchoring" });
    expect(cleared).toMatchObject({ status: "success", result: { anchoring: [] } });
  }, 120_000);

  test("GUI anchor refuses an unknown subject, and the typed venue refusal when nothing is configured", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "anchor-subject-"));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    await invoke("workspace.init");
    await prepareLockedDraft("anchor-subject");

    expect(await invoke("run.anchor", { draftId: "anchor-subject", subject: "report" }))
      .toMatchObject({ status: "error", error: { code: "invalid-invocation" } });
    expect(await invoke("run.anchor", { draftId: "anchor-subject", subject: "lock" }))
      .toMatchObject({ status: "error", error: { code: "venue-unavailable" } });
  }, 120_000);

  test("GUI signed Report v2 refuses a persisted locator that differs from the server-owned mount", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "publication-report-server-authority-"));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    process.env[PUBLICATION_PUBLIC_BASE_URL_ENV] = "https://public.example/archive-a";
    await invoke("workspace.init");
    await prepareLockedDraft("report-server-authority");
    expect(await invoke("publication.configure", { draftId: "report-server-authority" })).toMatchObject({ status: "success" });

    process.env[PUBLICATION_PUBLIC_BASE_URL_ENV] = "https://public.example/archive-b";
    const refused = await invoke("publication.report", {
      draftId: "report-server-authority",
      consent: "publish-signed-report-v2",
    });
    expect(refused).toMatchObject({ status: "error", error: { code: "invalid-invocation" } });
    expect(JSON.stringify(refused)).not.toContain("archive-a");
    expect(JSON.stringify(refused)).not.toContain("archive-b");
  }, 120_000);

  test("OpenAI readiness exposes only a configured bit", () => {
    expect(openAIConnectionReadiness({})).toBe("not-configured");
    expect(openAIConnectionReadiness({ BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE: "/private/path/key" })).toBe("configured");
    expect(JSON.stringify(openAIConnectionReadiness({ BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE: "/private/path/key" })))
      .not.toContain("/private/path/key");
  });

  test("guided agent Arm setup projects local readiness safely and seals only credential-free pinning", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bp-guided-agent-"));
    const privateSentinel = "PRIVATE_AGENT_PATH_SENTINEL";
    const executable = join(workspace, `private-${privateSentinel}-codex`);
    workspaces.push(workspace);
    writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo 'codex-cli 0.1.0'\nelse\n  echo codex\nfi\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    storeAgentProfile(agentDataDir, {
      format: "colophon-agent/1",
      agentId: "codex-main",
      adapter: "codex",
      executable: {
        path: executable,
        sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
        version: "0.1.0",
      },
      model: "gpt-5.6",
      effort: "high",
      network: "provider-required",
    });
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    expect(await invoke("workspace.init")).toMatchObject({ status: "success" });
    expect(await invoke("draft.create", { draftId: "guided-agent", name: "Guided agent" })).toMatchObject({ status: "success" });

    const profiles = loadAgentProfilesForGui(agentDataDir);
    expect(profiles).toEqual({
      status: "available",
      profiles: [{ agentId: "codex-main", adapter: "codex", model: "gpt-5.6", effort: "high", readiness: "needs-credential" }],
    });
    expect(JSON.stringify(profiles)).not.toContain(executable);
    expect(JSON.stringify(profiles)).not.toContain(privateSentinel);

    const action = await agentProfileArmAddAction(IDLE, form({
      draftId: "guided-agent",
      agentId: "codex-main",
      armId: "codex-high",
    }));
    expect(action).toMatchObject({ status: "success" });
    expect(JSON.stringify(action)).not.toContain(executable);
    const arms = await invoke("arm.list", { draftId: "guided-agent" });
    expect(arms).toMatchObject({
      status: "success",
      result: { arms: [{ armId: "codex-high", pinning: { harness: { id: "codex", version: "0.1.0" }, model: { id: "gpt-5.6" }, effort: "high" } }] },
    });
    expect(JSON.stringify(arms)).not.toContain(executable);
    expect(JSON.stringify(arms)).not.toContain("credential");
  });

  test("the browser workspace view never exposes its absolute server path or ambient secret sentinel", () => {
    const sentinel = "BP50_PRIVATE_KEY_SENTINEL_7c8ea9";
    const workspace = mkdtempSync(join(tmpdir(), `bp50-${sentinel}-`));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    process.env.BP50_PRIVATE_KEY = sentinel;
    try {
      const view = loadWorkspaceView();
      expect(view.ok).toBe(true);
      expect(JSON.stringify(view)).not.toContain(workspace);
      expect(JSON.stringify(view)).not.toContain(sentinel);
      expect(view).toMatchObject({ ok: true, configuration: { principal: "sponsor-1" } });
    } finally {
      delete process.env.BP50_PRIVATE_KEY;
    }
  });

  test("browser view loaders redact hostile typed-error detail and issue paths", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bp50-view-redaction-"));
    workspaces.push(workspace);
    process.env[WORKSPACE_ENV] = workspace;
    process.env[PRINCIPAL_ENV] = "sponsor-1";
    expect(await invoke("workspace.init")).toMatchObject({ status: "success" });

    const sentinel = "BP50_PRIVATE_DRAFT_SENTINEL";
    const view = loadDraftView(sentinel);
    expect(view).toMatchObject({
      ok: true,
      draft: { ok: false, error: { code: "not-found" } },
      inspection: { ok: false, error: { code: "not-found" } },
      arms: { ok: false, error: { code: "not-found" } },
    });
    expect(JSON.stringify(view)).not.toContain(sentinel);
    expect(JSON.stringify(view)).not.toContain(workspace);
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
      expect(JSON.stringify(outcome)).toContain("detail");
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
    expect(JSON.stringify(denied)).not.toContain(ENABLE_TEST_CONTROLS_ENV);
    expect(JSON.stringify(denied)).not.toContain(TEST_SOLVE_DELAY_MS_ENV);
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
        const reported = await invoke("run.report", { draftId: "slow-real" });
        expect(reported).toMatchObject({ status: "success", result: { state: "reported" } });
        const published = await invoke("run.publish", { draftId: "slow-real" });
        expect(published).toMatchObject({
          status: "success",
          result: {
            state: "published-bundle",
            checks: ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"],
          },
        });
        const publishedResult = (published as { result: { bundleRelativePath: string } }).result;
        expect(existsSync(join(workspace, ...publishedResult.bundleRelativePath.split("/"), "verification", "cancel-requested.json"))).toBe(true);
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

  test("natural launch through results, report reload, and verification uses the public core operations", async () => {
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

    const results = await invoke("run.results", { draftId: "natural-real" });
    expectRecursivelyPlain(results);
    expect(results).toMatchObject({
      status: "success",
      result: { draftId: "natural-real", runOutcome: "complete", expected: 6, judged: 6 },
    });
    expect(JSON.stringify(results)).not.toContain("cells");
    const reported = await invoke("run.report", { draftId: "natural-real" });
    expectRecursivelyPlain(reported);
    expect(reported).toMatchObject({
      status: "success",
      result: { draftId: "natural-real", state: "reported", preregistered: true },
    });
    expect(JSON.stringify(reported)).not.toContain("claimPackage");
    expect(revalidatePathMock).toHaveBeenCalledWith("/workspace/natural-real/results");
    const reloaded = await invoke("run.results", { draftId: "natural-real" });
    expect(reloaded).toMatchObject({
      status: "success",
      result: { draftId: "natural-real", runOutcome: "complete", expected: 6, judged: 6 },
    });
    const reloadedView = loadResultsView("natural-real");
    expect(reloadedView).toMatchObject({
      ok: true,
      results: {
        ok: true,
        result: {
          report: {
            verification: { status: "not-run" },
            claimPackage: { scope: { draftId: "natural-real" }, completeness: { expected: 6, judged: 6 } },
          },
        },
      },
    });
    const verified = await invoke("run.verify", { draftId: "natural-real" });
    expectRecursivelyPlain(verified);
    expect(verified).toMatchObject({
      status: "success",
      result: {
        checks: ["matrix-rederivation", "report-verification", "claim-consistency"],
      },
    });
    const published = await invoke("run.publish", { draftId: "natural-real" });
    expectRecursivelyPlain(published);
    expect(published).toMatchObject({
      status: "success",
      result: {
        draftId: "natural-real",
        state: "published-bundle",
        checks: ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"],
      },
    });
    const publishedResult = (published as { result: { bundleIdentity: string; bundleRelativePath: string } }).result;
    expect(publishedResult.bundleRelativePath).toBe(`artifacts/natural-real/public-bundles/${publishedResult.bundleIdentity}`);
    expect(JSON.stringify(published)).not.toContain(workspace);
    const reverifiedBundle = await invoke("run.publish", { draftId: "natural-real" });
    expect(reverifiedBundle).toMatchObject({
      status: "success",
      result: { state: "published-bundle", bundleIdentity: (published as { result: { bundleIdentity: string } }).result.bundleIdentity },
    });
  }, 240_000);
});
