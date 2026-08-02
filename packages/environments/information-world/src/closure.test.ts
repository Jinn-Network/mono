import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const sourceRoot = new URL("./", import.meta.url).pathname;

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const path = join(directory, item.name);
    if (item.isDirectory()) return productionFiles(path);
    if (!item.name.endsWith(".ts") || item.name.endsWith(".test.ts")) return [];
    if (item.name === "fixtures.ts" || item.name === "testing.ts") return [];
    return [path];
  });
}

function executableSource(source: string): string {
  return withoutComments(source)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '\"\"')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function withoutComments(source: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index);
    const next = source.charAt(index + 1);
    if (quote !== undefined) {
      result += character;
      if (character === "\\") {
        result += next;
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source.charAt(index) !== "\n") {
        result += " ";
        index += 1;
      }
      result += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (index < source.length && !(source.charAt(index) === "*" && source.charAt(index + 1) === "/")) {
        result += source.charAt(index) === "\n" ? "\n" : " ";
        index += 1;
      }
      result += " ";
      index += 1;
      continue;
    }
    result += character;
  }
  return result;
}

function specifiers(source: string): string[] {
  const executable = withoutComments(source);
  return [
    ...executable.matchAll(/\b(?:import|export)\s+(?:(?:(?!;)[\s\S])*?\s+from\s+)?["']([^"'\r\n]+)["']/g),
    ...executable.matchAll(/\b(?:import|require)\s*\(\s*(?:["']([^"'\r\n]+)["']|`([^`]*)`)\s*\)/g),
  ].map((match) => (match[1] ?? match[2]) as string);
}

function nodeHttpBindings(source: string): string[] {
  const statement = withoutComments(source).match(/import\s*\{([^}]*)\}\s*from\s*["']node:http["']/);
  return statement?.[1]?.split(",").map((name) => name.trim()).filter(Boolean).sort() ?? [];
}

type LexicalToken = { readonly kind: "identifier" | "string" | "punctuation"; readonly value: string };

function lexicalTokens(source: string): LexicalToken[] {
  const tokens: LexicalToken[] = [];
  for (let index = 0; index < source.length;) {
    const character = source.charAt(index);
    const next = source.charAt(index + 1);
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source.charAt(index) !== "\n" && source.charAt(index) !== "\r") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      let value = "";
      index += 1;
      while (index < source.length && source.charAt(index) !== quote) {
        if (source.charAt(index) === "\\") {
          value += source.slice(index, index + 2);
          index += 2;
        } else {
          value += source.charAt(index);
          index += 1;
        }
      }
      if (source.charAt(index) === quote) index += 1;
      tokens.push({ kind: "string", value });
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source.charAt(index))) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return tokens;
}

function memberEnd(tokens: readonly LexicalToken[], index: number, name: string): number | undefined {
  if (tokens[index]?.value === "." && tokens[index + 1]?.kind === "identifier"
    && tokens[index + 1]?.value === name) return index + 2;
  if (tokens[index]?.value === "?" && tokens[index + 1]?.value === "."
    && tokens[index + 2]?.kind === "identifier" && tokens[index + 2]?.value === name) return index + 3;
  if (tokens[index]?.value === "[" && tokens[index + 1]?.kind === "string"
    && tokens[index + 1]?.value === name && tokens[index + 2]?.value === "]") return index + 3;
  if (tokens[index]?.value === "?" && tokens[index + 1]?.value === "."
    && tokens[index + 2]?.value === "[" && tokens[index + 3]?.kind === "string"
    && tokens[index + 3]?.value === name && tokens[index + 4]?.value === "]") return index + 5;
  return undefined;
}

function reflectiveBuiltinLoaderUses(source: string): string[] {
  const tokens = lexicalTokens(source);
  const findings: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    let processEnd: number | undefined;
    let label: string | undefined;
    if (tokens[index]?.kind === "identifier" && tokens[index]?.value === "process"
      && tokens[index - 1]?.value !== "." && tokens[index - 1]?.value !== "]") {
      processEnd = index + 1;
      label = "process";
    } else if (tokens[index]?.kind === "identifier"
      && (tokens[index]?.value === "globalThis" || tokens[index]?.value === "global")) {
      processEnd = memberEnd(tokens, index + 1, "process");
      label = tokens[index]?.value;
    }
    if (processEnd === undefined || label === undefined) continue;
    const loaderEnd = memberEnd(tokens, processEnd, "getBuiltinModule");
    if (loaderEnd !== undefined) {
      findings.push(`${label}.process`.replace("process.process", "process") + ".getBuiltinModule");
    }
  }
  return findings;
}

// The replay package has no need for ambient authority. Rejecting each root at its first
// lexical use is intentionally stricter than chasing aliases (for example `const p = process`)
// and keeps a future loader or evaluator from escaping the static-import boundary.
function ambientAuthorityUses(source: string): string[] {
  const forbidden = new Set([
    "process", "globalThis", "global", "window", "self", "Function", "eval", "require",
  ]);
  return lexicalTokens(source)
    .filter((token) => token.kind === "identifier" && forbidden.has(token.value))
    .map((token) => token.value);
}

function hasDynamicModuleLoad(source: string): boolean {
  const tokens = lexicalTokens(source);
  return tokens.some((token, index) => token.kind === "identifier"
    && (token.value === "import" || token.value === "require")
    && tokens[index + 1]?.value === "(");
}

const files = productionFiles(sourceRoot);
const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

describe("the replay service is structurally incapable of egress", () => {
  test("keeps a non-empty production surface under the scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test("allows node:http only in service.ts and only as createServer", () => {
    const nodeSpecifiers = [...sources.entries()].flatMap(([file, source]) =>
      specifiers(source).filter((specifier) => specifier.startsWith("node:")).map((specifier) => ({ file, specifier })));
    expect(nodeSpecifiers.map(({ specifier }) => specifier)).toEqual(["node:http"]);
    expect(nodeSpecifiers.map(({ file }) => file.slice(file.lastIndexOf("/") + 1))).toEqual(["service.ts"]);

    const service = sources.get(join(sourceRoot, "service.ts"));
    expect(nodeHttpBindings(service ?? "")).toEqual(["createServer"]);
  });

  test("scanner canaries cover comments, every import form, and template interpolation", () => {
    const source = [
      '// import "node:tls" must stay a comment',
      '/* import { request } from "node:http" must stay a comment */',
      'import {',
      '  createServer,',
      '} from "node:http";',
      'import * as socket',
      '  from "node:net";',
      'import client',
      '  from "node:https";',
      'import "node:dns";',
      'export { lookup } from "node:dns/promises";',
      'await import("node:http2");',
      'require("node:dgram");',
      'await import(`node:${"worker_threads"}`);',
    ].join("\n");

    expect(specifiers(source)).toEqual([
      "node:http",
      "node:net",
      "node:https",
      "node:dns",
      "node:dns/promises",
      "node:http2",
      "node:dgram",
      'node:${"worker_threads"}',
    ]);
    expect(nodeHttpBindings(source)).toEqual(["createServer"]);

    const reflective = [
      'const direct = process.getBuiltinModule(`node:${"http"}`);',
      'const optional = globalThis.process?.["getBuiltinModule"]("node:" + "http");',
      'const bracketed = global["process"]["getBuiltinModule"](`node:${"http"}`);',
      '// process.getBuiltinModule("node:http") stays a comment',
    ].join("\n");
    expect(reflectiveBuiltinLoaderUses(reflective)).toEqual([
      "process.getBuiltinModule",
      "globalThis.process.getBuiltinModule",
      "global.process.getBuiltinModule",
    ]);
    expect(reflectiveBuiltinLoaderUses(
      'const alias = process.getBuiltinModule; alias(`node:${"http"}`).request;',
    )).toEqual(["process.getBuiltinModule"]);
    expect(ambientAuthorityUses(
      'const p = process; const m = p.getBuiltinModule("node:http"); const { request: dial } = m; dial();',
    )).toEqual(["process"]);
    expect(ambientAuthorityUses(
      'const g = globalThis; const build = Function; const run = eval; const load = require;',
    )).toEqual(["globalThis", "Function", "eval", "require"]);
  });

  test("imports no other node builtin or network client", () => {
    const forbidden = new Set([
      "node:https", "node:net", "node:tls", "node:dns", "node:dgram", "node:http2",
      "node:child_process", "node:worker_threads", "node:cluster", "node:fs", "node:fs/promises",
      "undici", "axios", "node-fetch", "got", "superagent", "ws",
    ]);
    const findings = [...sources.entries()].flatMap(([file, source]) =>
      specifiers(source).filter((specifier) => forbidden.has(specifier)).map((specifier) => `${file}:${specifier}`));
    expect(findings).toEqual([]);
  });

  test("contains no dynamic, require, or reflective module loader in production source", () => {
    const findings = [...sources.entries()].flatMap(([file, source]) => [
      ...(hasDynamicModuleLoad(source) ? [`${file}:dynamic module loader`] : []),
      ...reflectiveBuiltinLoaderUses(source).map((loader) => `${file}:${loader}`),
      ...ambientAuthorityUses(source).map((root) => `${file}:${root}`),
    ]);
    expect(findings).toEqual([]);
  });

  test("names no ambient network API, raw client method, or code evaluator", () => {
    const patterns = [
      /(?<![\w$.])fetch\s*\(/,
      /(?<![\w$.])(?:WebSocket|EventSource|XMLHttpRequest)\b/,
      /\b(?:globalThis|global|window|self)\s*(?:\.|\?\.|\[)/,
      /\b(?:https?|net|tls|dns)\s*\.\s*(?:request|get|connect|createConnection|lookup)\s*\(/,
      /\bnew\s+(?:Agent|Socket|Function)\s*\(/,
      /(?<![\w$.])eval\s*\(/,
      /\bimport\s*\(/,
    ];
    const findings = [...sources.entries()].flatMap(([file, source]) => {
      const executable = executableSource(source);
      return patterns.filter((pattern) => pattern.test(executable)).map((pattern) => `${file}:${pattern.source}`);
    });
    expect(findings).toEqual([]);
  });

  test("does not inspect a corpus body before copying it to the response", () => {
    const service = executableSource(sources.get(join(sourceRoot, "service.ts")) ?? "");
    expect(/\bbody\s*\.\s*(?:includes|indexOf|match|search|test)\s*\(/.test(service)).toBe(false);
    expect(/JSON\s*\.\s*parse\s*\(\s*(?:body|bytes)/.test(service)).toBe(false);
  });
});
