// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const STATE_PREDICATE_DIR = fileURLToPath(new URL("./", import.meta.url));
const PROFILES_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENTRY = join(STATE_PREDICATE_DIR, "evaluate.ts");

const ALLOWED_EXTERNAL_IMPORTS = ["@noble/hashes/sha3.js", "zod"];

const FORBIDDEN_CAPABILITIES = [
  { name: "node builtin", pattern: /["']node:[a-z_/]+["']/g },
  { name: "network", pattern: /(?<![\w$."'`])(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/g },
  { name: "clock", pattern: /(?<![\w$."'`])(?:Date|performance|hrtime)\b/g },
  { name: "randomness", pattern: /Math\s*\.\s*random\b/g },
  { name: "ambient host", pattern: /(?<![\w$."'`])(?:process|globalThis|global)\b/g },
];

const ENCODER_PATTERN =
  /\b(?:encodeFunctionData|encodeAbiParameters|abiCoder|AbiCoder|keccak256|toFunctionSelector|encodePacked)\b/g;

const BOUNDED_CLAIMS_PATTERN =
  /\b(?:verified|verifies|verify|verification|correct|correctly|proves|proven|guarantees)\b/gi;

const FIXTURE_DIRS = [
  join(PROFILES_ROOT, "fixtures/state-predicate-block"),
  join(PROFILES_ROOT, "fixtures/state-predicate-evaluation"),
];

function stripTypeImports(source: string): string {
  return source.replace(/import\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?/g, "");
}

function extractValueImportSpecifiers(source: string): string[] {
  const withoutTypeImports = stripTypeImports(source);
  const specifiers: string[] = [];
  const importRegex = /import\s+(?!type\b)(?:[\w*{}\s,$\n\r.]+?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of withoutTypeImports.matchAll(importRegex)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveRelativeImport(fromPath: string, specifier: string): string {
  const dir = dirname(fromPath);
  let resolved = resolve(dir, specifier);
  if (resolved.endsWith(".js")) {
    resolved = `${resolved.slice(0, -3)}.ts`;
  } else if (!resolved.endsWith(".ts")) {
    resolved = `${resolved}.ts`;
  }
  return resolved;
}

function collectClosure(entryPath: string): string[] {
  const visited = new Set<string>();
  const queue = [entryPath];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current) || current.endsWith(".test.ts")) {
      continue;
    }
    if (!existsSync(current)) {
      continue;
    }
    visited.add(current);

    const source = readFileSync(current, "utf8");
    for (const specifier of extractValueImportSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeImport(current, specifier);
        if (!visited.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
  }

  return [...visited].sort();
}

function scanForbiddenCapabilities(source: string): Array<{ capability: string; match: string }> {
  const stripped = stripTypeImports(source);
  const findings: Array<{ capability: string; match: string }> = [];
  for (const { name, pattern } of FORBIDDEN_CAPABILITIES) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of stripped.matchAll(regex)) {
      findings.push({ capability: name, match: match[0] });
    }
  }
  return findings;
}

function scanEncoders(source: string): string[] {
  const stripped = stripTypeImports(source);
  return [...stripped.matchAll(ENCODER_PATTERN)].map((match) => match[0]);
}

function scanBoundedClaims(text: string): string[] {
  return [...text.matchAll(BOUNDED_CLAIMS_PATTERN)].map((match) => match[0]);
}

function listFixtureFileNames(directory: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      names.push(...listFixtureFileNames(path));
    } else {
      names.push(entry.name);
    }
  }
  return names;
}

describe("state-predicate evaluator purity", () => {
  const closure = collectClosure(ENTRY);

  it("walks the module closure from evaluate.ts", () => {
    expect(closure).toContain(ENTRY);
    expect(closure.some((path) => path.endsWith("/evaluate.ts"))).toBe(true);
    expect(closure.some((path) => path.endsWith("/vocabulary.ts"))).toBe(true);
    expect(closure.some((path) => path.endsWith("/errors.ts"))).toBe(true);
  });

  it("allows only zod and @noble/hashes/sha3.js as external value imports", () => {
    const external = new Set<string>();
    for (const path of closure) {
      const source = readFileSync(path, "utf8");
      for (const specifier of extractValueImportSpecifiers(source)) {
        if (!specifier.startsWith(".")) {
          external.add(specifier);
        }
      }
    }
    const sorted = [...external].sort();
    if (sorted.join(",") !== ALLOWED_EXTERNAL_IMPORTS.join(",")) {
      const offenders = sorted.filter((specifier) => !ALLOWED_EXTERNAL_IMPORTS.includes(specifier));
      const unexpected = offenders.map((specifier) => {
        const files = closure.filter((path) => extractValueImportSpecifiers(readFileSync(path, "utf8")).includes(specifier));
        return `${specifier} in ${files.join(", ")}`;
      });
      expect(sorted, `disallowed external import(s): ${unexpected.join("; ")}`).toEqual(ALLOWED_EXTERNAL_IMPORTS);
    }
    expect(sorted).toEqual(ALLOWED_EXTERNAL_IMPORTS);
  });

  it("imports no forbidden host capabilities across the closure", () => {
    const findings: string[] = [];
    for (const path of closure) {
      const source = readFileSync(path, "utf8");
      for (const { capability, match } of scanForbiddenCapabilities(source)) {
        findings.push(`${path}: ${capability} -> ${match}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it("meta-test: the forbidden-capability scanner finds exactly five forms", () => {
    const fixture = [
      'import fs from "node:fs";',
      "const r = fetch(url);",
      "const now = Date.now();",
      "const n = Math.random();",
      "const g = globalThis;",
    ].join("\n");
    const findings = scanForbiddenCapabilities(fixture);
    expect(findings).toHaveLength(5);
    expect(new Set(findings.map((finding) => finding.capability)).size).toBe(5);
  });

  it("defines no ABI encoders across the closure (CE3 encodes, CE2 keys and compares)", () => {
    const findings: string[] = [];
    for (const path of closure) {
      for (const match of scanEncoders(readFileSync(path, "utf8"))) {
        findings.push(`${path}: encoder -> ${match} (CE3 encodes, CE2 keys and compares)`);
      }
    }
    expect(findings).toEqual([]);
  });

  it("meta-test: the encoder scanner finds every forbidden encoder form", () => {
    const fixture = [
      "encodeFunctionData({})",
      "encodeAbiParameters([], [])",
      "abiCoder.encode",
      "new AbiCoder()",
      "keccak256(data)",
      "toFunctionSelector(sig)",
      "encodePacked(types, values)",
    ].join("\n");
    const findings = scanEncoders(fixture);
    expect(findings).toHaveLength(7);
  });

  it("uses bounded claims vocabulary across the closure and fixture file names", () => {
    const findings: string[] = [];
    for (const path of closure) {
      const source = readFileSync(path, "utf8");
      for (const match of scanBoundedClaims(source)) {
        findings.push(`${path}: bounded-claims violation -> ${match} (use satisfied / violated / unevaluable; reference §5.1 or the closed-state protocol instead)`);
      }
    }
    for (const directory of FIXTURE_DIRS) {
      for (const name of listFixtureFileNames(directory)) {
        for (const match of scanBoundedClaims(name)) {
          findings.push(`${directory}/${name}: bounded-claims violation in file name -> ${match}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });
});

describe("state-predicate evaluator purity helpers", () => {
  it("strips import type before scanning", () => {
    const source = [
      'import type { Foo } from "@jinn-network/task-execution-protocol";',
      "const x = Date.now();",
    ].join("\n");
    expect(scanForbiddenCapabilities(source)).toHaveLength(1);
    expect(scanForbiddenCapabilities(source)[0]?.capability).toBe("clock");
  });

  it("does not follow test files in the closure", () => {
    const closure = collectClosure(ENTRY);
    expect(closure.some((path) => path.endsWith(".test.ts"))).toBe(false);
  });

  it("writes and removes a temporary fixture for meta-tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-meta-"));
    try {
      const fixturePath = join(dir, "fixture.ts");
      writeFileSync(fixturePath, 'import "node:fs";');
      expect(scanForbiddenCapabilities(readFileSync(fixturePath, "utf8"))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
