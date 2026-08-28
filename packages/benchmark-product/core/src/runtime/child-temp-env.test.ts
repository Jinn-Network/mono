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

/**
 * Accepted ways an `env:` allowlist can carry the caller's, or a pinned, temp directory.
 *
 * A spread counts only when it is `...process.env` — the one spread expression whose contents the
 * scan can read off the text itself. A bare `\.\.\.` used to be accepted here, which made every
 * spread proof of carriage whatever it spread: `env: { ...process.env }` does carry the temp
 * variables, `env: { ...env }` carries only what its own allowlist named, and the scan could not
 * tell them apart. Any other spread is resolved through `carriesTemp` instead.
 */
const CARRIES_TEMP = /inheritedTempEnv\(|scopedTempEnv\(|TMPDIR|\.\.\.process\.env\b/u;

/** Declarations and schemas that name a field called `env`; they spawn nothing. */
const NOT_A_SPAWN_SITE = /env:\s*(?:z\.|Readonly<|NodeJS\.ProcessEnv|dict\[)/u;

/** Source text with its comments removed, so prose about a temp variable is not read as one. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, " ");
}

/**
 * The names an environment expression delegates to: what it passes instead of a literal
 * (`env: closedHarborEnv(paths)`, `env: dockerEnvironment`), what it spreads (`...env`), and what
 * a delegate's own body then calls (`loginEnvironment` calls `scopedTempEnv`). Without this, a
 * site that builds its allowlist in one well-documented place reads to the scan as an omission,
 * and the only way to satisfy it would be to inline the literal at every call — which is what
 * produced the gap in the first place.
 */
function delegatedNames(expression: string, calls: boolean): string[] {
  const names = new Set<string>();
  const patterns = [/env:\s*([A-Za-z_$][\w$]*)/gu, /\.\.\.([A-Za-z_$][\w$]*)/gu];
  // Calls only once inside a delegate's own body, never at the site. At the site every call in the
  // literal would count, so an unrelated `KEY: tokenFor(k)` next to an allowlist naming no temp
  // directory would supply the proof; inside a body the call IS how the delegation continues
  // (`loginEnvironment` reaches `scopedTempEnv` no other way).
  if (calls) patterns.push(/([A-Za-z_$][\w$]*)\s*\(/gu);
  for (const pattern of patterns) {
    for (const match of expression.matchAll(pattern)) names.add(match[1]!);
  }
  return [...names];
}

/**
 * The definition of a delegated name, as text — bounded at the next top-level declaration, with a
 * byte cap for the last definition in a file. Not a brace walk: a walk would have to understand
 * template literals, which two of these definitions are written inside. Not a fixed window either,
 * which was the first attempt here — it spills into whatever is defined next, so a helper that
 * pins no temp directory reads as carrying one because a helper that does sits below it.
 */
function definitionWindow(source: string, name: string): string | undefined {
  const definition = new RegExp(`(?:const|let|function)\\s+${name}\\b`, "u").exec(source);
  if (definition === null) return undefined;
  // The declaration must start the line: a nested `const` is part of this definition, not the next.
  const body = source.slice(definition.index, definition.index + 2_000);
  const next = /\n(?:export\s+)?(?:async\s+)?(?:const|let|function)\s/u.exec(body.slice(1));
  return next === null ? body : body.slice(0, next.index + 1);
}

/**
 * Whether an environment expression carries a temp directory, following delegation as far as the
 * file itself can show it. Bounded by `seen`, which both terminates cycles and keeps a name that
 * several expressions reach from being walked twice.
 */
function carriesTemp(source: string, expression: string, seen: Set<string>): boolean {
  // Comments stripped first: carriage is a property of the code, and every one of these helpers is
  // documented in prose that names the variables it pins. Reading the prose as proof made the check
  // survive deleting the call — `readinessEnvironment` in `venue/demo1-claude.ts` stayed green on
  // the words in its own doc comment. The deliberate-omission marker is not read here; it is
  // checked against the site itself, comments and all, before this function is ever called.
  const code = withoutComments(expression);
  if (CARRIES_TEMP.test(code)) return true;
  // A non-empty `seen` means this expression is a delegate's body rather than the site itself,
  // which is the only place a bare call counts as delegation.
  for (const name of delegatedNames(code, seen.size > 0)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const definition = definitionWindow(source, name);
    if (definition !== undefined && carriesTemp(source, definition, seen)) return true;
  }
  return false;
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

/** The `env:` sites in one file's source text that the scan cannot account for. */
function unhandledSites(source: string): string[] {
  const unhandled: string[] = [];
  // `(?<![\w-])` and not `\b`: the justification marker is spelled `temp-env:`, and a word
  // boundary matches after its hyphen — so every marker would be scanned as a site of its own.
  for (const match of source.matchAll(/(?<![\w-])env:/gu)) {
    const site = envSite(source, match.index);
    if (NOT_A_SPAWN_SITE.test(site)) continue;
    // The marker is checked here and nowhere deeper: it exempts the site whose author wrote it,
    // not every site that happens to mention a name defined near one.
    if (JUSTIFICATION.test(site) || carriesTemp(source, site, new Set())) continue;
    const line = source.slice(0, match.index).split("\n").length;
    unhandled.push(`${line}: ${site.slice(site.indexOf("env:")).split("\n")[0]!.trim()}`);
  }
  return unhandled;
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
  // The scan's own regression coverage: a spread used to satisfy it whatever it spread, so an
  // allowlist that named no temp directory passed as long as it was built somewhere else and
  // spread in. These two sources differ only in what the spread resolves to.
  it("reads what a spread resolves to rather than accepting the spread itself", () => {
    const carrier = 'function build() { return { ...scopedTempEnv(root), PATH: "" }; }\n';
    const bare = 'function build() { return { PATH: "" }; }\n';
    const site = 'const built = build();\nspawn(exe, args, { env: { ...built, HOME: home } });\n';
    expect(unhandledSites(carrier + site)).toEqual([]);
    expect(unhandledSites(bare + site)).toHaveLength(1);
  });

  // Every helper here is documented in prose that names the variables it pins, so reading a comment
  // as carriage let the check survive deleting the call it was documenting.
  it("does not read prose about a temp variable as proof one is set", () => {
    const site = 'const built = build();\nspawn(exe, args, { env: { ...built, HOME: home } });\n';
    expect(unhandledSites('// Sets TMPDIR.\nfunction build() { return { PATH: "" }; }\n' + site)).toHaveLength(1);
    expect(unhandledSites('/** Sets TMPDIR. */\nfunction build() { return { PATH: "" }; }\n' + site)).toHaveLength(1);
  });

  // Two ways a site could once borrow proof it did not earn: a neighbouring helper that does pin a
  // temp directory, and an unrelated call sitting in the same object literal. Neither is evidence
  // about the allowlist actually being handed to a child.
  it("does not let a site borrow proof it did not earn", () => {
    const site = 'const built = build();\nspawn(exe, args, { env: { ...built, HOME: home } });\n';
    const neighbour = 'function build() { return { PATH: "" }; }\nfunction other() { return scopedTempEnv(d); }\n';
    expect(unhandledSites(neighbour + site)).toHaveLength(1);
    expect(unhandledSites('spawn(exe, args, { env: { HOME: home, KEY: tokenFor(k) } });\n')).toHaveLength(1);
  });

  it("names the temp variables at every spawn site, or says why not", () => {
    const unhandled = sourceFiles(sourceRoot).flatMap((file) =>
      unhandledSites(readFileSync(file, "utf8")).map((site) => `${relative(sourceRoot, file)}: ${site}`));
    expect(
      unhandled,
      "spawn sites whose env allowlist names no temp directory and gives no reason:\n" +
        `  ${unhandled.join("\n  ")}\n` +
        "Spread inheritedTempEnv() (child writes where the caller writes), spread scopedTempEnv(dir) " +
        "(child is pinned at dir), or say inline why the child must not inherit them.",
    ).toEqual([]);
  });
});
