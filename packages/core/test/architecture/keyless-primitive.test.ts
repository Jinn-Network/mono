import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECIFIER } from './import-scan.js';

/**
 * Issue #4179: the artifact retrieval primitive is keyless and
 * filesystem-neutral *by construction*, and this holds its module graph to
 * that. The type signature already admits no store, key, or path — but a type
 * cannot stop a future edit from reaching for `node:fs` inside the function
 * body, which is exactly how "returns bytes, decides nothing" would rot into
 * "writes them somewhere".
 *
 * The walk seeds at the primitive and follows only relative specifiers, so it
 * covers the primitive plus everything it pulls in from `corpus-read/`. Bare
 * specifiers are checked but not followed — a forbidden package is caught at
 * the import, and a third-party package's own graph is not core's to police.
 */
const pkgRoot = fileURLToPath(new URL('../../', import.meta.url));
const PRIMITIVE = join(pkgRoot, 'src', 'corpus-read', 'artifact-retrieval.ts');

const FORBIDDEN_EXACT = [
  'node:fs', 'node:fs/promises', 'node:path', 'fs', 'path', 'better-sqlite3',
  // Each of these is a route back to the filesystem or to key material even
  // though none of them is named `fs`: `node:module` can `createRequire` its
  // way to any of them, and both `node:child_process` and `node:worker_threads`
  // run code that is under no obligation to honor this guard.
  'node:module', 'module', 'node:child_process', 'child_process',
  'node:worker_threads', 'worker_threads',
];
const FORBIDDEN_PATTERN = /store|keystore|signer|wallet|privateKey|vault|secret|credential/i;

function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1]!);
}

function forbidden(spec: string): boolean {
  return FORBIDDEN_EXACT.includes(spec) || FORBIDDEN_PATTERN.test(spec);
}

function posix(p: string): string {
  return p.split(sep).join('/');
}

/** Resolve an ESM relative specifier to the `.ts` source it was compiled from. */
function resolveRelative(fromFile: string, spec: string): string {
  const joined = normalize(join(dirname(fromFile), spec));
  return joined.endsWith('.js') ? `${joined.slice(0, -'.js'.length)}.ts` : `${joined}.ts`;
}

/** Every `.ts` file reachable from `entry` through relative imports, plus its violations. */
function walk(entry: string): { visited: string[]; violations: string[] } {
  const visited: string[] = [];
  const violations: string[] = [];
  const queue = [entry];
  const seen = new Set<string>([entry]);

  while (queue.length > 0) {
    const file = queue.shift()!;
    visited.push(file);
    const source = readFileSync(file, 'utf-8');
    for (const spec of specifiers(source)) {
      if (forbidden(spec)) {
        violations.push(`${posix(relative(pkgRoot, file))} -> ${spec}`);
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const resolved = resolveRelative(file, spec);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return { visited, violations };
}

describe('artifact retrieval primitive stays keyless and filesystem-neutral (#4179)', () => {
  const { visited, violations } = walk(PRIMITIVE);

  it('imports no filesystem, store, or key-material module anywhere in its closure', () => {
    expect(
      violations.sort(),
      'The retrieval primitive must fetch and verify only — it never writes to disk, '
        + 'never touches a store, and never holds key material:\n'
        + violations.join('\n'),
    ).toEqual([]);
  });

  it('actually walked the closure rather than passing on an empty scan', () => {
    expect(visited).toContain(PRIMITIVE);
    // The primitive imports fetch-artifact, ipfs, and types; those pull in more.
    expect(visited.length).toBeGreaterThan(1);
  });

  it('detects a forbidden specifier when one is present', () => {
    // Mutation check: prove the matcher fires, so the guard above cannot pass
    // by silently matching nothing.
    expect(specifiers(`import { x } from 'node:fs';`).some(forbidden)).toBe(true);
    expect(specifiers(`import { s } from './store.js';`).some(forbidden)).toBe(true);
    expect(specifiers(`import { k } from './keystore/index.js';`).some(forbidden)).toBe(true);
    expect(specifiers(`import { createRequire } from 'node:module';`).some(forbidden)).toBe(true);
    expect(specifiers(`import { spawn } from 'node:child_process';`).some(forbidden)).toBe(true);
    expect(specifiers(`import { Worker } from 'node:worker_threads';`).some(forbidden)).toBe(true);
    expect(specifiers(`import { v } from './vault.js';`).some(forbidden)).toBe(true);
    expect(specifiers(`import { s } from './secrets.js';`).some(forbidden)).toBe(true);
    expect(specifiers(`import { c } from './credentials.js';`).some(forbidden)).toBe(true);
    expect(specifiers(`import { c } from 'node:crypto';`).some(forbidden)).toBe(false);
  });
});
