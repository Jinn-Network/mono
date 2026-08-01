import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const layerRoot = resolve(repoRoot, 'packages/layer');

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(layerRoot, path), 'utf8')) as Record<string, unknown>;
}

describe('@jinn-network/jinn-layer package contract', () => {
  it('is a public independent ESM package with the jinn-layer bin', () => {
    const pkg = json('package.json');
    expect(pkg.name).toBe('@jinn-network/jinn-layer');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(pkg.private).not.toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.bin).toEqual({
      'jinn-layer': './dist/bin/jinn-layer.js',
      'jinn-distill-mcp': './dist/bin/jinn-distill-mcp.js',
    });
    expect(pkg.files).toEqual(['dist/']);
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect((pkg.scripts as Record<string, string>)['pack:smoke'])
      .toBe('node scripts/pack-smoke.mjs');
  });

  it('pins the plugin-local runtime contract to this exact package version', () => {
    const pkg = json('package.json');
    const runtime = JSON.parse(
      readFileSync(
        resolve(repoRoot, 'plugin/frozen/layer-runtime.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(runtime.package).toBe(pkg.name);
    expect(runtime.version).toBe(pkg.version);
    expect(runtime.bin).toBe('runtime/node_modules/.bin/jinn-layer');
  });

  it('has publicly installable direct package dependencies', () => {
    const core = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/core/package.json'), 'utf8'),
    ) as Record<string, unknown>;
    const plugin = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/plugin/package.json'), 'utf8'),
    ) as Record<string, unknown>;
    for (const dependency of [core, plugin]) {
      expect(dependency.private).not.toBe(true);
      expect(dependency.publishConfig).toEqual({ access: 'public' });
    }
  });
});
