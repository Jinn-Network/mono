import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import {
  HARBOR_SELECTION_SCHEMA,
  INSPECT_SELECTION_SCHEMA,
  METHOD_CATALOG,
  TERMINAL_BENCH_2_SELECTION_SCHEMA,
  TERMINAL_BENCH_2_1_SELECTION_SCHEMA,
  coverageFromSlice,
  knownCatalogIds,
  listMethodCatalog,
  resolveMethodOperand,
} from "./method-catalog.js";

let root: string;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function cwd(): string {
  root = mkdtempSync(join(tmpdir(), "method-catalog-"));
  return root;
}

function refuse(run: () => unknown): BenchmarkProductError {
  try {
    run();
  } catch (cause) {
    expect(cause).toBeInstanceOf(BenchmarkProductError);
    return cause as BenchmarkProductError;
  }
  throw new Error("expected refusal");
}

describe("METHOD_CATALOG", () => {
  test("named suites on this tree keep today's protocol ids and implied frameworks", () => {
    expect(METHOD_CATALOG["terminal-bench-2.1"]).toMatchObject({
      protocol: "terminal-bench-2.1",
      framework: "harbor",
      derivedExport: "harbor-hub",
    });
    expect(METHOD_CATALOG["terminal-bench-3.0"]).toMatchObject({
      protocol: "terminal-bench-3.0",
      framework: "harbor",
      derivedExport: "harbor-hub",
    });
    expect(METHOD_CATALOG["swe-bench-verified"]).toMatchObject({
      protocol: "swe-bench-verified",
      framework: "swebench-harness",
      derivedExport: "swebench-predictions",
    });
    expect(METHOD_CATALOG["apex-agents"]).toMatchObject({
      protocol: "apex-agents",
      framework: "archipelago",
      derivedExport: "apex-inspection",
    });
    expect(METHOD_CATALOG["apex-swe-dev"]).toMatchObject({
      protocol: "apex-swe-dev",
      framework: "apex-swe-dev",
      derivedExport: "apex-swe-package",
    });
  });

  test("each row publishes the required host JSON keys, not coverage or ids", () => {
    expect(METHOD_CATALOG["terminal-bench-2.1"].hostKeys).toEqual([
      "executable",
      "registryMetadataPath",
      "datasetRevision",
      "taskMaterialPath",
      "arms",
      "environment",
      "outputs",
    ]);
    expect(METHOD_CATALOG["terminal-bench-3.0"].hostKeys).toEqual([
      "executable",
      "registryMetadataPath",
      "datasetRevision",
      "taskMaterialPath",
      "arms",
      "environment",
      "outputs",
    ]);
    expect(METHOD_CATALOG["swe-bench-verified"].hostKeys).toEqual([
      "executable",
      "registryMetadataPath",
      "arms",
    ]);
    expect(METHOD_CATALOG["apex-agents"].hostKeys).toEqual([
      "executable",
      "registryMetadataPath",
      "arms",
    ]);
    expect(METHOD_CATALOG["apex-swe-dev"].hostKeys).toEqual([
      "apxExecutable",
      "pythonExecutable",
      "registryMetadataPath",
      "integrationTasksDir",
      "observabilityProjectDir",
      "arms",
    ]);
  });
});

describe("listMethodCatalog", () => {
  test("returns five rows in catalog object key order", () => {
    const listed = listMethodCatalog();
    expect(listed).toHaveLength(5);
    expect(listed.map((row) => row.id)).toEqual([
      "terminal-bench-2.1",
      "terminal-bench-3.0",
      "swe-bench-verified",
      "apex-agents",
      "apex-swe-dev",
    ]);
    expect(listed[3]).toMatchObject({
      id: "apex-agents",
      protocol: "apex-agents",
      framework: "archipelago",
      derivedExport: "apex-inspection",
      hostKeys: ["executable", "registryMetadataPath", "arms"],
    });
    expect(knownCatalogIds()).toBe(
      "terminal-bench-2.1, terminal-bench-3.0, swe-bench-verified, apex-agents, apex-swe-dev",
    );
  });
});

describe("coverageFromSlice", () => {
  test("maps the human flag onto the sealed enum without renaming one_task", () => {
    expect(coverageFromSlice("1")).toBe("one_task");
    expect(coverageFromSlice("10")).toBe("ten_task");
    expect(coverageFromSlice("all")).toBe("full");
  });
});

describe("resolveMethodOperand", () => {
  test("catalog id instantiates a preset; slice and host are required", () => {
    const dir = cwd();
    const hostPath = join(dir, "host.json");
    writeFileSync(hostPath, JSON.stringify({ executable: "/bin/harbor" }));
    const resolved = resolveMethodOperand({
      ref: "terminal-bench-2.1",
      cwd: dir,
      slice: "1",
      hostPath,
    });
    expect(resolved).toMatchObject({
      kind: "catalog",
      catalogId: "terminal-bench-2.1",
      protocol: "terminal-bench-2.1",
      coverage: "one_task",
      host: { executable: "/bin/harbor" },
    });
  });

  test("--ids is custom coverage", () => {
    const dir = cwd();
    const hostPath = join(dir, "host.json");
    writeFileSync(hostPath, JSON.stringify({ executable: "/bin/python3" }));
    const resolved = resolveMethodOperand({
      ref: "swe-bench-verified",
      cwd: dir,
      ids: "a,b",
      hostPath,
    });
    expect(resolved).toMatchObject({
      kind: "catalog",
      catalogId: "swe-bench-verified",
      coverage: "custom",
      selectedIds: ["a", "b"],
    });
  });

  test("a method file is a complete document; slice is refused", () => {
    const dir = cwd();
    const filePath = join(dir, "inspect.json");
    writeFileSync(filePath, JSON.stringify({
      schema: INSPECT_SELECTION_SCHEMA,
      taskReference: "task.py@task",
      projectDir: "/tmp/project",
      pythonPath: "/usr/bin/python3",
      arms: [],
    }));
    const resolved = resolveMethodOperand({ ref: filePath, cwd: dir });
    expect(resolved).toMatchObject({
      kind: "file",
      documentKind: "inspect",
      official: false,
    });
    if (resolved.kind !== "file") return;
    expect(resolved.document.taskReference).toBe("task.py@task");
    expect(resolved.document.schema).toBeUndefined();

    const sliced = refuse(() => resolveMethodOperand({ ref: filePath, cwd: dir, slice: "1" }));
    expect(sliced.code).toBe("invalid-invocation");
    expect(sliced.issues[0]?.path).toBe("--slice");
  });

  test("Inspect-shaped JSON without schema still binds as inspect (GUI form)", () => {
    const dir = cwd();
    const filePath = join(dir, "gui-inspect.json");
    writeFileSync(filePath, JSON.stringify({
      taskReference: "task.py@task",
      projectDir: "/tmp/project",
      pythonPath: "/usr/bin/python3",
      arms: [{ armId: "a", model: "mockllm/model" }],
    }));
    expect(resolveMethodOperand({ ref: filePath, cwd: dir })).toMatchObject({
      kind: "file",
      documentKind: "inspect",
      official: false,
    });
  });

  test("Harbor and TB 2.0 files are cousins; official suite schemas still wear the name", () => {
    const dir = cwd();
    const harborPath = join(dir, "harbor.json");
    writeFileSync(harborPath, JSON.stringify({ schema: HARBOR_SELECTION_SCHEMA, executable: "/bin/harbor", source: {}, arms: [] }));
    expect(resolveMethodOperand({ ref: harborPath, cwd: dir })).toMatchObject({
      kind: "file",
      documentKind: "harbor",
      official: false,
    });
    const tb2Path = join(dir, "tb2.json");
    writeFileSync(tb2Path, JSON.stringify({ schema: TERMINAL_BENCH_2_SELECTION_SCHEMA, executable: "/bin/harbor" }));
    expect(resolveMethodOperand({ ref: tb2Path, cwd: dir })).toMatchObject({
      kind: "file",
      documentKind: "terminal-bench-2",
      official: false,
    });
    const officialPath = join(dir, "tb21.json");
    writeFileSync(officialPath, JSON.stringify({ schema: TERMINAL_BENCH_2_1_SELECTION_SCHEMA, executable: "/bin/harbor" }));
    expect(resolveMethodOperand({ ref: officialPath, cwd: dir })).toMatchObject({
      kind: "file",
      documentKind: "terminal-bench-2.1",
      official: true,
    });
  });

  test("refuses when the operand is both a catalog id and a file", () => {
    const dir = cwd();
    writeFileSync(join(dir, "terminal-bench-2.1"), JSON.stringify({ schema: INSPECT_SELECTION_SCHEMA, taskReference: "x" }));
    const error = refuse(() => resolveMethodOperand({ ref: "terminal-bench-2.1", cwd: dir, slice: "1", hostPath: join(dir, "missing.json") }));
    expect(error.code).toBe("invalid-invocation");
    expect(error.message).toMatch(/catalog id and a file/i);
  });

  test("refuses when the operand is neither a suite nor a file", () => {
    const error = refuse(() => resolveMethodOperand({ ref: "not-a-suite", cwd: cwd() }));
    expect(error.code).toBe("invalid-invocation");
    expect(error.message).toMatch(/not a suite and not a file/i);
    expect(error.message).toContain(`known catalog ids: ${knownCatalogIds()}`);
  });

  test("refuses --slice, --ids, --host, and --n on a file operand", () => {
    const dir = cwd();
    const filePath = join(dir, "method.json");
    writeFileSync(filePath, JSON.stringify({ schema: INSPECT_SELECTION_SCHEMA, taskReference: "t" }));
    expect(refuse(() => resolveMethodOperand({ ref: filePath, cwd: dir, ids: "a" })).issues[0]?.path).toBe("--ids");
    expect(refuse(() => resolveMethodOperand({ ref: filePath, cwd: dir, hostPath: filePath })).issues[0]?.path).toBe("--host");
    expect(refuse(() => resolveMethodOperand({ ref: filePath, cwd: dir, n: "1" })).issues[0]?.path).toBe("--n");
  });

  test("catalog id without host or slice/ids/n is incomplete", () => {
    const dir = cwd();
    expect(refuse(() => resolveMethodOperand({ ref: "apex-agents", cwd: dir })).issues[0]?.path).toBe("--host");
    const hostPath = join(dir, "host.json");
    writeFileSync(hostPath, JSON.stringify({ executable: "/bin/true" }));
    const incomplete = refuse(() => resolveMethodOperand({ ref: "apex-agents", cwd: dir, hostPath }));
    expect(incomplete.issues[0]?.path).toBe("--slice");
    expect(incomplete.message).toMatch(/--slice, --ids, or --n/);
  });

  test("refuses --n together with --slice or --ids", () => {
    const dir = cwd();
    const hostPath = join(dir, "host.json");
    writeFileSync(hostPath, JSON.stringify({ executable: "/bin/true" }));
    expect(refuse(() => resolveMethodOperand({
      ref: "apex-agents",
      cwd: dir,
      hostPath,
      n: "1",
      slice: "1",
    })).issues[0]?.path).toBe("--n");
    expect(refuse(() => resolveMethodOperand({
      ref: "apex-agents",
      cwd: dir,
      hostPath,
      n: "1",
      ids: "a-task",
    })).issues[0]?.path).toBe("--n");
  });

  test("refuses --n that is not a positive integer", () => {
    const dir = cwd();
    const hostPath = join(dir, "host.json");
    writeFileSync(hostPath, JSON.stringify({ executable: "/bin/true" }));
    for (const n of ["0", "01", "-1", "1.5", "abc", ""]) {
      const error = refuse(() => resolveMethodOperand({ ref: "apex-agents", cwd: dir, hostPath, n }));
      expect(error.code).toBe("invalid-invocation");
      expect(error.issues[0]?.path).toBe("--n");
    }
  });

  test("--n 1 on a two-task APEX-Agents registry is one_task without selectedIds", () => {
    const dir = cwd();
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      name: "mercor/apex-agents",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      task_ids: ["z-task", "a-task"],
    }));
    const hostPath = join(dir, "host.json");
    writeFileSync(hostPath, JSON.stringify({
      executable: "/bin/true",
      registryMetadataPath: "registry.json",
      arms: [{ armId: "one", modelId: "one" }],
    }));
    const resolved = resolveMethodOperand({
      ref: "apex-agents",
      cwd: dir,
      n: "1",
      hostPath,
    });
    expect(resolved).toMatchObject({
      kind: "catalog",
      catalogId: "apex-agents",
      protocol: "apex-agents",
      coverage: "one_task",
    });
    if (resolved.kind !== "catalog") return;
    expect(resolved.selectedIds).toBeUndefined();
  });

  test("--n that is neither a named slice nor the first-10/full inventory is custom with selectedIds", () => {
    const dir = cwd();
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      name: "mercor/apex-agents",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      task_ids: ["z-task", "m-task", "a-task"],
    }));
    const hostPath = join(dir, "host.json");
    writeFileSync(hostPath, JSON.stringify({
      executable: "/bin/true",
      registryMetadataPath: "registry.json",
      arms: [],
    }));
    const custom = resolveMethodOperand({ ref: "apex-agents", cwd: dir, n: "2", hostPath });
    expect(custom).toMatchObject({
      kind: "catalog",
      coverage: "custom",
      selectedIds: ["a-task", "m-task"],
    });
  });

  test("refuses --n larger than the registry inventory", () => {
    const dir = cwd();
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      name: "mercor/apex-agents",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      task_ids: ["z-task", "a-task"],
    }));
    const hostPath = join(dir, "host.json");
    writeFileSync(hostPath, JSON.stringify({
      executable: "/bin/true",
      registryMetadataPath: "registry.json",
      arms: [],
    }));
    const error = refuse(() => resolveMethodOperand({ ref: "apex-agents", cwd: dir, n: "3", hostPath }));
    expect(error.code).toBe("invalid-invocation");
    expect(error.issues[0]?.path).toBe("--n");
  });

  test("relative file refs resolve from cwd", () => {
    const dir = cwd();
    mkdirSync(join(dir, "nested"));
    const relative = join("nested", "inspect.json");
    writeFileSync(join(dir, relative), JSON.stringify({ schema: INSPECT_SELECTION_SCHEMA, taskReference: "t" }));
    expect(resolveMethodOperand({ ref: relative, cwd: dir })).toMatchObject({ kind: "file", documentKind: "inspect" });
  });
});
