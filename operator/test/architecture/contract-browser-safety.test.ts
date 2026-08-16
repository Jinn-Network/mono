import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Browser-safety architecture test for
 * spec/2026-08-04-headless-operator-rederivation-design.md §8 artifact 2.
 *
 * `operator/src/api/contract/` is imported directly by the operator dashboard SPA (a Vite
 * browser build with no Node polyfills). Everything the contract module's modules
 * *value*-import (as opposed to `import type`, which `tsc`/`vite` erase at build time and
 * never reaches the bundled JS) must itself be browser-safe: no Node builtins, and no
 * value-import chain that eventually reaches one. `import type` references to daemon-side
 * modules (e.g. `status.ts`'s comments naming the daemon module a schema mirrors) are
 * exempt by construction — they never appear as *value* imports here.
 *
 * This walks the value-import graph starting from every file in `src/api/contract/`,
 * following only relative specifiers that resolve to a file inside `operator/src` (bare
 * specifiers like `zod/v4` are external packages, out of scope for this check), and fails
 * if any visited file value-imports a `node:` builtin.
 */
const contractDir = fileURLToPath(new URL('../../src/api/contract/', import.meta.url));
const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));

function contractSourceFiles(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(contractDir)) {
    const full = join(contractDir, name);
    if (statSync(full).isDirectory()) continue;
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

interface ImportLine {
  isTypeOnly: boolean;
  specifier: string;
}

const IMPORT_RE = /^import\s+(type\s+)?(?:[^'"]*?)from\s+['"]([^'"]+)['"]/gm;
// Also catch `export * from '...'` / `export type {...} from '...'` re-exports.
const EXPORT_FROM_RE = /^export\s+(type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm;

function parseImports(src: string): ImportLine[] {
  const out: ImportLine[] = [];
  for (const re of [IMPORT_RE, EXPORT_FROM_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      out.push({ isTypeOnly: m[1] !== undefined, specifier: m[2] });
    }
  }
  return out;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const withoutExt = specifier.replace(/\.js$/, '');
  const base = resolve(dirname(fromFile), withoutExt);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe('contract module browser safety (§8 artifact 2)', () => {
  it('no value-import in src/api/contract/ (or its transitive value-import graph, ' +
    'bounded to operator/src) is a Node builtin', () => {
    const offenders: string[] = [];
    const visited = new Set<string>();
    const queue = contractSourceFiles();

    while (queue.length > 0) {
      const file = queue.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);
      if (!file.startsWith(srcRoot)) continue; // stay inside operator/src

      const src = readFileSync(file, 'utf-8');
      for (const { isTypeOnly, specifier } of parseImports(src)) {
        if (isTypeOnly) continue; // erased at build — never reaches the bundle
        if (specifier.startsWith('node:')) {
          offenders.push(`${file}: value-imports Node builtin '${specifier}'`);
          continue;
        }
        const resolved = resolveRelative(file, specifier);
        if (resolved) queue.push(resolved);
        // Bare non-node specifiers (e.g. 'zod/v4') are external packages — out of scope.
      }
    }

    expect(offenders, `Node-builtin value-imports reachable from src/api/contract/:\n${offenders.join('\n')}`).toEqual([]);
  });
});
