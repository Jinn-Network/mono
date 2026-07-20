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
    expect(pkg.version).toBe('0.1.0');
    expect(pkg.private).not.toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.bin).toEqual({
      'jinn-layer': './dist/bin/jinn-layer.js',
      'jinn-distill-mcp': './dist/bin/jinn-distill-mcp.js',
    });
    expect(pkg.files).toEqual(['dist/']);
    expect(pkg.publishConfig).toEqual({ access: 'public' });
  });

  it('pins the plugin-local runtime contract to this exact package version', () => {
    const pkg = json('package.json');
    const runtime = JSON.parse(
      readFileSync(
        resolve(repoRoot, 'apps/jinn-agent/plugins/jinn/layer-runtime.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(runtime.package).toBe(pkg.name);
    expect(runtime.version).toBe(pkg.version);
    expect(runtime.bin).toBe('runtime/node_modules/.bin/jinn-layer');
  });
});
