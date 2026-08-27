import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { inheritedTempEnv, scopedTempEnv } from "./child-temp-env.js";

const sourceRoot = resolve(import.meta.dirname, "..");

/**
 * The marker a site writes when it deliberately names no temp directory — because the child must
 * not inherit one, or because the allowlist is the caller's to build. One exact token rather than a
 * pattern over prose, so the scan cannot be satisfied by an unrelated sentence that happens to use
 * the right words, and `grep "temp-env:"` finds every such decision at once. The reason follows the
 * marker inline, because a deliberate omission and an oversight are otherwise indistinguishable.
 */
const JUSTIFICATION = /\btemp-env:/u;

/** Accepted ways an `env:` allowlist can carry the caller's, or a pinned, temp directory. */
const CARRIES_TEMP = /inheritedTempEnv\(|scopedTempEnv\(|TMPDIR|\.\.\./u;

/** Declarations and schemas that name a field called `env`; they spawn nothing. */
const NOT_A_SPAWN_SITE = /env:\s*(?:z\.|Readonly<|NodeJS\.ProcessEnv|dict\[|invocation\.env\b)/u;

/**
 * The definition of the environment a site delegates to, when it passes a name rather than a
 * literal (`env: closedHarborEnv(paths)`, `env: dockerEnvironment`). Without this, a site that
 * builds its allowlist in one well-documented place reads to the scan as an omission, and the only
 * way to satisfy it would be to inline the literal at every call — which is what produced the gap
 * in the first place.
 */
function delegatedDefinition(source: string, site: string): string | undefined {
  const name = /env:\s*([A-Za-z_$][\w$]*)/u.exec(site)?.[1];
  if (name === undefined) return undefined;
  const definition = new RegExp(`(?:const|let|function)\\s+${name}\\b`, "u").exec(source);
  // A fixed window rather than a brace walk: these definitions are a handful of lines, and a walk
  // would have to understand template literals, which two of them are written inside.
  return definition === null ? undefined : source.slice(definition.index, definition.index + 600);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(?:ts|mjs)$/u.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

/**
 * The `env:` value expression at `index`, plus the comment lines directly above it — an object
 * literal is read to its matching brace, anything else to the end of its line.
 */
function envSite(source: string, index: number): string {
  const valueStart = source.indexOf(":", index) + 1;
  let end = source.indexOf("\n", valueStart);
  const brace = source.slice(valueStart, end === -1 ? undefined : end).indexOf("{");
  if (brace !== -1) {
    let depth = 0;
    for (let cursor = valueStart + brace; cursor < source.length; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}" && (depth -= 1) === 0) {
        end = cursor + 1;
        break;
      }
    }
  }
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const preceding = source.slice(0, lineStart).split("\n").slice(-8).join("\n");
  const comments = preceding.split("\n").filter((line) => /^\s*(?:\/\/|\*|\/\*)/u.test(line)).join("\n");
  return `${comments}\n${source.slice(index, end === -1 ? undefined : end)}`;
}

describe("child temp-directory environment", () => {
  it("passes through only the caller's non-empty temp variables", () => {
    expect(inheritedTempEnv({ TMPDIR: "/a", TMP: "/b", TEMP: "/c", PATH: "/bin" })).toEqual({
      TMPDIR: "/a",
      TMP: "/b",
      TEMP: "/c",
    });
    expect(inheritedTempEnv({})).toEqual({});
    // An empty value is a RELATIVE path to a child that resolves it, not "use the default".
    expect(inheritedTempEnv({ TMPDIR: "" })).toEqual({});
  });

  it("pins all three names at a scoped directory", () => {
    expect(scopedTempEnv("/run/tmp")).toEqual({ TMPDIR: "/run/tmp", TMP: "/run/tmp", TEMP: "/run/tmp" });
  });

  // Regression coverage for the gap this file exists to close: every `spawn`/`execFile` in this
  // package hands the child an explicit allowlist, and a child that inherits no temp variable falls
  // back to the platform default and writes outside the root its parent was confined to. Scanned
  // rather than asserted per call site, so a NEW spawn site cannot arrive without one or the other.
  it("names the temp variables at every spawn site, or says why not", () => {
    const unhandled: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      // `(?<![\w-])` and not `\b`: the justification marker is spelled `temp-env:`, and a word
      // boundary matches after its hyphen — so every marker would be scanned as a site of its own.
      for (const match of source.matchAll(/(?<![\w-])env:/gu)) {
        const site = envSite(source, match.index);
        if (NOT_A_SPAWN_SITE.test(site)) continue;
        if (CARRIES_TEMP.test(site) || JUSTIFICATION.test(site)) continue;
        const delegated = delegatedDefinition(source, site);
        if (delegated !== undefined && (CARRIES_TEMP.test(delegated) || JUSTIFICATION.test(delegated))) continue;
        unhandled.push(`${relative(sourceRoot, file)}: ${site.split("\n").pop()?.trim()}`);
      }
    }
    expect(
      unhandled,
      "spawn sites whose env allowlist names no temp directory and gives no reason:\n" +
        `  ${unhandled.join("\n  ")}\n` +
        "Spread inheritedTempEnv() (child writes where the caller writes), spread scopedTempEnv(dir) " +
        "(child is pinned at dir), or say inline why the child must not inherit them.",
    ).toEqual([]);
  });
});
