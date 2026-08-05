import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readAuditEntries } from "../audit/journal.js";
import type { DraftDocument } from "../domain/draft.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
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
  readonly error?: { readonly code: string; readonly detail: string; readonly issues?: ReadonlyArray<{ readonly path: string; readonly message: string }> };
}

function parseJson<T>(stdout: string): JsonEnvelope<T> {
  return JSON.parse(stdout) as JsonEnvelope<T>;
}

/** Runs `draft create --json` and returns the created draft's id, failing loudly on refusal. */
async function createDraftId(context: CliContext, name: string): Promise<string> {
  const result = await runCli(
    ["draft", "create", "--workspace", workspaceDir, "--principal", "sponsor-1", "--name", name, "--json"],
    context,
  );
  const body = parseJson<{ draft: DraftDocument }>(result.stdout);
  if (!body.ok || body.result === undefined) throw new Error(`draft create failed: ${result.stdout}`);
  return body.result.draft.draftId;
}

describe("scripted --json sequence (AC5)", () => {
  test("init -> draft create -> draft update -> draft show -> draft list -> inspect, all --json, exit 0", async () => {
    const context = contextFor(workspaceDir);

    const init = await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1", "--json"], context);
    expect(init.exitCode).toBe(0);
    expect(init.stderr).toBe("");
    const initBody = parseJson<{ workspace: unknown }>(init.stdout);
    expect(initBody.ok).toBe(true);

    const create = await runCli(
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

    const update = await runCli(
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

    const show = await runCli(
      ["draft", "show", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "my-benchmark", "--json"],
      context,
    );
    expect(show.exitCode).toBe(0);
    expect(show.stderr).toBe("");
    const showBody = parseJson<{ draft: DraftDocument }>(show.stdout);
    expect(showBody.ok).toBe(true);
    expect(showBody.result?.draft.draftId).toBe("my-benchmark");

    const list = await runCli(["draft", "list", "--workspace", workspaceDir, "--principal", "sponsor-1", "--json"], context);
    expect(list.exitCode).toBe(0);
    expect(list.stderr).toBe("");
    const listBody = parseJson<{ drafts: Array<{ draftId: string }> }>(list.stdout);
    expect(listBody.ok).toBe(true);
    expect(listBody.result?.drafts.map((draft) => draft.draftId)).toContain("my-benchmark");

    const inspect = await runCli(
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
  test("--json: exit 2, envelope {ok:false, error:{code:'invalid-invocation'}}", async () => {
    const result = await runCli(["frobnicate", "--json"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
  });

  test("without --json: the message goes to stderr, stdout is empty", async () => {
    const result = await runCli(["frobnicate"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr).toContain("frobnicate");
  });
});

describe("unknown flag", () => {
  test("draft list --json --frobnicate x -> exit 2, invalid-invocation", async () => {
    const result = await runCli(["draft", "list", "--json", "--frobnicate", "x"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(2);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
  });
});

describe("missing --principal", () => {
  test("exit 2, invalid-invocation", async () => {
    const result = await runCli(["init", "--workspace", workspaceDir, "--json"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(2);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
  });
});

describe("authority", () => {
  test("a non-member principal listing drafts is refused authority-denied", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);

    const result = await runCli(
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
  test("draft update against a locked draft refuses illegal-transition, exit 1", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);
    await runCli(["draft", "create", "--workspace", workspaceDir, "--principal", "sponsor-1", "--name", "Locked"], context);

    const path = draftPath(workspaceDir, "locked");
    const document = JSON.parse(readFileSync(path, "utf8")) as DraftDocument;
    writeFileSync(path, JSON.stringify({ ...document, state: "locked" }, null, 2));

    const patchPath = join(workspaceDir, "lock-patch.json");
    writeFileSync(patchPath, JSON.stringify({ replicates: 3 }));

    const result = await runCli(
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
  test("a patch with an unknown key refuses validation, carrying issues", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);
    await runCli(["draft", "create", "--workspace", workspaceDir, "--principal", "sponsor-1", "--name", "Val"], context);

    const patchPath = join(workspaceDir, "bad-patch.json");
    writeFileSync(patchPath, JSON.stringify({ notARealField: true }));

    const result = await runCli(
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
  test("help --json -> exit 0, {ok:true, result:{usage}}", async () => {
    const result = await runCli(["help", "--json"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const body = parseJson<{ usage: string }>(result.stdout);
    expect(body.ok).toBe(true);
    expect(typeof body.result?.usage).toBe("string");
    expect(body.result?.usage.length).toBeGreaterThan(0);
  });

  test("no words at all also produces the usage envelope in --json mode", async () => {
    const result = await runCli(["--json"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(0);
    const body = parseJson<{ usage: string }>(result.stdout);
    expect(body.ok).toBe(true);
  });

  test("help without --json prints usage on stdout, stderr empty", async () => {
    const result = await runCli(["help"], contextFor(workspaceDir));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
  });

  test("no arguments at all prints usage on stdout", async () => {
    const result = await runCli([], contextFor(workspaceDir));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

describe("sample init (AC1, CLI-level)", () => {
  test("init -> draft create -> sample init --json seals a benchmark with >=2 tasks; the bytes are retrievable; a re-run refuses conflict", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);
    const draftId = await createDraftId(context, "Sampled");

    const first = await runCli(
      ["sample", "init", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
      context,
    );
    expect(first.exitCode).toBe(0);
    const firstBody = parseJson<{ benchmarkSha256: string; tasks: unknown[] }>(first.stdout);
    expect(firstBody.ok).toBe(true);
    expect(firstBody.result?.benchmarkSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((firstBody.result?.tasks.length ?? 0) >= 2).toBe(true);

    // The sealed bytes are actually retrievable from the workspace's store — a
    // non-throwing call proves the digest the envelope reported is really stored.
    expect(() => getSealedBytes(workspaceDir, firstBody.result!.benchmarkSha256)).not.toThrow();

    // A second `sample init` on the same draft is refused-typed, not idempotent:
    // attachBenchmarkToDraft's "already has a benchmark" rule is a hard conflict,
    // not a silent no-op re-attach.
    const second = await runCli(
      ["sample", "init", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
      context,
    );
    expect(second.exitCode).toBe(1);
    const secondBody = parseJson<never>(second.stdout);
    expect(secondBody.ok).toBe(false);
    expect(secondBody.error?.code).toBe("conflict");
  });
});

describe("scripted arm + inspect flow (AC4)", () => {
  test("two arms (one naming a harness with no launcher) plus inspect show exact pinning, benchmark items, and resolved assurance primitives", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);
    const draftId = await createDraftId(context, "Arms And Inspect");

    const sample = await runCli(
      ["sample", "init", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
      context,
    );
    expect(sample.exitCode).toBe(0);

    const baselinePinning = { harness: { id: "prediction-v1-baseline" }, isolationPolicy: "unrestricted" };
    // "sample-uniform" names no launcher anywhere in this repo — arm definition
    // is pure data and must succeed regardless of whether anything can run it.
    const sampleUniformPinning = { harness: { id: "sample-uniform" }, isolationPolicy: "unrestricted" };

    const armOne = await runCli(
      [
        "arm", "add",
        "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId,
        "--arm", "baseline", "--pinning", JSON.stringify(baselinePinning),
        "--json",
      ],
      context,
    );
    expect(armOne.exitCode).toBe(0);

    const armTwo = await runCli(
      [
        "arm", "add",
        "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId,
        "--arm", "sample-uniform", "--pinning", JSON.stringify(sampleUniformPinning),
        "--json",
      ],
      context,
    );
    expect(armTwo.exitCode).toBe(0);

    const list = await runCli(
      ["arm", "list", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
      context,
    );
    expect(list.exitCode).toBe(0);
    const listBody = parseJson<{
      arms: Array<{ armId: string; pinning: unknown }>;
      warnings: unknown[];
    }>(list.stdout);
    expect(listBody.result?.arms).toEqual([
      { armId: "baseline", pinning: baselinePinning },
      { armId: "sample-uniform", pinning: sampleUniformPinning },
    ]);
    expect(listBody.result?.warnings).toEqual([]);

    const inspect = await runCli(
      ["inspect", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
      context,
    );
    expect(inspect.exitCode).toBe(0);
    const inspectBody = parseJson<{
      inspection: {
        arms: Array<{ armId: string; pinning: unknown }>;
        benchmark: { itemCount: number; items: Array<{ evaluationSha256?: string; stored: boolean }> };
        assurance: { resolved: unknown };
      };
    }>(inspect.stdout);
    const inspection = inspectBody.result!.inspection;
    expect(inspection.arms).toEqual([
      { armId: "baseline", pinning: baselinePinning },
      { armId: "sample-uniform", pinning: sampleUniformPinning },
    ]);
    expect(inspection.benchmark.itemCount).toBeGreaterThanOrEqual(2);
    expect(inspection.benchmark.items.length).toBe(inspection.benchmark.itemCount);
    for (const item of inspection.benchmark.items) {
      expect(item.stored).toBe(true);
      expect(item.evaluationSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    // Direct-check primitives — the DraftSpecDefaults' assurance preset (spec §6).
    expect(inspection.assurance.resolved).toEqual({
      independence: "disclosed",
      minVerdicts: 1,
      distinctEvaluator: false,
      verdictRule: "sole",
    });
  });
});

describe("arm add — duplicate pinning is a warning, not a refusal", () => {
  test("two arms with identical pinning: exit 0, envelope carries a duplicate-pinning warning naming both arm ids", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);
    const draftId = await createDraftId(context, "Dup Pinning");

    const pinning = JSON.stringify({ harness: { id: "prediction-v1-baseline" }, isolationPolicy: "unrestricted" });
    await runCli(
      [
        "arm", "add",
        "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId,
        "--arm", "baseline", "--pinning", pinning, "--json",
      ],
      context,
    );

    const second = await runCli(
      [
        "arm", "add",
        "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId,
        "--arm", "baseline-copy", "--pinning", pinning, "--json",
      ],
      context,
    );
    expect(second.exitCode).toBe(0);
    const body = parseJson<{ warnings: Array<{ code: string; armIds: string[]; detail: string }> }>(second.stdout);
    expect(body.ok).toBe(true);
    expect(body.result?.warnings).toEqual([
      { code: "duplicate-pinning", armIds: ["baseline", "baseline-copy"], detail: expect.any(String) },
    ]);
  });
});

// The platform's own public importer fixture (packages/benchmarking/interop/fixtures/swebench/row.json),
// copied verbatim from ../intake/swebench.test.ts's GOLDEN_ROW.
const GOLDEN_ROW = {
  instance_id: "swe-rebench-2024-00042",
  repo: "psf/requests",
  base_commit: "d8bdd423ab2df9f87b7975cdb32b31f3002a20c0",
  problem_statement: "Fix the connection pool leak when retries are exhausted.",
  language: "python",
  image: {
    uri: "https://example.org/images/swe-rebench-runner:2024-00042",
    digest: { sha256: "e8d6cfe4f52e87a1292f3897bf0bea28e4bde32703e6792bb9b1bc60d3024817" },
  },
  testMaterial: [{ uri: "https://example.org/tests/swe-rebench-2024-00042/test_pool.py" }],
  parser: {
    id: "jinn.parser.pytest-json-report",
    version: "1.0.0",
    digest: "sha256:d2136b44c86f551b2494d616a8ee7afd58e6f90681f1beb84441113154a13897",
  },
  transitions: {
    failToPass: ["test_pool.py::test_retry_releases_connection"],
    passToPass: ["test_pool.py::test_basic_get"],
  },
  timeout: 1800,
};

describe("import swebench (CLI)", () => {
  test("a rows file imports into a fresh draft; a file with the row duplicated refuses validation naming benchmark-item-distinctness", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);
    const draftId = await createDraftId(context, "Import Target");

    const rowsPath = join(workspaceDir, "rows.json");
    writeFileSync(rowsPath, JSON.stringify([GOLDEN_ROW]));

    const imported = await runCli(
      [
        "import", "swebench",
        "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId,
        "--file", rowsPath, "--json",
      ],
      context,
    );
    expect(imported.exitCode).toBe(0);
    const importedBody = parseJson<{ benchmarkSha256: string }>(imported.stdout);
    expect(importedBody.ok).toBe(true);
    expect(importedBody.result?.benchmarkSha256).toMatch(/^[a-f0-9]{64}$/);

    const dupDraftId = await createDraftId(context, "Dup Rows");
    const dupRowsPath = join(workspaceDir, "dup-rows.json");
    writeFileSync(dupRowsPath, JSON.stringify([GOLDEN_ROW, GOLDEN_ROW]));

    const dupImport = await runCli(
      [
        "import", "swebench",
        "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", dupDraftId,
        "--file", dupRowsPath, "--json",
      ],
      context,
    );
    expect(dupImport.exitCode).toBe(1);
    const dupBody = parseJson<never>(dupImport.stdout);
    expect(dupBody.ok).toBe(false);
    expect(dupBody.error?.code).toBe("validation");
    expect(dupBody.error?.issues?.some((issue) => issue.path === "benchmark-item-distinctness")).toBe(true);
  });
});

describe("authority verbs (CLI)", () => {
  test("grant onboards a member; self-escalation is denied; revoke narrows; show reads; a bad --role refuses invalid-invocation", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);

    const grant = await runCli(
      [
        "authority", "grant",
        "--workspace", workspaceDir, "--principal", "sponsor-1",
        "--grantee", "agent-1", "--operations", "report", "--json",
      ],
      context,
    );
    expect(grant.exitCode).toBe(0);
    const grantBody = parseJson<{ policy: { principals: Array<{ id: string }> } }>(grant.stdout);
    expect(grantBody.ok).toBe(true);
    expect(grantBody.result?.policy.principals.map((principal) => principal.id)).toEqual(
      expect.arrayContaining(["sponsor-1", "agent-1"]),
    );

    const selfEscalation = await runCli(
      [
        "authority", "grant",
        "--workspace", workspaceDir, "--principal", "agent-1",
        "--grantee", "agent-1", "--operations", "publish", "--json",
      ],
      context,
    );
    expect(selfEscalation.exitCode).toBe(3);
    const selfBody = parseJson<never>(selfEscalation.stdout);
    expect(selfBody.ok).toBe(false);
    expect(selfBody.error?.code).toBe("authority-denied");

    const revoke = await runCli(
      [
        "authority", "revoke",
        "--workspace", workspaceDir, "--principal", "sponsor-1",
        "--grantee", "agent-1", "--operations", "report",
        "--json",
      ],
      context,
    );
    expect(revoke.exitCode).toBe(0);
    const revokeBody = parseJson<{ policy: { principals: Array<{ id: string; grants: string[] }> } }>(revoke.stdout);
    expect(revokeBody.result?.policy.principals.find((principal) => principal.id === "agent-1")?.grants).toEqual([]);

    const show = await runCli(
      ["authority", "show", "--workspace", workspaceDir, "--principal", "agent-1", "--json"],
      context,
    );
    expect(show.exitCode).toBe(0);
    const showBody = parseJson<{ policy: { principals: unknown[] } }>(show.stdout);
    expect(showBody.ok).toBe(true);
    expect(showBody.result?.policy.principals.length).toBeGreaterThanOrEqual(2);

    const badRole = await runCli(
      [
        "authority", "grant",
        "--workspace", workspaceDir, "--principal", "sponsor-1",
        "--grantee", "agent-2", "--role", "not-a-role", "--json",
      ],
      context,
    );
    expect(badRole.exitCode).toBe(2);
    const badRoleBody = parseJson<never>(badRole.stdout);
    expect(badRoleBody.ok).toBe(false);
    expect(badRoleBody.error?.code).toBe("invalid-invocation");
  });
});

describe("arm flag validation", () => {
  test("--pinning not-json refuses invalid-invocation", async () => {
    const context = contextFor(workspaceDir);
    await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);
    const draftId = await createDraftId(context, "Bad Pinning");

    const result = await runCli(
      [
        "arm", "add",
        "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId,
        "--arm", "baseline", "--pinning", "not-json", "--json",
      ],
      context,
    );
    expect(result.exitCode).toBe(2);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
  });

  test("an unknown flag on a new verb refuses invalid-invocation", async () => {
    const result = await runCli(
      [
        "arm", "list",
        "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "x",
        "--frobnicate", "y", "--json",
      ],
      contextFor(workspaceDir),
    );
    expect(result.exitCode).toBe(2);
    const body = parseJson<never>(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("invalid-invocation");
  });
});
