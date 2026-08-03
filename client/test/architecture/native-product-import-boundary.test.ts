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
];

function runtimeRelativeImports(source: string): string[] {
  const runtimeSource = source
    .replace(/import\s+type\b[\s\S]*?;\s*/gu, '')
    .replace(/export\s+type\b[\s\S]*?;\s*/gu, '');
  return [...runtimeSource.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu)]
    .map((match) => match[1]!);
}

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
    ]);
    const relative = [...graph].map((file) => normalize(file).replace(normalize(SRC), ''));
    for (const forbidden of FORBIDDEN) expect(relative).not.toContain(forbidden);
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
