import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_SNAPSHOT_ALGORITHM,
  STRICT_SNAPSHOT_POLICY,
  createFilesystemNativeSnapshotPort,
  createProcessNativeLauncher,
} from "./native-ports.js";

const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jinn-native-ports-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

function tree(files: Readonly<Record<string, string>>): string {
  const root = scratch();
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function port(root: string) {
  return createFilesystemNativeSnapshotPort({
    resolveRoot: () => root,
    now: () => "2026-08-16T00:00:00Z",
  });
}

const SOURCE = { kind: "skillsbench", locator: "tasks/" };

describe("filesystem snapshot port", () => {
  it("captures a tree and derives a stable root digest", () => {
    const root = tree({ "a/task.md": "hello", "b/task.md": "world" });
    const snapshot = port(root).snapshot(SOURCE, STRICT_SNAPSHOT_POLICY);
    expect(snapshot.snapshotId).toMatch(/^snap-[0-9a-f]{32}$/u);
    expect((snapshot.root as never as { digest: { sha256: string } }).digest.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect((snapshot.root as never as { annotations: { algorithm: string } }).annotations.algorithm)
      .toBe(NATIVE_SNAPSHOT_ALGORITHM);
  });

  it("derives the same digest for identical content and a different one for changed content", () => {
    const first = port(tree({ "a.txt": "x" })).snapshot(SOURCE, STRICT_SNAPSHOT_POLICY);
    const same = port(tree({ "a.txt": "x" })).snapshot(SOURCE, STRICT_SNAPSHOT_POLICY);
    const other = port(tree({ "a.txt": "y" })).snapshot(SOURCE, STRICT_SNAPSHOT_POLICY);
    const digest = (s: typeof first) => (s.root as never as { digest: { sha256: string } }).digest.sha256;
    expect(digest(same)).toBe(digest(first));
    expect(digest(other)).not.toBe(digest(first));
  });

  it("lists entries in stable order and reads bytes back", () => {
    const root = tree({ "z.txt": "last", "a.txt": "first" });
    const p = port(root);
    const snapshot = p.snapshot(SOURCE, STRICT_SNAPSHOT_POLICY);
    expect(p.list(snapshot).map((entry) => entry.path)).toEqual(["a.txt", "z.txt"]);
    expect(Buffer.from(p.read(snapshot, "a.txt")).toString("utf8")).toBe("first");
  });

  describe("refusals", () => {
    it("refuses a symbolic link rather than following it", () => {
      // Following a link would let content outside the root into the digest.
      const root = tree({ "a.txt": "x" });
      symlinkSync("/etc/passwd", join(root, "link"));
      expect(() => port(root).snapshot(SOURCE, STRICT_SNAPSHOT_POLICY)).toThrow(/symbolic link/u);
    });

    it("refuses a tree with more entries than the policy allows", () => {
      const root = tree({ "a.txt": "x", "b.txt": "y", "c.txt": "z" });
      expect(() => port(root).snapshot(SOURCE, { ...STRICT_SNAPSHOT_POLICY, maximumEntries: 2 }))
        .toThrow(/entry count exceeds/u);
    });

    it("refuses a tree larger than the policy allows", () => {
      const root = tree({ "big.txt": "x".repeat(1000) });
      expect(() => port(root).snapshot(SOURCE, { ...STRICT_SNAPSHOT_POLICY, maximumBytes: 100 }))
        .toThrow(/size exceeds/u);
    });

    it("refuses a locator that is not a directory", () => {
      const p = createFilesystemNativeSnapshotPort({ resolveRoot: () => "/nope/nowhere", now: () => "t" });
      expect(() => p.snapshot(SOURCE, STRICT_SNAPSHOT_POLICY)).toThrow(/does not resolve to a directory/u);
    });

    it("refuses to list or read a snapshot it did not capture", () => {
      const p = port(tree({ "a.txt": "x" }));
      const alien = { snapshotId: "snap-elsewhere", source: SOURCE, root: {} as never, capturedAt: "t" };
      expect(() => p.list(alien)).toThrow(/unknown/u);
    });
  });

  describe("mutation detection", () => {
    it("accepts an unchanged source", () => {
      const root = tree({ "a.txt": "x" });
      const p = port(root);
      const snapshot = p.snapshot(SOURCE, STRICT_SNAPSHOT_POLICY);
      expect(() => p.assertUnchanged(snapshot)).not.toThrow();
    });

    it("refuses a source mutated after capture", () => {
      const root = tree({ "a.txt": "x" });
      const p = port(root);
      const snapshot = p.snapshot(SOURCE, STRICT_SNAPSHOT_POLICY);
      writeFileSync(join(root, "a.txt"), "tampered");
      expect(() => p.assertUnchanged(snapshot)).toThrow(/mutated after snapshot/u);
    });

    it("refuses a read whose bytes changed since capture", () => {
      // The digest is checked on every read, so a file swapped mid-run cannot reach a caller.
      const root = tree({ "a.txt": "x" });
      const p = port(root);
      const snapshot = p.snapshot(SOURCE, STRICT_SNAPSHOT_POLICY);
      writeFileSync(join(root, "a.txt"), "swapped");
      expect(() => p.read(snapshot, "a.txt")).toThrow(/mutated after snapshot/u);
    });

    it("refuses a file added after capture", () => {
      const root = tree({ "a.txt": "x" });
      const p = port(root);
      const snapshot = p.snapshot(SOURCE, STRICT_SNAPSHOT_POLICY);
      writeFileSync(join(root, "b.txt"), "new");
      expect(() => p.assertUnchanged(snapshot)).toThrow(/mutated after snapshot/u);
    });
  });
});

describe("process launcher", () => {
  function launcher(stateDir = scratch()) {
    return createProcessNativeLauncher({ stateDir, resultLocator: (id) => `results/${id}` });
  }

  const invocation = (argv: readonly string[], env: readonly { name: string; value: string }[] = []) => ({
    executable: { path: process.execPath, artifact: { digest: { sha256: "a".repeat(64) } } as never },
    argv,
    environment: env,
    workingDirectoryPolicy: "isolated-workspace" as const,
    runtimeClosure: [],
  });

  it("runs a launch and reports its exit code", () => {
    const l = launcher();
    l.ensureStarted("launch-1", invocation(["-e", "process.exit(0)"]));
    const result = l.wait("launch-1");
    expect(result.exitCode).toBe(0);
    expect(result.resultSource.locator).toBe("results/launch-1");
    expect(result.limitations).toEqual([]);
  });

  it("reports a non-zero exit rather than throwing", () => {
    const l = launcher();
    l.ensureStarted("launch-2", invocation(["-e", "process.exit(3)"]));
    expect(l.wait("launch-2").exitCode).toBe(3);
  });

  it("passes the declared environment through", () => {
    const l = launcher();
    l.ensureStarted("launch-3", invocation(
      ["-e", "process.exit(process.env.JINN_TEST === 'ok' ? 0 : 9)"],
      [{ name: "JINN_TEST", value: "ok" }],
    ));
    expect(l.wait("launch-3").exitCode).toBe(0);
  });

  describe("idempotency", () => {
    it("does not re-run a launch id that already completed", () => {
      const stateDir = scratch();
      const counter = join(scratch(), "runs.txt");
      const script = `require("fs").appendFileSync(${JSON.stringify(counter)}, "x")`;
      const l = createProcessNativeLauncher({ stateDir, resultLocator: (id) => id });
      l.ensureStarted("once", invocation(["-e", script]));
      l.ensureStarted("once", invocation(["-e", script]));
      l.ensureStarted("once", invocation(["-e", script]));
      expect(readFileSync(counter, "utf8")).toBe("x");
    });

    it("survives a fresh launcher over the same durable state", () => {
      // Idempotency is on disk, not in memory, so a crashed-and-restarted coordinator resumes.
      const stateDir = scratch();
      const first = createProcessNativeLauncher({ stateDir, resultLocator: (id) => id });
      first.ensureStarted("durable", invocation(["-e", "process.exit(5)"]));
      const second = createProcessNativeLauncher({ stateDir, resultLocator: (id) => id });
      expect(second.wait("durable").exitCode).toBe(5);
    });

    it("refuses to reuse a launch id for a different invocation", () => {
      // Silently rebinding an idempotency key would change what a sealed launch refers to.
      const l = launcher();
      l.ensureStarted("bound", invocation(["-e", "process.exit(0)"]));
      expect(() => l.ensureStarted("bound", invocation(["-e", "process.exit(1)"])))
        .toThrow(/cannot be reused/u);
    });

    it("is insensitive to environment ordering when comparing invocations", () => {
      const l = launcher();
      const env = [{ name: "A", value: "1" }, { name: "B", value: "2" }];
      l.ensureStarted("ordered", invocation(["-e", "process.exit(0)"], env));
      expect(() => l.ensureStarted("ordered", invocation(["-e", "process.exit(0)"], [...env].reverse())))
        .not.toThrow();
    });
  });

  it("refuses to wait on a launch that was never started", () => {
    expect(() => launcher().wait("ghost")).toThrow(/never started/u);
  });

  it("records a failed spawn as a limitation rather than a clean exit", () => {
    const l = createProcessNativeLauncher({ stateDir: scratch(), resultLocator: (id) => id });
    l.ensureStarted("missing", {
      executable: { path: "/nonexistent/binary", artifact: { digest: { sha256: "a".repeat(64) } } as never },
      argv: [],
      environment: [],
      workingDirectoryPolicy: "isolated-workspace",
      runtimeClosure: [],
    });
    const result = l.wait("missing");
    expect(result.exitCode).not.toBe(0);
    expect(result.limitations.join(" ")).toMatch(/launch error/u);
  });
});
