import { lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { secureAtomicWrite, secureRead, withHostAdvisoryLock } from "./state.js";

describe("private host state", () => {
  test("writes private immutable artifacts and refuses byte replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-host-state-"));
    const path = join(root, "campaign", "artifact.json");
    secureAtomicWrite(path, new TextEncoder().encode("one"), true);
    expect(readFileSync(path, "utf8")).toBe("one");
    expect(statSync(join(root, "campaign")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(new TextDecoder().decode(secureRead(path))).toBe("one");
    expect(() => secureAtomicWrite(path, new TextEncoder().encode("two"), true)).toThrow(/immutable/u);
  });

  test("refuses an intermediate symlink escape", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-host-intermediate-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "jinn-host-outside-"));
    symlinkSync(outside, join(root, "escape"));
    expect(() => secureAtomicWrite(join(root, "escape", "artifact"), new Uint8Array([1])))
      .toThrow(/symbolic link/u);
    mkdirSync(join(outside, "already-exists"));
    expect(() => secureAtomicWrite(
      join(root, "escape", "already-exists", "artifact"),
      new Uint8Array([1]),
    )).toThrow(/symbolic link/u);
  });

  test("refuses symlink targets", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-host-symlink-"));
    const target = join(root, "target");
    const link = join(root, "link");
    secureAtomicWrite(target, new TextEncoder().encode("safe"));
    symlinkSync(target, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(() => secureAtomicWrite(link, new TextEncoder().encode("unsafe"))).toThrow(/symbolic link/u);
  });

  test("holds a process-visible advisory lock across the whole operation", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-host-lock-"));
    let release!: () => void;
    const held = withHostAdvisoryLock(root, async () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(withHostAdvisoryLock(root, async () => undefined)).rejects.toThrow(/holds this campaign/u);
    release();
    await held;
    await expect(withHostAdvisoryLock(root, async () => "ok")).resolves.toBe("ok");
  });
});
