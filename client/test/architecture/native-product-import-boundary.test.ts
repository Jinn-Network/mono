import { readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const FORBIDDEN = [
  '/daemon/daemon.ts',
  '/daemon/composition-root.ts',
  '/daemon/bridge-legacy-delivery.ts',
  '/daemon/delivery-watcher.ts',
  '/harnesses/engine/engine.ts',
  '/types/task-document.ts',
  '/store/store.ts',
  '/harnesses/engine/**',
];

function runtimeRelativeImports(source: string): string[] {
  const runtimeSource = source
    .replace(/import\s+type\b[\s\S]*?;\s*/gu, '')
    .replace(/export\s+type\b[\s\S]*?;\s*/gu, '');
  const staticImports = [...runtimeSource.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu)]
    .map((match) => match[1]!);
  // native-main.ts reaches the real production wiring through a dynamic
  // `await import('./daemon/native-production-deployment.js')` — a static
  // regex over `import ... from` cannot see it, so it must be matched
  // separately or the BFS silently stops at the port-shaped stub graph.
  const dynamicImports = [...runtimeSource.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/gu)]
    .map((match) => match[1]!);
  return [...staticImports, ...dynamicImports];
}

function matchesForbidden(relativePath: string, pattern: string): boolean {
  return pattern.endsWith('/**')
    ? relativePath.startsWith(pattern.slice(0, -2))
    : relativePath === pattern;
}

/**
 * Dated, narrowly-scoped exemption list (added 2026-08-04, D0b hygiene fix).
 *
 * These three files are real, verified leaks on today's tree, reached from
 * `daemon/native-production-deployment.ts` (via the dynamic import at
 * `native-main.ts:43`) through `daemon/native-evaluator-production.ts` and
 * `daemon/native-solver-production.ts`, both of which construct the legacy
 * `Store` class. This list is a demolition backlog, not a standing waiver:
 * the guard still fails on any file that starts matching FORBIDDEN and is
 * not named here, and the `staleAllowlistEntries` check below fails if an
 * entry stops matching (i.e. the leak was actually fixed) so the backlog
 * can't quietly go stale.
 */
const KNOWN_LEAK_ALLOWLIST: Record<string, string> = {
  '/store/store.ts':
    'Constructed directly by daemon/native-evaluator-production.ts and ' +
    'daemon/native-solver-production.ts. Its constructor runs the legacy ' +
    '`task_runs` DDL (store.ts:610), creating the legacy table on the ' +
    'native path. Remove once native evaluator/solver production stop ' +
    'depending on the legacy Store class for persistence.',
  '/harnesses/engine/persistence.ts':
    'Pulled in transitively by store/store.ts, which imports ' +
    'TASK_RUNS_SCHEMA and TaskRunPersistence from it. Remove once ' +
    'store/store.ts no longer depends on the legacy TaskEngine ' +
    'persistence module (i.e. once the /store/store.ts entry above is gone).',
  '/harnesses/engine/state.ts':
    'Pulled in transitively by harnesses/engine/persistence.ts, which ' +
    'imports assertValidTransition and TERMINAL_STATES from it. Remove ' +
    'once harnesses/engine/persistence.ts is no longer part of the native ' +
    'production graph.',
};

function resolveModule(from: string, specifier: string): string | undefined {
  const raw = resolve(dirname(from), specifier).replace(/\.js$/u, '.ts');
  try { readFileSync(raw); return raw; } catch { return undefined; }
}

function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of runtimeRelativeImports(source)) {
      const next = resolveModule(file, specifier);
      if (next !== undefined && next.startsWith(SRC)) pending.push(next);
    }
  }
  return seen;
}

describe('native product import boundary', () => {
  it('cannot reach the compatibility daemon, bridges, TaskEngine, or delivery watcher', () => {
    const graph = new Set([
      ...importGraph(join(SRC, 'native-main.ts')),
      ...importGraph(join(SRC, 'daemon/native-operator-host.ts')),
      // native-main.ts's real production wiring lives behind a dynamic
      // import of this module (see runtimeRelativeImports above). Without
      // this root the BFS never leaves the ~6-file port-shaped stub graph
      // and the guard passes regardless of what the production wiring does.
      ...importGraph(join(SRC, 'daemon/native-production-deployment.ts')),
    ]);
    const relative = [...graph].map((file) => normalize(file).replace(normalize(SRC), ''));

    const unexpectedLeaks = relative.filter(
      (file) => FORBIDDEN.some((forbidden) => matchesForbidden(file, forbidden))
        && !(file in KNOWN_LEAK_ALLOWLIST),
    );
    expect(unexpectedLeaks).toEqual([]);

    // The allowlist is a demolition backlog, not a standing exemption: once a
    // leak is actually removed from the graph, its entry must be deleted too
    // or this catches the drift and forces the list to stay honest.
    const staleAllowlistEntries = Object.keys(KNOWN_LEAK_ALLOWLIST).filter(
      (entry) => !relative.includes(entry),
    );
    expect(staleAllowlistEntries).toEqual([]);

    expect(relative).toContain('/native-main.ts');
    expect(relative).toContain('/daemon/native-operator-host.ts');
  });

  it('contains no forbidden native fallback marker', () => {
    const source = [...importGraph(join(SRC, 'native-main.ts'))]
      .map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toContain('ephemeral-discovery-key');
    expect(source).not.toContain('acceptLegacyCards: true');
    expect(source).not.toContain('synthesizeLegacyExecutionDocuments');
    expect(source).not.toContain("archive.since('')");
  });
});
