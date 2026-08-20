import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonBytes, type JsonValue } from "@jinn-network/policy-identity";
import { describe, expect, test } from "vitest";
import {
  parseLocalLoadoutArchive,
  sealLocalLoadoutDirectory,
} from "./loadout-archive.js";

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

  test("strictly round-trips canonical archives and refuses alternate documents", () => {
    const directory = root();
    mkdirSync(join(directory, "notes"));
    writeFileSync(join(directory, "notes", "a.md"), "a\n");
    writeFileSync(join(directory, "notes", "b.md"), "b\n");
    const sealed = sealLocalLoadoutDirectory(directory);
    expect(parseLocalLoadoutArchive(sealed.bytes).treeDigest).toBe(sealed.treeDigest);

    const value = JSON.parse(new TextDecoder().decode(sealed.bytes)) as Record<string, unknown>;
    expect(() => parseLocalLoadoutArchive(canonicalJsonBytes({
      ...value,
      unknown: true,
    } as JsonValue))).toThrow(/unknown/u);
    expect(() => parseLocalLoadoutArchive(new TextEncoder().encode(
      new TextDecoder().decode(sealed.bytes).replace(
        '"formatToken":',
        '"formatToken":"duplicate","formatToken":',
      ),
    ))).toThrow(/canonical/u);
    expect(() => parseLocalLoadoutArchive(canonicalJsonBytes({
      ...value,
      treeDigest: `sha256:${"0".repeat(64)}`,
    } as JsonValue))).toThrow(/tree digest/u);
    expect(() => parseLocalLoadoutArchive(canonicalJsonBytes({
      ...value,
      entries: [...value["entries"] as unknown[]].reverse(),
    } as JsonValue))).toThrow(/path-sorted/u);
    expect(() => parseLocalLoadoutArchive(canonicalJsonBytes({
      ...value,
      entries: [{ path: "../escape", kind: "file", content: "safe" }],
    } as JsonValue))).toThrow(/non-portable path/u);
    expect(() => parseLocalLoadoutArchive(canonicalJsonBytes({
      ...value,
      entries: [{ path: "notes/key.md", kind: "file", content: "api_key=unsafe" }],
    } as JsonValue))).toThrow(/secret-bearing/u);
  });

  test("refuses a file that changes during the capture read", () => {
    const directory = root();
    const notes = join(directory, "notes");
    const policy = join(notes, "policy.md");
    mkdirSync(notes);
    writeFileSync(policy, "before\n");
    expect(() => sealLocalLoadoutDirectory(directory, {
      afterFileRead(path) {
        if (path === policy) writeFileSync(policy, "after with different bytes\n");
      },
    })).toThrow(/moved while it was being captured/u);
  });
});
