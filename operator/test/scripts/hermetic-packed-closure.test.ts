import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPILER_DEV_DEPENDENCY_NAMES,
  buildConsumerThirdPartyDependencies,
  consumerManifest,
  fixtureLockfilePath,
  installThirdPartyGraph,
  packedOverlayInstallArgs,
  refreshLockfileArgs,
  thirdPartyInstallArgs,
} from '../../scripts/lib/hermetic-packed-closure.mjs';

const scriptsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../scripts');
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
  it('installs the third-party graph with npm ci, not an unpinned install', () => {
    const args = thirdPartyInstallArgs();
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

  it('copies the committed lockfile and runs npm ci against the consumer', () => {
    const root = tmpDir();
    const lockfileSource = join(root, 'package-lock.json');
    const consumerRoot = join(root, 'consumer');
    mkdirSync(consumerRoot);
    writeFileSync(lockfileSource, '{"lockfileVersion":3}\n');
    const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
    installThirdPartyGraph({
      run: (cmd, args, _context, options = {}) => {
        calls.push({ cmd, args, cwd: options.cwd });
      },
      consumerRoot,
      lockfileSource,
    });
    expect(readFileSync(join(consumerRoot, 'package-lock.json'), 'utf8')).toBe(
      '{"lockfileVersion":3}\n',
    );
    expect(calls).toEqual([
      {
        cmd: 'npm',
        args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        cwd: consumerRoot,
      },
    ]);
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
    expect(smoke).toContain('thirdPartyInstallArgs');
    expect(smoke).toContain('installThirdPartyGraph');
    expect(smoke).toContain('packedOverlayInstallArgs');
    expect(smoke).toContain('buildConsumerThirdPartyDependencies');
    expect(smoke).not.toMatch(/'install',\s*'--ignore-scripts',\s*'--package-lock=false'/);
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
    expect(refresh).toContain('refreshLockfileArgs');
    expect(refresh).toContain('--package-lock-only');
    expect(refresh).not.toContain('--package-lock=false');
  });

  it('commits a third-party-only package-lock.json for the packed-closure consumer', () => {
    const lockPath = fixtureLockfilePath(scriptsRoot);
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      lockfileVersion?: number;
      packages?: Record<string, unknown>;
    };
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    expect(lock.packages).toBeTypeOf('object');
    const packagePaths = Object.keys(lock.packages ?? {});
    expect(packagePaths.some((entry) => entry.includes('node_modules/zod'))).toBe(true);
    expect(packagePaths.filter((entry) => entry.includes('@jinn-network/'))).toEqual([]);
  });

  it('documents the lockfile refresh command', () => {
    const readme = readFileSync(readmePath, 'utf8');
    expect(readme).toContain('node scripts/refresh-hermetic-packed-closure-lockfile.mjs');
    expect(readme).toContain('npm ci');
    expect(readme).toContain('--package-lock-only');
  });
});
