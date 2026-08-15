import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { sealLocalLoadoutDirectory } from "./loadout-archive.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "jinn-loadout-"));
}

describe("local learner-public.v1 archive", () => {
  test("captures deterministic public text while never reading ignored private roots", () => {
    const directory = root();
    mkdirSync(join(directory, "notes"));
    mkdirSync(join(directory, "secrets"));
    writeFileSync(join(directory, "notes", "operator.md"), "Prefer narrow fixes.\n");
    writeFileSync(join(directory, "secrets", "credential.txt"), "api_key=do-not-read\n");
    const first = sealLocalLoadoutDirectory(directory);
    const second = sealLocalLoadoutDirectory(directory);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.treeDigest).toBe(second.treeDigest);
    expect(new TextDecoder().decode(first.bytes)).toContain("Prefer narrow fixes");
    expect(new TextDecoder().decode(first.bytes)).not.toContain("do-not-read");
  });

  test("refuses unclassified roots and links instead of guessing or following", () => {
    const unknown = root();
    writeFileSync(join(unknown, "README.md"), "not classified");
    expect(() => sealLocalLoadoutDirectory(unknown)).toThrow(/unclassified/u);

    const linked = root();
    mkdirSync(join(linked, "notes"));
    writeFileSync(join(linked, "outside.txt"), "outside");
    symlinkSync(join(linked, "outside.txt"), join(linked, "notes", "linked.txt"));
    expect(() => sealLocalLoadoutDirectory(linked)).toThrow(/symlink/u);
  });

  test("refuses secret-bearing bytes in otherwise public roots", () => {
    const directory = root();
    mkdirSync(join(directory, "notes"));
    writeFileSync(join(directory, "notes", "unsafe.md"), "api_key=must-not-travel\n");
    expect(() => sealLocalLoadoutDirectory(directory)).toThrow(/secret-bearing/u);
  });
});
