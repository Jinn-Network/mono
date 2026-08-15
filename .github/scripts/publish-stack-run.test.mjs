import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { packWave } from './publish-stack-run.mjs';

const SHA = 'c'.repeat(40);

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'jinn-publish-run-'));
  const packageDir = join(root, 'packages/trust/core');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    `${JSON.stringify({
      name: '@jinn-network/trust-core',
      version: '0.1.0',
      publishConfig: { access: 'public' },
      resolutions: { '@jinn-network/trust-testing': 'portal:../testing' },
    }, null, 2)}\n`,
    'utf8',
  );
  return { root, packageDir };
}

function fakeExec(root, calls, tarballBytes) {
  return (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'npm' && args[0] === 'pack') {
      const destination = args[args.indexOf('--pack-destination') + 1];
      const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
      const filename = 'jinn-network-trust-core.tgz';
      writeFileSync(join(destination, filename), tarballBytes);
      calls.push({ packedManifest: manifest });
      return { status: 0, stdout: JSON.stringify([{ name: manifest.name, version: manifest.version, filename }]), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('packWave builds unmutated, packs mutated, and restores the manifest', async () => {
  const { root, packageDir } = scratch();
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-publish-tarballs-'));
  const original = readFileSync(join(packageDir, 'package.json'), 'utf8');
  const bytes = Buffer.from('tarball-bytes');
  const calls = [];
  try {
    const artifacts = await packWave(
      [{ name: '@jinn-network/trust-core', directory: 'packages/trust/core', manifestPath: join(packageDir, 'package.json'), spec: `@jinn-network/trust-core@0.1.0-canary.sha.${SHA}` }],
      {
        repoRoot: root,
        version: `0.1.0-canary.sha.${SHA}`,
        gitHead: SHA,
        inSetNames: new Set(['@jinn-network/trust-core']),
        tarballsDir,
        exec: fakeExec(root, calls, bytes),
      },
    );
    const commands = calls.filter((call) => call.command).map((call) => `${call.command} ${call.args.join(' ')}`);
    assert.deepEqual(commands, [
      'yarn install --immutable',
      'yarn build',
      `npm pack --json --ignore-scripts --pack-destination ${tarballsDir}`,
    ]);
    const packed = calls.find((call) => call.packedManifest).packedManifest;
    assert.equal(packed.version, `0.1.0-canary.sha.${SHA}`);
    assert.equal(packed.gitHead, SHA);
    assert.equal('resolutions' in packed, false);
    assert.equal(readFileSync(join(packageDir, 'package.json'), 'utf8'), original);
    assert.equal(artifacts[0].integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tarballsDir, { recursive: true, force: true });
  }
});

test('packWave restores the manifest even when the build fails', async () => {
  const { root, packageDir } = scratch();
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-publish-tarballs-'));
  const original = readFileSync(join(packageDir, 'package.json'), 'utf8');
  try {
    await assert.rejects(
      packWave(
        [{ name: '@jinn-network/trust-core', directory: 'packages/trust/core', manifestPath: join(packageDir, 'package.json'), spec: 'x' }],
        {
          repoRoot: root,
          version: '0.1.0',
          gitHead: SHA,
          inSetNames: new Set(['@jinn-network/trust-core']),
          tarballsDir,
          exec: (command, args) => (args[0] === 'build'
            ? { status: 2, stdout: '', stderr: 'tsc exploded' }
            : { status: 0, stdout: '', stderr: '' }),
        },
      ),
      /packages\/trust\/core: yarn build failed: tsc exploded/,
    );
    assert.equal(readFileSync(join(packageDir, 'package.json'), 'utf8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tarballsDir, { recursive: true, force: true });
  }
});

test('packWave refuses to pack a manifest that still carries an out-of-set local specifier', async () => {
  // Regression: transformManifestForPublish only rewrites in-set dependency
  // specifiers and strips portal: resolutions -- an out-of-set devDependency
  // carrying portal:/link:/file:/workspace: would otherwise pack and publish
  // untouched, and every consumer's install would resolve a path that does not
  // exist on their disk.
  const { root, packageDir } = scratch();
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  manifest.devDependencies = { '@some/local': 'portal:../thing' };
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-publish-tarballs-'));
  const original = readFileSync(join(packageDir, 'package.json'), 'utf8');
  const calls = [];
  try {
    await assert.rejects(
      packWave(
        [{ name: '@jinn-network/trust-core', directory: 'packages/trust/core', manifestPath: join(packageDir, 'package.json'), spec: 'x' }],
        {
          repoRoot: root,
          version: '0.1.0',
          gitHead: SHA,
          inSetNames: new Set(['@jinn-network/trust-core']),
          tarballsDir,
          exec: fakeExec(root, calls, Buffer.from('tarball-bytes')),
        },
      ),
      /packages\/trust\/core: packed manifest devDependencies\.@some\/local still carries local specifier portal:\.\.\/thing/,
    );
    assert.equal(readFileSync(join(packageDir, 'package.json'), 'utf8'), original, 'the manifest must still be restored');
    assert.ok(!calls.some((call) => call.command === 'npm'), 'npm pack must never run once a local specifier is caught');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tarballsDir, { recursive: true, force: true });
  }
});

test('packWave rejects a tarball whose packed identity disagrees with the plan', async () => {
  const { root, packageDir } = scratch();
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-publish-tarballs-'));
  try {
    await assert.rejects(
      packWave(
        [{ name: '@jinn-network/trust-core', directory: 'packages/trust/core', manifestPath: join(packageDir, 'package.json'), spec: 'x' }],
        {
          repoRoot: root,
          version: '0.1.0',
          gitHead: SHA,
          inSetNames: new Set(['@jinn-network/trust-core']),
          tarballsDir,
          exec: (command, args, cwd) => (command === 'npm'
            ? { status: 0, stdout: JSON.stringify([{ name: '@jinn-network/impostor', version: '0.1.0', filename: 'x.tgz' }]), stderr: '' }
            : { status: 0, stdout: '', stderr: '' }),
        },
      ),
      /npm pack produced @jinn-network\/impostor@0\.1\.0, expected @jinn-network\/trust-core@0\.1\.0/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tarballsDir, { recursive: true, force: true });
  }
});
