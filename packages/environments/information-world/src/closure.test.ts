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
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '\"\"')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function specifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1] as string);
}

const files = productionFiles(sourceRoot);
const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

describe("the replay service is structurally incapable of egress", () => {
  test("keeps a non-empty production surface under the scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test("allows node:http only in service.ts and only as createServer", () => {
    const importers = [...sources.entries()]
      .filter(([, source]) => specifiers(source).includes("node:http"))
      .map(([file]) => file.slice(file.lastIndexOf("/") + 1));
    expect(importers).toEqual(["service.ts"]);

    const service = sources.get(join(sourceRoot, "service.ts"));
    const statement = service?.match(/import\s*\{([^}]*)\}\s*from\s*["']node:http["']/);
    expect(statement?.[1]?.split(",").map((name) => name.trim()).filter(Boolean).sort())
      .toEqual(["createServer"]);
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
