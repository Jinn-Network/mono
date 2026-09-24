import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPILER_DEV_DEPENDENCY_NAMES,
  STALE_LOCKFILE_MESSAGE,
  buildConsumerThirdPartyDependencies,
  consumerManifest,
  discoverPackageRoots,
  firstPartyArchiveDependencies,
  fixtureLockfilePath,
  installPinnedGraph,
  packedClosurePackageNames,
  packedOverlayInstallArgs,
  pinnedInstallArgs,
  readPackageJson,
  refreshLockfileArgs,
  requirePackageRoot,
  withoutLocalArchiveIntegrity,
} from '../../scripts/lib/hermetic-packed-closure.mjs';

const scriptsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../scripts');
const operatorRoot = join(scriptsRoot, '..');
const packagesRoot = join(operatorRoot, '..', 'packages');
const smokePath = join(scriptsRoot, 'smoke-test-hermetic-packed-closure.mjs');
const refreshPath = join(scriptsRoot, 'refresh-hermetic-packed-closure-lockfile.mjs');
const readmePath = join(scriptsRoot, 'fixtures/hermetic-packed-closure/README.md');

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermetic-packed-closure-'));
  tmpRoots.push(root);
  return root;
}

describe('packed-closure third-party pin', () => {
  it('installs the pinned graph with npm ci, not an unpinned install', () => {
    const args = pinnedInstallArgs();
    expect(args).toEqual(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    expect(args).not.toContain('--package-lock=false');
    expect(args).not.toContain('--offline');
    expect(args).not.toContain('--package-lock-only');
  });

  it('overlays packed first-party archives offline without rewriting the lockfile', () => {
    expect(packedOverlayInstallArgs(['/tmp/a.tgz', '/tmp/b.tgz'])).toEqual([
      'install',
      '--offline',
      '--package-lock=false',
      '--no-save',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '/tmp/a.tgz',
      '/tmp/b.tgz',
    ]);
  });

  it('runs npm ci against the copied lockfile, then removes it before any overlay', () => {
    const root = tmpDir();
    const lockfileSource = join(root, 'package-lock.json');
    const consumerRoot = join(root, 'consumer');
    const consumerLockfile = join(consumerRoot, 'package-lock.json');
    mkdirSync(consumerRoot);
    writeFileSync(lockfileSource, '{"lockfileVersion":3}\n');
    const calls: { cmd: string; args: string[]; cwd?: string; lockfile: string | null }[] = [];
    installPinnedGraph({
      run: (cmd, args, _context, options = {}) => {
        calls.push({
          cmd,
          args,
          cwd: options.cwd,
          lockfile: existsSync(consumerLockfile) ? readFileSync(consumerLockfile, 'utf8') : null,
        });
      },
      consumerRoot,
      lockfileSource,
    });
    expect(calls).toEqual([
      {
        cmd: 'npm',
        args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        cwd: consumerRoot,
        lockfile: '{"lockfileVersion":3}\n',
      },
    ]);
    // `npm install --package-lock=false` counts a package-lock.json on disk as a
    // loaded tree and skips node_modules, so a leftover file makes the offline
    // overlay re-resolve every dependency from the registry.
    expect(existsSync(consumerLockfile)).toBe(false);
  });

  it('names the refresh command when npm ci rejects the committed lockfile', () => {
    const root = tmpDir();
    const lockfileSource = join(root, 'package-lock.json');
    const consumerRoot = join(root, 'consumer');
    mkdirSync(consumerRoot);
    writeFileSync(lockfileSource, '{"lockfileVersion":3}\n');
    const npmOutput =
      'install pinned packed-closure graph failed\nnpm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.';
    expect(() =>
      installPinnedGraph({
        run: () => {
          throw new Error(npmOutput);
        },
        consumerRoot,
        lockfileSource,
      }),
    ).toThrow(`${npmOutput}\n${STALE_LOCKFILE_MESSAGE}`);
    expect(STALE_LOCKFILE_MESSAGE).toBe(
      'packed-closure lockfile is out of sync; from operator/ run `node scripts/refresh-hermetic-packed-closure-lockfile.mjs`',
    );
  });

  it('records each packed first-party archive as a sorted relative file: dependency', () => {
    const consumerRoot = join('/closure', 'consumer');
    expect(
      firstPartyArchiveDependencies(
        consumerRoot,
        new Map([
          ['@jinn-network/sdk', join('/closure', 'archives', 'jinn-network-sdk-0.2.0.tgz')],
          ['@jinn-network/core', join('/closure', 'archives', 'jinn-network-core-0.1.2.tgz')],
        ]),
      ),
    ).toEqual({
      '@jinn-network/core': 'file:../archives/jinn-network-core-0.1.2.tgz',
      '@jinn-network/sdk': 'file:../archives/jinn-network-sdk-0.2.0.tgz',
    });
  });

  it('drops integrity only from entries resolved from a local archive', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'jinn-hermetic-packed-closure' },
        'node_modules/@jinn-network/sdk': {
          version: '0.2.0',
          resolved: 'file:../archives/jinn-network-sdk-0.2.0.tgz',
          integrity: 'sha512-local',
        },
        'node_modules/zod': {
          version: '4.4.3',
          resolved: 'https://registry.npmjs.org/zod/-/zod-4.4.3.tgz',
          integrity: 'sha512-registry',
        },
      },
    };
    expect(withoutLocalArchiveIntegrity(lock)).toEqual({
      lockfileVersion: 3,
      packages: {
        '': { name: 'jinn-hermetic-packed-closure' },
        'node_modules/@jinn-network/sdk': {
          version: '0.2.0',
          resolved: 'file:../archives/jinn-network-sdk-0.2.0.tgz',
        },
        'node_modules/zod': {
          version: '4.4.3',
          resolved: 'https://registry.npmjs.org/zod/-/zod-4.4.3.tgz',
          integrity: 'sha512-registry',
        },
      },
    });
    expect(lock.packages['node_modules/@jinn-network/sdk'].integrity).toBe('sha512-local');
  });

  it('walks first-party packed-closure names from local package roots', () => {
    const pluginRoot = join(tmpDir(), 'plugin');
    mkdirSync(pluginRoot);
    writeFileSync(
      join(pluginRoot, 'package.json'),
      `${JSON.stringify({ name: '@jinn-network/plugin', dependencies: {} })}\n`,
    );
    expect(
      packedClosurePackageNames(
        {
          dependencies: {},
          devDependencies: {
            '@jinn-network/plugin': '0.1.0',
            vitest: '^4.0.0',
          },
        },
        new Map([['@jinn-network/plugin', pluginRoot]]),
      ),
    ).toEqual(['@jinn-network/plugin']);
  });

  it('throws when a packed-closure name has no local package root', () => {
    expect(() =>
      packedClosurePackageNames(
        { dependencies: { '@jinn-network/missing': '1.0.0' } },
        new Map(),
      ),
    ).toThrow('No local package root is available for @jinn-network/missing.');
    expect(() => requirePackageRoot(new Map(), '@jinn-network/sdk')).toThrow(
      'No local package root is available for @jinn-network/sdk.',
    );
    expect(
      requirePackageRoot(new Map([['@jinn-network/sdk', '/packages/sdk']]), '@jinn-network/sdk'),
    ).toBe('/packages/sdk');
  });

  it('builds a sorted union; operator specifiers win collisions; first-party-only deps are kept', () => {
    const result = buildConsumerThirdPartyDependencies({
      operatorManifest: {
        dependencies: {
          '@jinn-network/sdk': '0.2.0',
          viem: '^2.0.0',
          zod: '4.4.3',
        },
        optionalDependencies: { '@coinbase/cdp-sdk': '^1.0.0' },
        devDependencies: {
          typescript: '^6.0.3',
          '@types/node': '^25.0.0',
          '@types/semver': '^7.0.0',
          '@types/ws': '^8.0.0',
          vitest: '^4.0.0',
        },
      },
      closureManifests: [
        {
          dependencies: {
            '@jinn-network/plugin': '0.1.2',
            viem: '^1.0.0',
            'left-pad': '1.3.0',
          },
        },
      ],
    });
    expect(Object.keys(result.dependencies)).toEqual([
      '@coinbase/cdp-sdk',
      'left-pad',
      'viem',
      'zod',
    ]);
    expect(result.dependencies).toEqual({
      '@coinbase/cdp-sdk': '^1.0.0',
      'left-pad': '1.3.0',
      viem: '^2.0.0',
      zod: '4.4.3',
    });
    expect(result.devDependencies).toEqual({
      '@types/node': '^25.0.0',
      '@types/semver': '^7.0.0',
      '@types/ws': '^8.0.0',
      typescript: '^6.0.3',
    });
    expect(COMPILER_DEV_DEPENDENCY_NAMES).toEqual([
      'typescript',
      '@types/node',
      '@types/semver',
      '@types/ws',
    ]);
  });

  it('writes a private ESM consumer manifest with sorted keys', () => {
    const manifest = consumerManifest({
      dependencies: { zod: '4.4.3', viem: '^2.0.0' },
      devDependencies: { typescript: '^6.0.3' },
    });
    expect(manifest).toEqual({
      name: 'jinn-hermetic-packed-closure',
      private: true,
      type: 'module',
      dependencies: { viem: '^2.0.0', zod: '4.4.3' },
      devDependencies: { typescript: '^6.0.3' },
    });
    expect(JSON.stringify(manifest.dependencies)).toBe(
      JSON.stringify({ viem: '^2.0.0', zod: '4.4.3' }),
    );
  });

  it('smoke consults the shared lib instead of an unpinned npm install', () => {
    const smoke = readFileSync(smokePath, 'utf8');
    expect(smoke).toContain("from './lib/hermetic-packed-closure.mjs'");
    expect(smoke).toMatch(/\binstallPinnedGraph\s*\(/);
    expect(smoke).toMatch(/\bpackedOverlayInstallArgs\s*\(/);
    expect(smoke).toMatch(/\bbuildConsumerThirdPartyDependencies\s*\(/);
    expect(smoke).toMatch(/\bfirstPartyArchiveDependencies\s*\(/);
    expect(smoke).toMatch(/\bpackedClosurePackageNames\s*\(/);
    expect(smoke).not.toMatch(/\bpinnedInstallArgs\b/);
    expect(smoke).toMatch(/process\.env\.npm_config_cache\s*=\s*join\(\s*closureRoot\s*,/);
    expect(smoke).toMatch(/\brequirePackageRoot\s*\(/);
    expect(smoke).not.toMatch(/packageRoots\.get\s*\(/);
    expect(smoke).not.toMatch(/run\(\s*['"]npm['"]\s*,\s*\[\s*['"]install['"]/);
  });

  it('installs the closure from the lockfile and persists registry versions only after the client overlay', () => {
    const smoke = readFileSync(smokePath, 'utf8');
    const pinnedInstall = smoke.search(/\binstallPinnedGraph\s*\(/);
    const clientOverlay = smoke.indexOf('install packed client into clean closure');
    const persistOperator = smoke.indexOf("'@jinn-network/operator': clientManifest.version");
    expect(pinnedInstall).toBeGreaterThan(-1);
    expect(clientOverlay).toBeGreaterThan(pinnedInstall);
    expect(persistOperator).toBeGreaterThan(clientOverlay);
    expect(smoke).not.toContain('overlay packed first-party closure');
    expect(smoke).toMatch(/installPackedArchives\(\s*\[\s*clientArchive\s*\]/);
  });

  it('refresh is the only live range-resolution path', () => {
    expect(refreshLockfileArgs()).toEqual([
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    const refresh = readFileSync(refreshPath, 'utf8');
    expect(refresh).toContain("from './lib/hermetic-packed-closure.mjs'");
    expect(refresh).toMatch(/\brefreshLockfileArgs\s*\(/);
    expect(refresh).toMatch(/\bpackedClosurePackageNames\s*\(/);
    expect(refresh).toMatch(/\bfirstPartyArchiveDependencies\s*\(/);
    expect(refresh).toMatch(/\bsanitizedManifest\s*\(/);
    expect(refresh).toMatch(/\bwithoutLocalArchiveIntegrity\s*\(/);
    expect(refresh).toMatch(/\brequirePackageRoot\s*\(/);
    expect(refresh).not.toMatch(/packageRoots\.get\s*\(/);
    expect(refresh).toContain('--package-lock-only');
    expect(refresh).not.toContain('--package-lock=false');
    expect(refresh).not.toMatch(/run\(\s*['"]npm['"]\s*,\s*\[\s*['"]install['"]/);
  });

  it('commits a lockfile that satisfies every packed-closure specifier without the registry', () => {
    const lockPath = fixtureLockfilePath(scriptsRoot);
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      lockfileVersion?: number;
      packages?: Record<
        string,
        {
          version?: string;
          resolved?: string;
          integrity?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        }
      >;
    };
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    const packages = lock.packages ?? {};
    // npm's lookup: the requiring package's own node_modules, then each
    // enclosing node_modules up to the consumer root.
    const resolveFrom = (location: string, name: string) => {
      let base = location;
      for (;;) {
        const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
        if (packages[candidate] !== undefined) return packages[candidate];
        if (base === '') return undefined;
        const parent = base.lastIndexOf('/node_modules/');
        base = parent === -1 ? '' : base.slice(0, parent);
      }
    };
    const unsatisfied: string[] = [];
    const check = (location: string, manifest: Record<string, unknown>) => {
      const optionalPeers = (manifest.peerDependenciesMeta ?? {}) as Record<
        string,
        { optional?: boolean }
      >;
      const specs = {
        ...(manifest.dependencies as Record<string, string> | undefined),
        ...(manifest.optionalDependencies as Record<string, string> | undefined),
        ...Object.fromEntries(
          Object.entries((manifest.peerDependencies ?? {}) as Record<string, string>).filter(
            ([name]) => optionalPeers[name]?.optional !== true,
          ),
        ),
      };
      for (const [name, spec] of Object.entries(specs)) {
        const version = resolveFrom(location, name)?.version;
        if (version === undefined || !semver.satisfies(version, spec)) {
          unsatisfied.push(`${location} needs ${name}@${spec}, lockfile has ${version ?? 'none'}`);
        }
      }
    };
    const operatorManifest = readPackageJson(operatorRoot);
    const packageRoots = discoverPackageRoots(packagesRoot);
    const names = packedClosurePackageNames(operatorManifest, packageRoots);
    // npm ci compares the consumer root with this entry; the smoke builds the
    // third-party half of that root from these same manifests.
    const thirdParty = buildConsumerThirdPartyDependencies({
      operatorManifest,
      closureManifests: names.map((name) => readPackageJson(requirePackageRoot(packageRoots, name))),
    });
    const lockRoot = packages[''];
    expect(lockRoot?.devDependencies ?? {}, STALE_LOCKFILE_MESSAGE).toEqual(thirdParty.devDependencies);
    expect(
      Object.fromEntries(
        Object.entries(lockRoot?.dependencies ?? {}).filter(
          ([name]) => !name.startsWith('@jinn-network/'),
        ),
      ),
      STALE_LOCKFILE_MESSAGE,
    ).toEqual(thirdParty.dependencies);
    for (const name of names) {
      const manifest = readPackageJson(requirePackageRoot(packageRoots, name));
      const location = `node_modules/${name}`;
      const entry = packages[location];
      expect(entry?.version, `${location}: ${STALE_LOCKFILE_MESSAGE}`).toBe(manifest.version);
      expect(entry?.resolved, location).toMatch(/^file:\.\.\/archives\/[^/]+\.tgz$/);
      expect(entry?.integrity, location).toBeUndefined();
      check(location, manifest);
    }
    // The packed client lands at the consumer root with no nested packages.
    check('node_modules/@jinn-network/operator', {
      dependencies: operatorManifest.dependencies,
      optionalDependencies: operatorManifest.optionalDependencies,
    });
    expect(unsatisfied, STALE_LOCKFILE_MESSAGE).toEqual([]);
  });

  it('documents the lockfile refresh command', () => {
    const readme = readFileSync(readmePath, 'utf8');
    expect(readme).toContain('node scripts/refresh-hermetic-packed-closure-lockfile.mjs');
    expect(readme).toContain('npm ci');
    expect(readme).toContain('--package-lock-only');
  });
});
