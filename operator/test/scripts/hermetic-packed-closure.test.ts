import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPILER_DEV_DEPENDENCY_NAMES,
  DEFAULT_MIN_RELEASE_AGE_DAYS,
  MIN_RELEASE_AGE_ENV,
  MIN_RELEASE_AGE_EXCLUDE,
  MIN_REFRESH_NPM_VERSION,
  STALE_LOCKFILE_MESSAGE,
  assertNpmSupportsReleaseAge,
  buildConsumerThirdPartyDependencies,
  consumerManifest,
  discoverPackageRoots,
  firstPartyArchiveDependencies,
  fixtureLockfilePath,
  formatHeldBack,
  heldBackPackages,
  installPinnedGraph,
  minReleaseAgeDaysFromEnv,
  packedClosurePackageNames,
  packedOverlayInstallArgs,
  pinnedInstallArgs,
  readPackageJson,
  refreshLockfileArgs,
  requirePackageRoot,
  unconstrainedRefreshLockfileArgs,
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
      '--min-release-age=7',
      '--min-release-age-exclude=',
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

describe('packed-closure lockfile refresh release-age floor (#4897)', () => {
  it('states the floor explicitly: seven days, and an empty exception list that .npmrc cannot widen', () => {
    expect(DEFAULT_MIN_RELEASE_AGE_DAYS).toBe(7);
    expect(MIN_RELEASE_AGE_EXCLUDE).toEqual([]);
    const args = refreshLockfileArgs();
    expect(args).toContain('--min-release-age=7');
    // An empty CLI value replaces a lower-precedence exclusion list (verified against
    // npm 11.19.0), so a developer's own `.npmrc` cannot exempt a package silently.
    expect(args).toContain('--min-release-age-exclude=');
    expect(args.filter((arg) => arg.startsWith('--min-release-age'))).toHaveLength(2);
  });

  it('keeps the existing refresh flags and puts the floor after them', () => {
    expect(refreshLockfileArgs().slice(0, 5)).toEqual([
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
  });

  it('takes a configured age and per-package exceptions, one flag each', () => {
    expect(refreshLockfileArgs({ minReleaseAgeDays: 14, exclude: ['left-pad', '@scope/*'] }).slice(5)).toEqual([
      '--min-release-age=14',
      '--min-release-age-exclude=left-pad',
      '--min-release-age-exclude=@scope/*',
    ]);
    expect(refreshLockfileArgs({ minReleaseAgeDays: 0.5 }).slice(5, 6)).toEqual(['--min-release-age=0.5']);
  });

  it('refuses an age that would switch the floor off', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '7', null]) {
      expect(() => refreshLockfileArgs({ minReleaseAgeDays: bad as number }), String(bad)).toThrow(
        /positive number of days/u,
      );
    }
  });

  it('reads the age from one environment variable and defaults to seven days', () => {
    expect(MIN_RELEASE_AGE_ENV).toBe('JINN_HERMETIC_REFRESH_MIN_RELEASE_AGE_DAYS');
    expect(minReleaseAgeDaysFromEnv({})).toBe(7);
    expect(minReleaseAgeDaysFromEnv({ [MIN_RELEASE_AGE_ENV]: '' })).toBe(7);
    expect(minReleaseAgeDaysFromEnv({ [MIN_RELEASE_AGE_ENV]: '14' })).toBe(14);
    expect(minReleaseAgeDaysFromEnv({ [MIN_RELEASE_AGE_ENV]: ' 3.5 ' })).toBe(3.5);
  });

  it('rejects an unusable environment value instead of falling back to the default', () => {
    for (const bad of ['0', '-2', 'abc', '7d', 'Infinity']) {
      expect(() => minReleaseAgeDaysFromEnv({ [MIN_RELEASE_AGE_ENV]: bad }), bad).toThrow(MIN_RELEASE_AGE_ENV);
    }
  });

  it('resolves without the floor only for the held-back comparison', () => {
    expect(unconstrainedRefreshLockfileArgs()).toEqual([
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--min-release-age=0',
    ]);
  });

  it('refuses an npm that would ignore the floor with only a warning', () => {
    expect(MIN_REFRESH_NPM_VERSION).toBe('11.19.0');
    for (const ok of ['11.19.0', '11.19.1', '11.20.0', '12.0.0', '11.19.0\n']) {
      expect(() => assertNpmSupportsReleaseAge(ok), ok).not.toThrow();
    }
    for (const old of ['11.18.9', '11.16.0', '11.3.0', '10.9.8']) {
      expect(() => assertNpmSupportsReleaseAge(old), old).toThrow(/npm 11\.19\.0 or newer/u);
    }
    expect(() => assertNpmSupportsReleaseAge('not a version')).toThrow(/npm version/u);
  });

  it('reports every package that differs from an unconstrained resolve, and nothing when none does', () => {
    const lock = (versions: Record<string, string>) => ({
      lockfileVersion: 3,
      packages: {
        '': { name: 'jinn-hermetic-packed-closure' },
        ...Object.fromEntries(Object.entries(versions).map(([path, version]) => [path, { version }])),
      },
    });
    const unconstrained = lock({
      'node_modules/viem': '2.57.4',
      'node_modules/@types/node': '26.6.5',
      'node_modules/viem/node_modules/ws': '8.19.0',
      'node_modules/ws': '8.18.3',
      'node_modules/semver': '7.7.2',
    });
    const constrained = lock({
      'node_modules/viem': '2.57.0',
      'node_modules/@types/node': '26.6.4',
      'node_modules/viem/node_modules/ws': '8.19.0',
      'node_modules/ws': '8.18.3',
      'node_modules/semver': '7.7.2',
    });
    const held = heldBackPackages(unconstrained, constrained);
    expect(held).toEqual([
      { name: '@types/node', unconstrained: ['26.6.5'], constrained: ['26.6.4'] },
      { name: 'viem', unconstrained: ['2.57.4'], constrained: ['2.57.0'] },
    ]);
    expect(formatHeldBack(held, 7)).toBe(
      [
        'release-age floor (7 days) held back 2 packages:',
        '  @types/node: 26.6.5 -> 26.6.4',
        '  viem: 2.57.4 -> 2.57.0',
      ].join('\n'),
    );
    expect(heldBackPackages(unconstrained, unconstrained)).toEqual([]);
    expect(formatHeldBack([], 7)).toBe('release-age floor (7 days) held nothing back');
  });

  it('counts a package that only the unconstrained resolve pulls in, and a changed set of nested copies', () => {
    const lock = (versions: Record<string, string>) => ({
      packages: Object.fromEntries(Object.entries(versions).map(([path, version]) => [path, { version }])),
    });
    const held = heldBackPackages(
      lock({ 'node_modules/a': '2.0.0', 'node_modules/b': '1.1.0', 'node_modules/a/node_modules/b': '1.0.0' }),
      lock({ 'node_modules/a': '1.9.0', 'node_modules/b': '1.0.0' }),
    );
    expect(held).toEqual([
      { name: 'a', unconstrained: ['2.0.0'], constrained: ['1.9.0'] },
      { name: 'b', unconstrained: ['1.0.0', '1.1.0'], constrained: ['1.0.0'] },
    ]);
    expect(formatHeldBack(held.slice(1), 7)).toContain('b: 1.0.0, 1.1.0 -> 1.0.0');
    expect(formatHeldBack(heldBackPackages(lock({ 'node_modules/new': '1.0.0' }), lock({})), 7)).toContain(
      'new: 1.0.0 -> (absent)',
    );
  });

  it('wires the refresh script through the floor, the npm check, and the held-back report', () => {
    const refresh = readFileSync(refreshPath, 'utf8');
    expect(refresh).toMatch(/\bminReleaseAgeDaysFromEnv\s*\(\s*process\.env\s*\)/);
    expect(refresh).toMatch(/\brefreshLockfileArgs\s*\(\s*\{\s*minReleaseAgeDays\b/);
    expect(refresh).toMatch(/\bassertNpmSupportsReleaseAge\s*\(/);
    expect(refresh).toMatch(/\bunconstrainedRefreshLockfileArgs\s*\(/);
    expect(refresh).toMatch(/\bformatHeldBack\s*\(/);
    // The npm version is read before any archive is packed or any registry call is made.
    expect(refresh.indexOf('assertNpmSupportsReleaseAge(')).toBeLessThan(refresh.indexOf('discoverPackageRoots('));
  });

  it('documents the floor, its environment variable, the exception list, and the npm requirement', () => {
    const readme = readFileSync(readmePath, 'utf8');
    expect(readme).toContain('--min-release-age');
    expect(readme).toContain(MIN_RELEASE_AGE_ENV);
    expect(readme).toContain('MIN_RELEASE_AGE_EXCLUDE');
    expect(readme).toContain(MIN_REFRESH_NPM_VERSION);
  });
});
