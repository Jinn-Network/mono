// SPDX-License-Identifier: Apache-2.0

/**
 * What no directory on this machine can show: a file swapped after the walk, and two names that read
 * as one. Both are injected at `node:fs`.
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import { runCommand } from "./command.js";
import { readRootTarget } from "./root-target.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), readdirSync: vi.fn(actual.readdirSync) };
});

const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const temporary = actual.mkdtempSync(join(tmpdir(), "jinn-verify-root-target-"));
afterAll(() => actual.rmSync(temporary, { recursive: true, force: true }));
afterEach(() => {
  vi.mocked(fs.readdirSync).mockImplementation(actual.readdirSync);
  vi.mocked(fs.openSync).mockClear();
});

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let directories = 0;

/** A directory of `files` and the list that names them, with the list's digest. */
function published(files: Readonly<Record<string, string>>) {
  directories += 1;
  const path = join(temporary, `set-${directories}`);
  for (const [name, content] of Object.entries(files)) {
    actual.mkdirSync(dirname(join(path, name)), { recursive: true });
    actual.writeFileSync(join(path, name), content);
  }
  const list = JSON.stringify({
    files: Object.keys(files).sort().map((name) => ({ path: name, bytes: files[name]!.length, sha256: sha256(files[name]!) })),
  });
  actual.writeFileSync(join(path, "bundle.json"), list);
  return { path, root: sha256(list) };
}

describe("a file swapped after the walk", () => {
  test("for a pipe is refused rather than waited on, and every open says so", () => {
    const { path, root } = published({ "sub/a.txt": "a" });
    const fifo = join(path, "sub/a.txt");
    vi.mocked(fs.readdirSync).mockImplementation(((directory: string, options: never) => {
      const entries = actual.readdirSync(directory, options);
      if (directory.endsWith("sub")) {
        actual.unlinkSync(fifo);
        execFileSync("mkfifo", [fifo]);
      }
      return entries;
    }) as never);
    // If the open ever blocks, this writer ends the wait, and the assertions below still fail.
    const writer = spawn("sh", ["-c", 'sleep 5; exec 3>"$0"', fifo], { stdio: "ignore" });
    try {
      expect(readRootTarget(path, root, 1024).problems).toEqual([
        { code: "unreadable", file: "sub/a.txt", detail: "not a regular file" },
      ]);
    } finally {
      writer.kill("SIGKILL");
    }
    const flags = vi.mocked(fs.openSync).mock.calls.map(([, opened]) => opened as number);
    expect(flags.length).toBeGreaterThan(1);
    for (const opened of flags) {
      expect(opened & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
      expect(opened & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    }
  });
});

describe("what the record checks are handed", () => {
  test("is the digest in the list as a claim, and the digest of the bytes read as a fact", () => {
    const { path, root } = published({ "same.txt": "a", "swapped.txt": "b" });
    actual.writeFileSync(join(path, "swapped.txt"), "c");
    const { files } = readRootTarget(path, root, 1024);
    expect(files.map(({ file, digest, hashed }) => [file, digest, hashed])).toEqual([
      ["same.txt", `sha256:${sha256("a")}`, `sha256:${sha256("a")}`],
      ["swapped.txt", `sha256:${sha256("b")}`, `sha256:${sha256("c")}`],
    ]);
  });
});

describe("two names on disk that read as one", () => {
  test("fail, because the second would otherwise pass as the listed file", () => {
    const { path, root } = published({ "x.txt": "x" });
    vi.mocked(fs.readdirSync).mockImplementation(((directory: string, options: never) => {
      const entries = actual.readdirSync(directory, options) as unknown as fs.Dirent[];
      const named = entries.find(({ name }) => name === "x.txt");
      return named === undefined ? entries : [...entries, named];
    }) as never);
    expect(readRootTarget(path, root, 1024).problems).toEqual([
      { code: "name-collision", file: "x.txt", detail: "two names on disk read as this text" },
    ]);
  });

  test("the report says so, and the run fails", async () => {
    const { path, root } = published({ "x.txt": "x" });
    vi.mocked(fs.readdirSync).mockImplementation(((directory: string, options: never) => {
      const entries = actual.readdirSync(directory, options) as unknown as fs.Dirent[];
      const named = entries.find(({ name }) => name === "x.txt");
      return named === undefined ? entries : [...entries, named];
    }) as never);
    let stdout = "";
    const code = await runCommand([path, "--root", `sha256:${root}`], { stdout: (text) => { stdout += text; }, stderr: () => {} });
    expect(code).toBe(1);
    expect(stdout).toContain("Completeness   failed: 1 reading as another name");
  });
});
