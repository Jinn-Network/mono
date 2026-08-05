import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readAuditEntries } from "../audit/journal.js";
import type { DraftDocument } from "../domain/draft.js";
import { draftPath } from "../workspace/layout.js";
import { runCli } from "./main.js";
import type { CliContext } from "./result.js";

let workspaceDir: string;
let tick: number;

function clock(): string {
  return `2026-08-05T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(dir: string): CliContext {
  return { cwd: dir, clock };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp10-cli-"));
  tick = 0;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

interface JsonEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: { readonly code: string; readonly detail: string; readonly issues?: unknown[] };
}

function parseJson<T>(stdout: string): JsonEnvelope<T> {
  return JSON.parse(stdout) as JsonEnvelope<T>;
}

describe("scripted --json sequence (AC5)", () => {
  test("init -> draft create -> draft update -> draft show -> draft list -> inspect, all --json, exit 0", () => {
    const context = contextFor(workspaceDir);

    const init = runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1", "--json"], context);
    expect(init.exitCode).toBe(0);
    expect(init.stderr).toBe("");
    const initBody = parseJson<{ workspace: unknown }>(init.stdout);
    expect(initBody.ok).toBe(true);

    const create = runCli(
      ["draft", "create", "--workspace", workspaceDir, "--principal", "sponsor-1", "--name", "My Benchmark", "--json"],
      context,
    );
    expect(create.exitCode).toBe(0);
    expect(create.stderr).toBe("");
    const createBody = parseJson<{ draft: DraftDocument }>(create.stdout);
    expect(createBody.ok).toBe(true);
    expect(createBody.result?.draft.draftId).toBe("my-benchmark");
    expect(createBody.result?.draft.state).toBe("draft");

    const patchPath = join(workspaceDir, "patch.json");
    writeFileSync(
      patchPath,
      JSON.stringify({
        replicates: 2,
        arms: [
          { armId: "arm-a", pinning: { harness: "prediction-v1-baseline", isolationPolicy: "unrestricted" } },
          { armId: "arm-b", pinning: { harness: "claude-code", isolationPolicy: "unrestricted" } },
        ],
      }),
    );

    const update = runCli(
      [
        "draft", "update",
        "--workspace", workspaceDir,
        "--principal", "sponsor-1",
        "--draft", "my-benchmark",
        "--file", patchPath,
        "--json",
      ],
      context,
    );
    expect(update.exitCode).toBe(0);
    expect(update.stderr).toBe("");
    const updateBody = parseJson<{ draft: DraftDocument }>(update.stdout);
    expect(updateBody.ok).toBe(true);
    expect(updateBody.result?.draft.spec.replicates).toBe(2);
    expect(updateBody.result?.draft.spec.arms).toHaveLength(2);

    const show = runCli(
      ["draft", "show", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "my-benchmark", "--json"],
      context,
    );
    expect(show.exitCode).toBe(0);
    expect(show.stderr).toBe("");
    const showBody = parseJson<{ draft: DraftDocument }>(show.stdout);
    expect(showBody.ok).toBe(true);
    expect(showBody.result?.draft.draftId).toBe("my-benchmark");

    const list = runCli(["draft", "list", "--workspace", workspaceDir, "--principal", "sponsor-1", "--json"], context);
    expect(list.exitCode).toBe(0);
    expect(list.stderr).toBe("");
    const listBody = parseJson<{ drafts: Array<{ draftId: string }> }>(list.stdout);
    expect(listBody.ok).toBe(true);
    expect(listBody.result?.drafts.map((draft) => draft.draftId)).toContain("my-benchmark");

    const inspect = runCli(
      ["inspect", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "my-benchmark", "--json"],
      context,
    );
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stderr).toBe("");
    const inspectBody = parseJson<{
      inspection: {
        arms: Array<{ armId: string; pinning: Record<string, unknown> }>;
        assurance: { resolved: unknown };
      };
    }>(inspect.stdout);
    expect(inspectBody.ok).toBe(true);
    expect(inspectBody.result?.inspection.arms).toHaveLength(2);
    expect(inspectBody.result?.inspection.arms[0]).toMatchObject({
      armId: "arm-a",
      pinning: { harness: "prediction-v1-baseline", isolationPolicy: "unrestricted" },
    });
    expect(inspectBody.result?.inspection.assurance.resolved).toBeDefined();

    // The audit side of the same sequence (AC5 continued): exactly 6 ordered, attributed entries.
    const entries = readAuditEntries(workspaceDir);
    expect(entries).toHaveLength(6);
    expect(entries.map((entry) => entry.action)).toEqual([
      "init",
      "draft.create",
      "draft.update",
      "draft.get",
      "draft.list",
      "draft.inspect",
    ]);
    for (const entry of entries) {
      expect(entry.outcome).toBe("ok");
      expect(entry.actor).toBe("sponsor-1");
    }
  });
});

describe("unknown verb", () => {
  test("--json: exit 2, envelope {ok:false, error:{code:'invalid-invocation'}}", () => {
    const result = runCli(["frobnicate", "--json"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
  });

  test("without --json: the message goes to stderr, stdout is empty", () => {
    const result = runCli(["frobnicate"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr).toContain("frobnicate");
  });
});

describe("unknown flag", () => {
  test("draft list --json --frobnicate x -> exit 2, invalid-invocation", () => {
    const result = runCli(["draft", "list", "--json", "--frobnicate", "x"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(2);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
  });
});

describe("missing --principal", () => {
  test("exit 2, invalid-invocation", () => {
    const result = runCli(["init", "--workspace", workspaceDir, "--json"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(2);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
  });
});

describe("authority", () => {
  test("a non-member principal listing drafts is refused authority-denied", () => {
    const context = contextFor(workspaceDir);
    runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);

    const result = runCli(
      ["draft", "list", "--json", "--workspace", workspaceDir, "--principal", "stranger"],
      context,
    );
    expect(result.exitCode).toBe(3);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("authority-denied");
  });
});

describe("locked draft", () => {
  test("draft update against a locked draft refuses illegal-transition, exit 1", () => {
    const context = contextFor(workspaceDir);
    runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);
    runCli(["draft", "create", "--workspace", workspaceDir, "--principal", "sponsor-1", "--name", "Locked"], context);

    const path = draftPath(workspaceDir, "locked");
    const document = JSON.parse(readFileSync(path, "utf8")) as DraftDocument;
    writeFileSync(path, JSON.stringify({ ...document, state: "locked" }, null, 2));

    const patchPath = join(workspaceDir, "lock-patch.json");
    writeFileSync(patchPath, JSON.stringify({ replicates: 3 }));

    const result = runCli(
      [
        "draft", "update",
        "--workspace", workspaceDir,
        "--principal", "sponsor-1",
        "--draft", "locked",
        "--file", patchPath,
        "--json",
      ],
      context,
    );
    expect(result.exitCode).toBe(1);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("illegal-transition");
  });
});

describe("validation", () => {
  test("a patch with an unknown key refuses validation, carrying issues", () => {
    const context = contextFor(workspaceDir);
    runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);
    runCli(["draft", "create", "--workspace", workspaceDir, "--principal", "sponsor-1", "--name", "Val"], context);

    const patchPath = join(workspaceDir, "bad-patch.json");
    writeFileSync(patchPath, JSON.stringify({ notARealField: true }));

    const result = runCli(
      [
        "draft", "update",
        "--workspace", workspaceDir,
        "--principal", "sponsor-1",
        "--draft", "val",
        "--file", patchPath,
        "--json",
      ],
      context,
    );
    expect(result.exitCode).toBe(1);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("validation");
    expect(body.error?.issues?.length).toBeGreaterThan(0);
  });
});

describe("help", () => {
  test("help --json -> exit 0, {ok:true, result:{usage}}", () => {
    const result = runCli(["help", "--json"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const body = parseJson<{ usage: string }>(result.stdout);
    expect(body.ok).toBe(true);
    expect(typeof body.result?.usage).toBe("string");
    expect(body.result?.usage.length).toBeGreaterThan(0);
  });

  test("no words at all also produces the usage envelope in --json mode", () => {
    const result = runCli(["--json"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(0);
    const body = parseJson<{ usage: string }>(result.stdout);
    expect(body.ok).toBe(true);
  });

  test("help without --json prints usage on stdout, stderr empty", () => {
    const result = runCli(["help"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
  });

  test("no arguments at all prints usage on stdout", () => {
    const result = runCli([], contextFor(workspaceDir));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
