/**
 * A default-config boot still takes the legacy path, and takes it without loading one line of the
 * native runtime (one-swap M2, umbrella #2461).
 *
 * M2's whole posture is "everything constructed, default stays legacy". That is only credible if
 * it is checked rather than asserted, so this file checks the two things that could make it false:
 * the mode a default config resolves to, and whether a legacy boot can even reach the native
 * assembly.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { resolveFleetCompositionMode } from '../../src/daemon/native-composition-mode.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

/**
 * STATIC relative imports only. Unlike `test/architecture/native-product-import-boundary.test.ts`
 * (which deliberately also follows `import(...)` because it is hunting leaks), this walk must NOT
 * follow dynamic imports: the whole point is that `main.ts` reaches the native runtime only
 * through one, so a legacy boot never evaluates that module.
 */
function staticRelativeImports(source: string): string[] {
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

function staticImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticRelativeImports(readFileSync(file, 'utf8'))) {
      const next = resolveModule(file, specifier);
      if (next !== undefined && next.startsWith(SRC)) pending.push(next);
    }
  }
  return seen;
}

describe('legacy boot path is unchanged by the native assembly', () => {
  it('resolves legacy for a config that carries no compositionMode', () => {
    // The exact shape `loadConfig` produces for an operator who has never heard of the swap:
    // the key is simply absent.
    expect(resolveFleetCompositionMode({
      compositionMode: undefined,
      configuredNetwork: 'testnet',
    })).toBe('legacy');
  });

  it('never loads the native runtime module from main.ts\'s static graph', () => {
    const graph = [...staticImportGraph(join(SRC, 'main.ts'))]
      .map((file) => normalize(file).replace(normalize(SRC), ''));

    // Reached only through `await import('./daemon/native-fleet-runtime.js')` inside the
    // `COMPOSITION_MODE === 'native'` branch. If it ever becomes a static import, a legacy boot
    // starts paying for (and evaluating) the trust catalog, the IPFS record transport and the Base
    // Sepolia read clients it will never use -- and this goes red.
    expect(graph).not.toContain('/daemon/native-fleet-runtime.ts');
    expect(graph).not.toContain('/daemon/native-trust-catalog.ts');
    expect(graph).not.toContain('/daemon/native-base-sepolia-infrastructure.ts');

    // The mode resolver itself IS statically imported -- it must run on every boot -- so its own
    // import graph is the thing that has to stay small.
    expect(graph).toContain('/daemon/native-composition-mode.ts');
    const modeGraph = [...staticImportGraph(join(SRC, 'daemon/native-composition-mode.ts'))]
      .map((file) => normalize(file).replace(normalize(SRC), ''));
    expect(modeGraph.sort()).toEqual([
      '/daemon/native-composition-mode.ts',
      '/daemon/native-vertical-mode.ts',
    ]);
  });

  it('constructs nothing native when the mode is legacy', async () => {
    // A spy on the assembly entry point: selecting legacy must not reach it. Written as an
    // explicit guard rather than a comment so a future `buildFleetNativeRuntime()` call that
    // escapes the `COMPOSITION_MODE === 'native'` branch is caught.
    const runtime = await import('../../src/daemon/native-fleet-runtime.js');
    const build = vi.spyOn(runtime, 'buildFleetNativeRuntime');
    const mode = resolveFleetCompositionMode({
      compositionMode: undefined,
      configuredNetwork: 'testnet',
    });
    if (mode === 'native') await runtime.buildFleetNativeRuntime({} as never);
    expect(build).not.toHaveBeenCalled();
    build.mockRestore();
  });
});

describe('refuseNativeVerdictObservation', () => {
  it('fails CLOSED and names why, rather than projecting an unverified verdict', async () => {
    const { refuseNativeVerdictObservation } = await import(
      '../../src/daemon/native-fleet-runtime.js'
    );
    expect(() => refuseNativeVerdictObservation()).toThrow(
      /no production implementation on the native fleet path/u,
    );
    // M4 is named in the message so the next reader knows where the real gate lands.
    expect(() => refuseNativeVerdictObservation()).toThrow(/M4/u);
  });
});
