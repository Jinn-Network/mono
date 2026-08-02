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
