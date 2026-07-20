import { afterEach, describe, expect, it } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertSafeTarballEntries,
  materializeBundledWorkspaces,
  restoreBundledWorkspaces,
} from '../../scripts/lib/bundled-workspaces.mjs';

describe('bundled workspace packaging', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('replaces workspace links with publish-shaped package directories and restores them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jinn-bundled-workspaces-'));
    dirs.push(root);
    const clientRoot = path.join(root, 'client');
    const coreRoot = path.join(root, 'packages', 'core');
    const pluginRoot = path.join(root, 'packages', 'plugin');
    const scopeRoot = path.join(clientRoot, 'node_modules', '@jinn-network');

    await mkdir(path.join(coreRoot, 'dist'), { recursive: true });
    await mkdir(path.join(coreRoot, 'src'), { recursive: true });
    await mkdir(path.join(coreRoot, 'node_modules', 'fixture'), { recursive: true });
    await mkdir(path.join(pluginRoot, 'dist'), { recursive: true });
    await mkdir(scopeRoot, { recursive: true });
    await writeFile(
      path.join(clientRoot, 'package.json'),
      JSON.stringify({
        dependencies: { zod: '^4.4.3' },
        bundledDependencies: ['@jinn-network/core', '@jinn-network/plugin'],
      }),
    );
    await writeFile(
      path.join(coreRoot, 'package.json'),
      JSON.stringify({
        name: '@jinn-network/core',
        files: ['dist/'],
        dependencies: { zod: '^4.4.3' },
      }),
    );
    await writeFile(path.join(coreRoot, 'dist', 'index.js'), 'export const core = true;\n');
    await writeFile(path.join(coreRoot, 'src', 'index.ts'), 'export const source = true;\n');
    await writeFile(path.join(coreRoot, 'node_modules', 'fixture', 'test.js'), 'throw new Error();\n');
    await writeFile(
      path.join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: '@jinn-network/plugin',
        files: ['dist/', 'process-contract.json'],
        dependencies: { zod: '^4.4.3' },
      }),
    );
    await writeFile(path.join(pluginRoot, 'dist', 'index.js'), 'export const plugin = true;\n');
    await writeFile(path.join(pluginRoot, 'process-contract.json'), '{}\n');
    await symlink(path.relative(scopeRoot, coreRoot), path.join(scopeRoot, 'core'));
    await symlink(path.relative(scopeRoot, pluginRoot), path.join(scopeRoot, 'plugin'));

    const originalCoreLink = await readlink(path.join(scopeRoot, 'core'));
    await materializeBundledWorkspaces({ clientRoot });

    expect((await lstat(path.join(scopeRoot, 'core'))).isDirectory()).toBe(true);
    expect(await readFile(path.join(scopeRoot, 'core', 'dist', 'index.js'), 'utf8')).toContain('core');
    expect(
      JSON.parse(await readFile(path.join(scopeRoot, 'core', 'package.json'), 'utf8')).dependencies,
    ).toBeUndefined();
    await expect(lstat(path.join(scopeRoot, 'core', 'src'))).rejects.toThrow();
    await expect(lstat(path.join(scopeRoot, 'core', 'node_modules'))).rejects.toThrow();
    expect(await readFile(path.join(scopeRoot, 'plugin', 'process-contract.json'), 'utf8')).toBe('{}\n');

    await restoreBundledWorkspaces({ clientRoot });

    expect((await lstat(path.join(scopeRoot, 'core'))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(scopeRoot, 'core'))).toBe(originalCoreLink);
  });

  it('rejects archive traversal and source/test leakage', () => {
    expect(() => assertSafeTarballEntries([
      'package/dist/index.js',
      'package/../packages/core/node_modules/secret/test.js',
    ])).toThrow(/unsafe path/);
    expect(() => assertSafeTarballEntries([
      'package/dist/index.js',
      'package/test/private.test.js',
    ])).toThrow(/source or test/);
  });
});
