/**
 * `discovery-client/` must survive the D-wave deletion of `discovery/`.
 *
 * One-swap R3b (issue #2494, DR-2026-08-05 addendum 2026-08-10 Decision 2)
 * relocated the four HTTP-indexer methods the surviving consumers drive
 * (`getAutopilotDeliveryCandidates`, `listLaunchedSolverNets`, `queryEnvelopes`,
 * `getCodeDigestRewards`) onto `client/src/discovery-client/`. That carve only
 * buys anything if the new module has NO path back into the legacy tree — a
 * single import, direct or transitive, and `rm -rf client/src/discovery/` breaks
 * it again.
 *
 * The guard walks the transitive closure of relative imports, not just the
 * direct ones, because the realistic regression is indirect: a shared type
 * module that itself imports `discovery/types.js` (this is exactly what
 * `corpus/types.ts` did before R3b narrowed its `discovery` field to core's
 * one-method `CorpusDiscoveryPort`).
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const MODULE_DIR = join(SRC, 'discovery-client');
const FORBIDDEN_DIR = join(SRC, 'discovery');

/** Every relative import specifier in a source file, type-only included. */
function relativeImports(source: string): string[] {
  const statics = [...source.matchAll(
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu,
  )].map((match) => match[1]!);
  // Inline `import('...')` type positions and dynamic imports alike — the
  // `corpus/types.ts` edge this guard exists for was written that way.
  const inline = [...source.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/gu)]
    .map((match) => match[1]!);
  return [...statics, ...inline];
}

/** Resolve an emitted-JS specifier back to the TypeScript source on disk. */
function resolveSource(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/u, '.ts'),
    base.replace(/\.js$/u, '.tsx'),
    base,
    `${base}.ts`,
    join(base, 'index.ts'),
  ];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile())
    ?? null;
}

function moduleFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return moduleFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Breadth-first closure over relative imports, with the path that reached each file. */
function importClosure(entryPoints: string[]): Map<string, string[]> {
  const reachedVia = new Map<string, string[]>();
  const queue: Array<{ file: string; trail: string[] }> = entryPoints.map(
    (file) => ({ file, trail: [relative(SRC, file)] }),
  );
  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    if (reachedVia.has(file)) continue;
    reachedVia.set(file, trail);
    for (const specifier of relativeImports(readFileSync(file, 'utf-8'))) {
      const target = resolveSource(file, specifier);
      if (target && !reachedVia.has(target)) {
        queue.push({ file: target, trail: [...trail, relative(SRC, target)] });
      }
    }
  }
  return reachedVia;
}

describe('discovery-client survives the discovery/ deletion', () => {
  it('has source files to guard', () => {
    const files = moduleFiles(MODULE_DIR);
    expect(files.length).toBeGreaterThan(0);
    // The relocated slice is the point of the module; if http.ts stopped
    // existing the closure below would pass vacuously.
    expect(files.map((file) => relative(MODULE_DIR, file)).sort())
      .toContain('http.ts');
  });

  it('reaches no module under src/discovery/, directly or transitively', () => {
    const closure = importClosure(moduleFiles(MODULE_DIR));
    const leaks = [...closure.entries()]
      .filter(([file]) => file.startsWith(`${FORBIDDEN_DIR}/`))
      .map(([, trail]) => trail.join(' -> '))
      .sort();
    expect(leaks).toEqual([]);
  });

  it('detects a leak when one is introduced', () => {
    // Guard the guard: the closure walker must actually follow a relative
    // import into discovery/, otherwise the assertion above is decorative.
    const probe = join(SRC, 'discovery/types.ts');
    expect(existsSync(probe)).toBe(true);
    const closure = importClosure([probe]);
    expect([...closure.keys()].some((file) => file.startsWith(`${FORBIDDEN_DIR}/`)))
      .toBe(true);
  });

  it('keeps the legacy DiscoveryAPI on one relocated error class', () => {
    // `instanceof DiscoveryUnavailableError` is checked in both trees. A second
    // class declaration would make those checks silently disagree.
    const legacy = readFileSync(join(FORBIDDEN_DIR, 'types.ts'), 'utf-8');
    expect(legacy).not.toMatch(/class\s+DiscoveryUnavailableError/u);
    expect(legacy).toMatch(
      /export\s*\{\s*DiscoveryUnavailableError\s*\}\s*from\s*'\.\.\/discovery-client\/types\.js'/u,
    );
  });
});
