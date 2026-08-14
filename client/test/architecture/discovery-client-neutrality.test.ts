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

/**
 * Drop `import type` / `export type` statements. Those edges are erased by the
 * compiler, so they do not decide whether a module still *runs* after
 * `discovery/` is deleted — only whether it still typechecks.
 */
function stripTypeOnlyStatements(source: string): string {
  return source
    .replace(/\bimport\s+type\s+[\s\S]*?from\s*['"][^'"]+['"]/gu, '')
    .replace(/\bexport\s+type\s+[\s\S]*?from\s*['"][^'"]+['"]/gu, '');
}

/** Breadth-first closure over relative imports, with the path that reached each file. */
function importClosure(
  entryPoints: string[],
  options: { valueOnly?: boolean } = {},
): Map<string, string[]> {
  const reachedVia = new Map<string, string[]>();
  const queue: Array<{ file: string; trail: string[] }> = entryPoints.map(
    (file) => ({ file, trail: [relative(SRC, file)] }),
  );
  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    if (reachedVia.has(file)) continue;
    reachedVia.set(file, trail);
    const source = readFileSync(file, 'utf-8');
    const scanned = options.valueOnly
      ? stripTypeOnlyStatements(source)
      : source;
    for (const specifier of relativeImports(scanned)) {
      const target = resolveSource(file, specifier);
      if (target && !reachedVia.has(target)) {
        queue.push({ file: target, trail: [...trail, relative(SRC, target)] });
      }
    }
  }
  return reachedVia;
}

/** Trails from `entryPoints` that land anywhere under `src/discovery/`. */
function leaksInto(closure: Map<string, string[]>): string[] {
  return [...closure.entries()]
    .filter(([file]) => file.startsWith(`${FORBIDDEN_DIR}/`))
    .map(([, trail]) => trail.join(' -> '))
    .sort();
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
    expect(leaksInto(importClosure(moduleFiles(MODULE_DIR)))).toEqual([]);
  });

  it('detects a leak when one is introduced', () => {
    // Guard the guard. After Wave-4 D4 there is no live file under
    // `src/discovery/`, so the walker cannot be seeded from a real import.
    // `leaksInto` itself must still flag a trail that lands in the retired
    // directory, or the production scan above is a tautology.
    const fake = new Map<string, string[]>([
      [join(FORBIDDEN_DIR, 'types.ts'), ['probe.ts', 'discovery/types.ts']],
    ]);
    expect(leaksInto(fake)).toEqual(['probe.ts -> discovery/types.ts']);
    expect(leaksInto(new Map([[join(MODULE_DIR, 'http.ts'), ['discovery-client/http.ts']]]))).toEqual([]);
  });

  /**
   * `jinn tasks observe-autopilot-delivery` is a PUBLISHED EXTERNAL BOUNDARY:
   * `Jinn-Network/autopilot` shells out to it and capability-probes for it.
   * R3b first retired the verb on a finding that it had no consumer; that
   * finding was wrong, so the verb is RELOCATED onto `discovery-client/`
   * instead. These pin the relocation that makes both things true at once —
   * the verb keeps working, and `discovery/` stays deletable.
   */
  const VERB = join(SRC, 'cli/commands/tasks-observe-autopilot.ts');
  const OBSERVER = join(SRC, 'autopilot/marketplace-delivery-observer.ts');

  it('routes the delivery verb and its observer at discovery-client only', () => {
    for (const file of [VERB, OBSERVER]) {
      const source = readFileSync(file, 'utf-8');
      expect(source, relative(SRC, file)).toMatch(/discovery-client\//u);
      // No import specifier may name the legacy tree. `discovery-client/...`
      // must not register as a match, hence the negative lookahead.
      expect(relativeImports(source).filter((s) => /(^|\/)discovery(?!-client)\//u.test(s)))
        .toEqual([]);
    }
  });

  it('gives the delivery verb no runtime path into src/discovery/', () => {
    expect(leaksInto(importClosure([VERB], { valueOnly: true }))).toEqual([]);
  });

  it('the delivery verb has no type-only path into the retired discovery tree', () => {
    // Wave-4 D4 deleted `adapters/mech/types.ts`'s `DiscoveryAPI` import.
    // A NEW coupling from the published verb into the retired tree must fail.
    expect(leaksInto(importClosure([VERB]))).toEqual([]);
  });

  it('declares DiscoveryUnavailableError once, in discovery-client', () => {
    // `instanceof DiscoveryUnavailableError` is checked at the HTTP and corpus
    // seams. A second class declaration would make those checks silently disagree.
    const owner = readFileSync(join(MODULE_DIR, 'types.ts'), 'utf-8');
    expect(owner).toMatch(/export class DiscoveryUnavailableError/u);
    const duplicates = moduleFiles(SRC)
      .filter((file) => !file.startsWith(`${MODULE_DIR}/`))
      .filter((file) => /export class DiscoveryUnavailableError/u.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(SRC, file));
    expect(duplicates).toEqual([]);
  });
});
