// Issue #3734. `yarn typecheck:test` builds only jinn-layer; the other four portal trees the test
// compile resolves against are built by `yarn typecheck`. Run alone on a fresh clone the gate used
// to emit a large regression list caused entirely by the missing `dist/` trees. These tests pin
// the probe that replaces that list with the prerequisite.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findUnbuiltPortalPackages,
  formatUnbuiltPortalsMessage,
} from '../../scripts/lib/unbuilt-portals.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTree(
  manifest: Record<string, unknown>,
  installed: Record<string, { manifest: Record<string, unknown>; built: boolean }>,
): string {
  const root = mkdtempSync(join(tmpdir(), 'unbuilt-portals-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest), 'utf8');
  for (const [name, spec] of Object.entries(installed)) {
    const dir = join(root, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(spec.manifest), 'utf8');
    const entry = spec.manifest.types ?? spec.manifest.main;
    if (spec.built && typeof entry === 'string') {
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, entry), '', 'utf8');
    }
  }
  return root;
}

describe('findUnbuiltPortalPackages', () => {
  it('is silent when every portal entrypoint is present', () => {
    const root = makeTree(
      { dependencies: { '@jinn-network/sdk': '0.2.0', viem: '2.0.0' } },
      { '@jinn-network/sdk': { manifest: { types: 'dist/index.d.ts' }, built: true } },
    );
    expect(findUnbuiltPortalPackages(root)).toEqual([]);
  });

  it('reports a portal whose declared entrypoint has not been built', () => {
    const root = makeTree(
      { dependencies: { '@jinn-network/sdk': '0.2.0' } },
      { '@jinn-network/sdk': { manifest: { types: 'dist/index.d.ts' }, built: false } },
    );
    expect(findUnbuiltPortalPackages(root)).toEqual([
      { name: '@jinn-network/sdk', reason: 'missing dist/index.d.ts' },
    ]);
  });

  it('reports a portal that is not installed at all', () => {
    const root = makeTree({ devDependencies: { '@jinn-network/jinn-layer': 'portal:../packages/layer' } }, {});
    expect(findUnbuiltPortalPackages(root)).toEqual([
      { name: '@jinn-network/jinn-layer', reason: 'not installed' },
    ]);
  });

  it('probes devDependencies alongside dependencies, sorted, and ignores registry packages', () => {
    const root = makeTree(
      {
        dependencies: { '@jinn-network/sdk': '0.2.0', vitest: '4.0.0' },
        devDependencies: { '@jinn-network/core': '0.1.2' },
      },
      {
        '@jinn-network/sdk': { manifest: { main: 'dist/index.js' }, built: false },
        '@jinn-network/core': { manifest: { main: 'dist/index.js' }, built: false },
      },
    );
    expect(findUnbuiltPortalPackages(root).map((entry) => entry.name)).toEqual([
      '@jinn-network/core',
      '@jinn-network/sdk',
    ]);
  });

  it('skips a package that declares no entrypoint rather than failing falsely', () => {
    const root = makeTree(
      { dependencies: { '@jinn-network/exports-only': '0.1.0' } },
      { '@jinn-network/exports-only': { manifest: { exports: { '.': './dist/index.js' } }, built: false } },
    );
    expect(findUnbuiltPortalPackages(root)).toEqual([]);
  });

  it('names `yarn typecheck` as the prerequisite, not a regression list', () => {
    const message = formatUnbuiltPortalsMessage([
      { name: '@jinn-network/sdk', reason: 'missing dist/index.d.ts' },
    ]);
    expect(message).toContain('@jinn-network/sdk: missing dist/index.d.ts');
    expect(message).toContain('yarn typecheck');
    // `yarn typecheck` builds this one, so do not send the reader through an install first.
    expect(message).not.toContain('yarn install');
  });

  it('names `yarn install` when a portal is absent, which `yarn typecheck` cannot fix', () => {
    const message = formatUnbuiltPortalsMessage([
      { name: '@jinn-network/sdk', reason: 'not installed' },
    ]);
    expect(message).toContain('yarn install');
    expect(message).toContain('yarn typecheck');
  });
});
