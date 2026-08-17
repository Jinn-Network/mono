import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Forbidden-import architecture test for #1658 (AC3). Scans every module
 * under src/ for specifiers the package-architecture spec §6 forbids:
 * operator/src, any sibling @jinn-network/* package (this package depends on
 * zod only), viem, the MCP SDK, node:fs/net/child_process, and process.env
 * reads. node:crypto is explicitly permitted (used by plugin.ts for
 * randomUUID()). Matches both static `from '<spec>'` imports and dynamic
 * `import('<spec>')` / `require('<spec>')` call forms.
 */
function specifierRegex(innerPattern: string): RegExp {
  return new RegExp(
    `from\\s+['"]${innerPattern}['"]` +
      `|(?:import|require)\\(\\s*['"]${innerPattern}['"]\\s*\\)` +
      `|import\\s+['"]${innerPattern}['"]`,
  );
}

const FORBIDDEN_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'operator/src', regex: specifierRegex('[^\'"]*\\boperator\\/src\\/[^\'"]*') },
  { label: '@jinn-network/*', regex: specifierRegex('@jinn-network\\/[^\'"]*') },
  { label: 'viem', regex: specifierRegex('viem') },
  { label: '@modelcontextprotocol/sdk', regex: specifierRegex('@modelcontextprotocol\\/sdk(\\/[^\'"]*)?') },
  { label: 'node:fs|node:net|node:child_process', regex: specifierRegex('node:(fs|net|child_process)') },
  { label: 'process.env', regex: /process\.env/ },
  // Bare global network calls (not method calls on an object): a preceding
  // `.` or word char means it's `corpus.fetch(` / `this.fetch(`, which is fine.
  { label: 'global fetch()', regex: /(?<![.\w])fetch\s*\(/ },
  { label: 'global WebSocket()', regex: /(?<![.\w])WebSocket\s*\(/ },
  { label: 'global XMLHttpRequest()', regex: /(?<![.\w])XMLHttpRequest\s*\(/ },
];

export function findForbiddenImports(sourceText: string): string[] {
  const offenders: string[] = [];
  for (const line of sourceText.split('\n')) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.regex.test(line)) {
        offenders.push(`${pattern.label}: ${line.trim()}`);
      }
    }
  }
  return offenders;
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('src → forbidden-import boundary (#1658)', () => {
  it('no module under src/ imports a forbidden specifier', () => {
    const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
    const offenders: string[] = [];
    for (const file of walkTsFiles(srcDir)) {
      const found = findForbiddenImports(readFileSync(file, 'utf-8'));
      if (found.length > 0) offenders.push(`${file}:\n  ${found.join('\n  ')}`);
    }
    expect(offenders, `forbidden imports found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('canary: findForbiddenImports flags a synthetic forbidden import (AC3)', () => {
    const synthetic = [
      "import { createPublicClient } from 'viem';",
      "import fs from 'node:fs';",
      "import { Client } from '@modelcontextprotocol/sdk';",
      "import { something } from 'operator/src/foo.js';",
      "const token = process.env.SECRET;",
    ].join('\n');
    const found = findForbiddenImports(synthetic);
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found.some((f) => f.includes('viem'))).toBe(true);
    expect(found.some((f) => f.includes('process.env'))).toBe(true);
  });

  it('does not flag the permitted node:crypto import', () => {
    const found = findForbiddenImports("import { randomUUID } from 'node:crypto';");
    expect(found).toEqual([]);
  });

  it('flags sibling packages the original pattern missed, e.g. @jinn-network/client', () => {
    const found = findForbiddenImports("import { Daemon } from '@jinn-network/client';");
    expect(found.length).toBeGreaterThanOrEqual(1);
  });

  it('flags @jinn-network/eng-loop, another sibling the original pattern missed', () => {
    const found = findForbiddenImports("import { run } from '@jinn-network/eng-loop';");
    expect(found.length).toBeGreaterThanOrEqual(1);
  });

  it('canary: findForbiddenImports flags a dynamic import() of a forbidden specifier (AC3)', () => {
    const found = findForbiddenImports("const viem = await import('viem');");
    expect(found.some((f) => f.includes('viem'))).toBe(true);
  });

  it('canary: findForbiddenImports flags a require() of a forbidden specifier (AC3)', () => {
    const found = findForbiddenImports("const cp = require('node:child_process');");
    expect(found.length).toBeGreaterThanOrEqual(1);
  });

  it('canary: flags a bare global fetch() call (#1696 AC1)', () => {
    const found = findForbiddenImports("const res = await fetch('https://x');");
    expect(found.some((f) => f.includes('global fetch()'))).toBe(true);
  });

  it('canary: flags a bare global WebSocket() construction (#1696 AC1)', () => {
    const found = findForbiddenImports("const ws = new WebSocket('wss://x');");
    expect(found.some((f) => f.includes('global WebSocket()'))).toBe(true);
  });

  it('canary: flags a bare global XMLHttpRequest() construction (#1696 AC1)', () => {
    const found = findForbiddenImports('const xhr = new XMLHttpRequest();');
    expect(found.some((f) => f.includes('global XMLHttpRequest()'))).toBe(true);
  });

  it('canary: flags a side-effect import of a forbidden specifier (#1696 AC1)', () => {
    const found = findForbiddenImports("import 'viem';");
    expect(found.some((f) => f.includes('viem'))).toBe(true);
  });

  it('does not flag a method call named fetch on an object (#1696 AC1)', () => {
    const found = findForbiddenImports('const r = await this.deps.corpus.search(x); const f = foo.fetch(x);');
    expect(found).toEqual([]);
  });
});
