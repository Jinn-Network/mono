import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { packWave, publishWave } from './publish-stack-run.mjs';

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

function registryExec(state) {
  return (command, args) => {
    if (args[0] === 'view') {
      const [, spec, field] = args;
      const record = state.get(spec);
      if (!record) return { status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found' };
      if (field === 'dist.integrity') return { status: 0, stdout: JSON.stringify(record.integrity), stderr: '' };
      return { status: 0, stdout: JSON.stringify(record.distTag), stderr: '' };
    }
    if (args[0] === 'publish') {
      const spec = args.__spec;
      state.set(spec, { integrity: args.__integrity, distTag: args[args.indexOf('--tag') + 1] });
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('publishWave skips an artifact already published with matching integrity', async () => {
  const artifacts = [{ name: '@jinn-network/trust-core', spec: '@jinn-network/trust-core@0.1.0', tarball: '/tmp/a.tgz', integrity: 'sha512-AAA' }];
  const published = [];
  await publishWave(artifacts, {
    distTag: 'canary',
    repoRoot: '/tmp',
    exec: (command, args) => {
      if (args[0] === 'view' && args[2] === 'dist.integrity') return { status: 0, stdout: '"sha512-AAA"', stderr: '' };
      if (args[0] === 'view') return { status: 0, stdout: '"0.1.0"', stderr: '' };
      published.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(published, []);
});

test('publishWave publishes a missing artifact and reverifies it', async () => {
  const artifacts = [{ name: '@jinn-network/trust-core', spec: '@jinn-network/trust-core@0.1.0', tarball: '/tmp/a.tgz', integrity: 'sha512-AAA' }];
  let exists = false;
  const published = [];
  await publishWave(artifacts, {
    distTag: 'canary',
    repoRoot: '/tmp',
    exec: (command, args) => {
      if (args[0] === 'view' && !exists) return { status: 1, stdout: '', stderr: 'npm error code E404' };
      if (args[0] === 'view' && args[2] === 'dist.integrity') return { status: 0, stdout: '"sha512-AAA"', stderr: '' };
      if (args[0] === 'view') return { status: 0, stdout: '"0.1.0"', stderr: '' };
      published.push(args);
      exists = true;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(published, [['publish', '/tmp/a.tgz', '--access', 'public', '--provenance', '--tag', 'canary']]);
});

test('publishWave aborts the whole wave when a preflight integrity disagrees', async () => {
  const artifacts = [
    { name: '@jinn-network/trust-core', spec: '@jinn-network/trust-core@0.1.0', tarball: '/tmp/a.tgz', integrity: 'sha512-AAA' },
    { name: '@jinn-network/trust-resolve', spec: '@jinn-network/trust-resolve@0.1.0', tarball: '/tmp/b.tgz', integrity: 'sha512-BBB' },
  ];
  const published = [];
  await assert.rejects(
    publishWave(artifacts, {
      distTag: 'canary',
      repoRoot: '/tmp',
      exec: (command, args) => {
        if (args[0] === 'view' && args[2] === 'dist.integrity') return { status: 0, stdout: '"sha512-DIFFERENT"', stderr: '' };
        if (args[0] === 'view') return { status: 0, stdout: '"canary"', stderr: '' };
        published.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /preflight integrity mismatch for @jinn-network\/trust-core@0\.1\.0: local sha512-AAA, registry sha512-DIFFERENT/,
  );
  assert.deepEqual(published, [], 'a preflight mismatch must abort before the first publish');
});

test('publishWave rejects a dist-tag that did not move to this version', async () => {
  const artifacts = [{ name: '@jinn-network/trust-core', spec: '@jinn-network/trust-core@0.1.0', tarball: '/tmp/a.tgz', integrity: 'sha512-AAA' }];
  await assert.rejects(
    publishWave(artifacts, {
      distTag: 'latest',
      repoRoot: '/tmp',
      exec: (command, args) => {
        if (args[0] === 'view' && args[2] === 'dist.integrity') return { status: 0, stdout: '"sha512-AAA"', stderr: '' };
        if (args[0] === 'view') return { status: 0, stdout: '"0.0.9"', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /preflight latest mismatch for @jinn-network\/trust-core: expected 0\.1\.0, got 0\.0\.9/,
  );
});
