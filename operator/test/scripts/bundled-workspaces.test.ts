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
import { fileURLToPath } from 'node:url';
import * as bundledWorkspaces from '../../scripts/lib/bundled-workspaces.mjs';

const {
  assertSafeTarballEntries,
  materializeBundledWorkspaces,
  restoreBundledWorkspaces,
} = bundledWorkspaces;

describe('bundled workspace packaging', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('replaces workspace links with publish-shaped package directories and restores them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jinn-bundled-workspaces-'));
    dirs.push(root);
    const clientRoot = path.join(root, 'operator');
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
        dependencies: {
          '@jinn-network/core': '1.0.0',
          '@jinn-network/plugin': '1.0.0',
          zod: '^4.4.3',
        },
        bundledDependencies: ['@jinn-network/core', '@jinn-network/plugin'],
      }),
    );
    await writeFile(
      path.join(coreRoot, 'package.json'),
      JSON.stringify({
        name: '@jinn-network/core',
        version: '1.0.0',
        files: ['dist/'],
        dependencies: { zod: '^4.4.3' },
        devDependencies: { local: 'workspace:*' },
        resolutions: { local: 'portal:../local' },
      }),
    );
    await writeFile(path.join(coreRoot, 'dist', 'index.js'), 'export const core = true;\n');
    await writeFile(path.join(coreRoot, 'src', 'index.ts'), 'export const source = true;\n');
    await writeFile(path.join(coreRoot, 'node_modules', 'fixture', 'test.js'), 'throw new Error();\n');
    await writeFile(
      path.join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: '@jinn-network/plugin',
        version: '1.0.0',
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
    const packagedCore = JSON.parse(
      await readFile(path.join(scopeRoot, 'core', 'package.json'), 'utf8'),
    );
    expect(packagedCore.dependencies).toBeUndefined();
    expect(packagedCore.devDependencies).toBeUndefined();
    expect(packagedCore.resolutions).toBeUndefined();
    await expect(lstat(path.join(scopeRoot, 'core', 'src'))).rejects.toThrow();
    await expect(lstat(path.join(scopeRoot, 'core', 'node_modules'))).rejects.toThrow();
    expect(await readFile(path.join(scopeRoot, 'plugin', 'process-contract.json'), 'utf8')).toBe('{}\n');

    await restoreBundledWorkspaces({ clientRoot });

    expect((await lstat(path.join(scopeRoot, 'core'))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(scopeRoot, 'core'))).toBe(originalCoreLink);
  });

  it('publishes an allowlisted manifest and restores the source bytes after links', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jinn-bundled-workspaces-manifest-'));
    dirs.push(root);
    const clientRoot = path.join(root, 'operator');
    const coreRoot = path.join(root, 'packages', 'core');
    const scopeRoot = path.join(clientRoot, 'node_modules', '@jinn-network');
    const packagePath = path.join(clientRoot, 'package.json');
    const sourceBytes = Buffer.from(`{
  "name": "@jinn-network/client",
  "version": "0.3.0",
  "description": "fixture",
  "type": "module",
  "license": "MIT",
  "repository": {"type":"git","url":"https://example.test/repo.git"},
  "engines": {"node":">=22"},
  "bin": {"jinn":"./dist/bin/jinn.js"},
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist/"],
  "publishConfig": {"access":"public"},
  "bundledDependencies": ["@jinn-network/core"],
  "scripts": {"postinstall":"node dist/postinstall.mjs","test":"vitest"},
  "dependencies": {"@jinn-network/core":"1.0.0","zod":"^4.4.3"},
  "optionalDependencies": {"native":"^1.0.0"},
  "workspaces": ["packages/*"],
  "devDependencies": {"vitest":"^4.1.8"},
  "resolutions": {"zod":"4.4.3"},
  "privateField": "must not publish"
}
`);

    await mkdir(path.join(coreRoot, 'dist'), { recursive: true });
    await mkdir(scopeRoot, { recursive: true });
    await writeFile(packagePath, sourceBytes);
    await writeFile(
      path.join(coreRoot, 'package.json'),
      JSON.stringify({ name: '@jinn-network/core', version: '1.0.0', files: ['dist/'] }),
    );
    await writeFile(path.join(coreRoot, 'dist', 'index.js'), 'export const core = true;\n');
    await symlink(path.relative(scopeRoot, coreRoot), path.join(scopeRoot, 'core'));

    await materializeBundledWorkspaces({ clientRoot });

    const published = JSON.parse(await readFile(packagePath, 'utf8'));
    expect(Object.keys(published)).toEqual([
      'name',
      'version',
      'description',
      'type',
      'license',
      'repository',
      'engines',
      'bin',
      'main',
      'types',
      'files',
      'publishConfig',
      'bundledDependencies',
      'scripts',
      'dependencies',
      'optionalDependencies',
    ]);
    expect(published.scripts).toEqual({ postinstall: 'node dist/postinstall.mjs' });
    expect(published).not.toHaveProperty('workspaces');
    expect(published).not.toHaveProperty('devDependencies');
    expect(published).not.toHaveProperty('resolutions');
    expect(published).not.toHaveProperty('privateField');

    await restoreBundledWorkspaces({ clientRoot });

    expect(await readFile(packagePath)).toEqual(sourceBytes);
    expect((await lstat(path.join(scopeRoot, 'core'))).isSymbolicLink()).toBe(true);
  });

  it('rejects a bundled workspace whose client dependency does not exactly match its version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jinn-bundled-workspaces-version-'));
    dirs.push(root);
    const clientRoot = path.join(root, 'operator');
    const coreRoot = path.join(root, 'packages', 'core');
    const scopeRoot = path.join(clientRoot, 'node_modules', '@jinn-network');
    const packagePath = path.join(clientRoot, 'package.json');
    const sourceBytes = Buffer.from(
      '{"name":"@jinn-network/client","dependencies":{"@jinn-network/core":"0.1.0"},"bundledDependencies":["@jinn-network/core"]}\n',
    );

    await mkdir(path.join(coreRoot, 'dist'), { recursive: true });
    await mkdir(scopeRoot, { recursive: true });
    await writeFile(packagePath, sourceBytes);
    await writeFile(
      path.join(coreRoot, 'package.json'),
      JSON.stringify({
        name: '@jinn-network/core',
        version: '0.1.1',
        files: ['dist/'],
      }),
    );
    await writeFile(path.join(coreRoot, 'dist', 'index.js'), 'export const core = true;\n');
    await symlink(path.relative(scopeRoot, coreRoot), path.join(scopeRoot, 'core'));

    await expect(materializeBundledWorkspaces({ clientRoot })).rejects.toThrow(
      '@jinn-network/core bundled workspace version 0.1.1 must be declared as exact client dependency 0.1.1; found 0.1.0',
    );

    expect(await readFile(packagePath)).toEqual(sourceBytes);
    expect((await lstat(path.join(scopeRoot, 'core'))).isSymbolicLink()).toBe(true);
    await expect(lstat(path.join(clientRoot, '.jinn-pack-bundled-workspaces'))).rejects.toThrow();
  });

  it('materializes exact canary workspace versions selected before client publication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jinn-bundled-workspaces-canary-'));
    dirs.push(root);
    const clientRoot = path.join(root, 'operator');
    const coreRoot = path.join(root, 'packages', 'core');
    const pluginRoot = path.join(root, 'packages', 'plugin');
    const scopeRoot = path.join(clientRoot, 'node_modules', '@jinn-network');
    const coreVersion = '0.1.2-canary.01234567';
    const pluginVersion = '0.1.2-canary.01234567';

    await mkdir(path.join(coreRoot, 'dist'), { recursive: true });
    await mkdir(path.join(pluginRoot, 'dist'), { recursive: true });
    await mkdir(scopeRoot, { recursive: true });
    await writeFile(
      path.join(clientRoot, 'package.json'),
      JSON.stringify({
        name: '@jinn-network/client',
        version: '0.2.2-canary.sha.0123456789abcdef',
        dependencies: {
          '@jinn-network/core': coreVersion,
          '@jinn-network/plugin': pluginVersion,
        },
        bundledDependencies: ['@jinn-network/core', '@jinn-network/plugin'],
      }),
    );
    await writeFile(
      path.join(coreRoot, 'package.json'),
      JSON.stringify({
        name: '@jinn-network/core',
        version: coreVersion,
        files: ['dist/'],
      }),
    );
    await writeFile(
      path.join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: '@jinn-network/plugin',
        version: pluginVersion,
        files: ['dist/'],
      }),
    );
    await writeFile(path.join(coreRoot, 'dist', 'index.js'), 'export const core = true;\n');
    await writeFile(path.join(pluginRoot, 'dist', 'index.js'), 'export const plugin = true;\n');
    await symlink(path.relative(scopeRoot, coreRoot), path.join(scopeRoot, 'core'));
    await symlink(path.relative(scopeRoot, pluginRoot), path.join(scopeRoot, 'plugin'));

    await materializeBundledWorkspaces({ clientRoot });

    const packedCore = JSON.parse(
      await readFile(path.join(scopeRoot, 'core', 'package.json'), 'utf8'),
    );
    const packedPlugin = JSON.parse(
      await readFile(path.join(scopeRoot, 'plugin', 'package.json'), 'utf8'),
    );
    expect(packedCore.version).toBe(coreVersion);
    expect(packedPlugin.version).toBe(pluginVersion);
  });

  it('restores manifest bytes and earlier links when a later workspace fails to materialize', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jinn-bundled-workspaces-recovery-'));
    dirs.push(root);
    const clientRoot = path.join(root, 'operator');
    const coreRoot = path.join(root, 'packages', 'core');
    const pluginRoot = path.join(root, 'packages', 'plugin');
    const scopeRoot = path.join(clientRoot, 'node_modules', '@jinn-network');
    const packagePath = path.join(clientRoot, 'package.json');
    const sourceBytes = Buffer.from(
      '{"name":"@jinn-network/client","dependencies":{"@jinn-network/core":"1.0.0","@jinn-network/plugin":"1.0.0"},"bundledDependencies":["@jinn-network/core","@jinn-network/plugin"],"scripts":{"postinstall":"node postinstall.mjs"}}\n',
    );

    await mkdir(path.join(coreRoot, 'dist'), { recursive: true });
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(scopeRoot, { recursive: true });
    await writeFile(packagePath, sourceBytes);
    await writeFile(
      path.join(coreRoot, 'package.json'),
      JSON.stringify({ name: '@jinn-network/core', version: '1.0.0', files: ['dist/'] }),
    );
    await writeFile(path.join(coreRoot, 'dist', 'index.js'), 'export const core = true;\n');
    await writeFile(
      path.join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: '@jinn-network/plugin',
        version: '1.0.0',
        files: ['missing-dist/'],
      }),
    );
    await symlink(path.relative(scopeRoot, coreRoot), path.join(scopeRoot, 'core'));
    await symlink(path.relative(scopeRoot, pluginRoot), path.join(scopeRoot, 'plugin'));

    await expect(materializeBundledWorkspaces({ clientRoot })).rejects.toThrow(
      /@jinn-network\/plugin publish file does not exist: missing-dist\//,
    );

    expect(await readFile(packagePath)).toEqual(sourceBytes);
    expect((await lstat(path.join(scopeRoot, 'core'))).isSymbolicLink()).toBe(true);
    expect((await lstat(path.join(scopeRoot, 'plugin'))).isSymbolicLink()).toBe(true);
    await expect(lstat(path.join(clientRoot, '.jinn-pack-bundled-workspaces'))).rejects.toThrow();
  });

  it('recursively rejects local dependency references in every dependency section', () => {
    const assertPackageManifestDependencyValues = (
      bundledWorkspaces as typeof bundledWorkspaces & {
        assertPackageManifestDependencyValues?: (
          manifest: unknown,
          manifestPath: string,
        ) => void;
      }
    ).assertPackageManifestDependencyValues;

    expect(assertPackageManifestDependencyValues).toBeTypeOf('function');
    expect(() => assertPackageManifestDependencyValues!({
      dependencies: {
        safe: '^1.0.0',
        nested: {
          optional: ['npm:alias@1.0.0', { bad: 'workspace:*' }],
        },
      },
    }, 'package/node_modules/nested/package.json')).toThrow(
      /package\/node_modules\/nested\/package\.json.*workspace:\*/,
    );
    expect(() => assertPackageManifestDependencyValues!({
      optionalDependencies: { bad: 'portal:../local' },
    }, 'package/package.json')).toThrow(/portal:\.\.\/local/);
    expect(() => assertPackageManifestDependencyValues!({
      peerDependencies: { bad: 'file:../local.tgz' },
    }, 'package/package.json')).toThrow(/file:\.\.\/local\.tgz/);
    expect(() => assertPackageManifestDependencyValues!({
      dependencies: { bad: path.resolve('/tmp/checkout/package') },
    }, 'package/package.json')).toThrow(/absolute checkout dependency/);
    expect(() => assertPackageManifestDependencyValues!({
      dependencies: { safe: 'https://registry.npmjs.org/safe/-/safe-1.0.0.tgz' },
    }, 'package/package.json')).not.toThrow();
  });

  it('validates every package manifest listed in the packed archive', () => {
    const assertSafeTarballPackageManifests = (
      bundledWorkspaces as typeof bundledWorkspaces & {
        assertSafeTarballPackageManifests?: (
          entries: string[],
          readEntry: (entry: string) => string,
        ) => void;
      }
    ).assertSafeTarballPackageManifests;
    const manifests = new Map([
      ['package/package.json', JSON.stringify({ dependencies: { safe: '^1.0.0' } })],
      [
        'package/node_modules/safe/package.json',
        JSON.stringify({ optionalDependencies: { nested: 'workspace:*' } }),
      ],
    ]);

    expect(assertSafeTarballPackageManifests).toBeTypeOf('function');
    expect(() => assertSafeTarballPackageManifests!(
      [
        'package/dist/index.js',
        'package/package.json',
        'package/node_modules/safe/package.json',
      ],
      (entry) => manifests.get(entry) ?? '',
    )).toThrow(/package\/node_modules\/safe\/package\.json.*workspace:\*/);
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

  it('declares every bundled workspace at its exact version with its runtime dependencies', async () => {
    const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const repoRoot = path.dirname(clientRoot);
    const clientManifest = JSON.parse(
      await readFile(path.join(clientRoot, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      bundledDependencies?: string[];
      resolutions?: Record<string, string>;
    };

    for (const packageName of clientManifest.bundledDependencies ?? []) {
      // The portal resolution is the ground truth for where a bundled workspace lives.
      // The composition-stack packages are nested (`packages/evidence/local-runtime`), so
      // the npm name cannot be turned back into a path by taking its last segment.
      const portal = clientManifest.resolutions?.[packageName];
      expect(
        portal?.startsWith('portal:'),
        `bundled workspace ${packageName} must have a portal resolution`,
      ).toBe(true);
      const workspaceRoot = path.resolve(clientRoot, portal!.slice('portal:'.length));
      expect(
        workspaceRoot.startsWith(repoRoot + path.sep),
        `bundled workspace ${packageName} must resolve inside the repository`,
      ).toBe(true);
      const workspaceManifest = JSON.parse(
        await readFile(path.join(workspaceRoot, 'package.json'), 'utf8'),
      ) as { version?: string; dependencies?: Record<string, string> };

      expect(
        clientManifest.dependencies?.[packageName],
        `${packageName} must be declared at exact workspace version ${workspaceManifest.version}`,
      ).toBe(workspaceManifest.version);

      for (const dependency of Object.keys(workspaceManifest.dependencies ?? {})) {
        expect(
          clientManifest.dependencies?.[dependency],
          `${packageName} runtime dependency ${dependency} must also be a client dependency`,
        ).toBeTruthy();
      }
    }
  });
});
