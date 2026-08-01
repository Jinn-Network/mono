import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  applyPublishManifest,
  resolvePublishVersion,
  transformManifestForPublish,
} from './stack-publish-manifest.mjs';

const SHA = 'a'.repeat(40);
const inSetNames = new Set([
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery',
]);

function sample() {
  return {
    name: '@jinn-network/evidence-retrieval',
    version: '0.1.0',
    dependencies: {
      '@jinn-network/evidence-discovery': '0.1.0',
      '@jinn-network/evidence-protocol': '0.1.0',
      '@jinn-network/evidence-repository': '0.1.0',
    },
    peerDependencies: { vitest: '^4.1.8' },
    devDependencies: { typescript: '^5.9.3', vitest: '^4.1.8' },
    resolutions: {
      '@jinn-network/evidence-discovery': 'portal:../discovery',
      '@jinn-network/evidence-protocol': 'portal:../protocol',
      '@jinn-network/evidence-repository': 'portal:../repository',
      vite: '6.4.3',
    },
  };
}

test('canary version and dist-tag follow the existing scheme', () => {
  assert.deepEqual(
    resolvePublishVersion({ mode: 'canary', baseVersion: '0.1.0', sha: SHA }),
    { version: `0.1.0-canary.sha.${SHA}`, distTag: 'canary' },
  );
});

test('stable version comes from a stack-v tag and must match the manifest version', () => {
  assert.deepEqual(
    resolvePublishVersion({ mode: 'stable', baseVersion: '0.1.0', releaseTag: 'stack-v0.1.0' }),
    { version: '0.1.0', distTag: 'latest' },
  );
  assert.throws(
    () => resolvePublishVersion({ mode: 'stable', baseVersion: '0.1.0', releaseTag: 'stack-v0.2.0' }),
    /release tag stack-v0.2.0 resolves to 0.2.0, but the package set is at 0.1.0/,
  );
  assert.throws(
    () => resolvePublishVersion({ mode: 'stable', baseVersion: '0.1.0', releaseTag: 'v0.1.0' }),
    /stable platform releases must use stack-v<semver>, got v0.1.0/,
  );
  assert.throws(
    () => resolvePublishVersion({ mode: 'canary', baseVersion: '0.1.0', sha: 'abc' }),
    /canary publishing requires a 40-character commit sha, got abc/,
  );
});

test('the transform patches version, in-set pins, and gitHead', () => {
  const version = `0.1.0-canary.sha.${SHA}`;
  const patched = transformManifestForPublish(sample(), { version, gitHead: SHA, inSetNames });
  assert.equal(patched.version, version);
  assert.equal(patched.gitHead, SHA);
  assert.deepEqual(patched.dependencies, {
    '@jinn-network/evidence-discovery': version,
    '@jinn-network/evidence-protocol': version,
    '@jinn-network/evidence-repository': version,
  });
});

test('the transform strips portal resolutions and preserves the rest', () => {
  const patched = transformManifestForPublish(sample(), { version: '0.1.0', gitHead: SHA, inSetNames });
  assert.deepEqual(patched.resolutions, { vite: '6.4.3' });
});

test('resolutions is deleted when only portal entries existed', () => {
  const manifest = sample();
  delete manifest.resolutions.vite;
  const patched = transformManifestForPublish(manifest, { version: '0.1.0', gitHead: SHA, inSetNames });
  assert.equal('resolutions' in patched, false);
});

test('the transform never mutates its input and leaves out-of-set specifiers alone', () => {
  const original = sample();
  const snapshot = JSON.stringify(original);
  const patched = transformManifestForPublish(original, { version: '9.9.9', gitHead: SHA, inSetNames });
  assert.equal(JSON.stringify(original), snapshot);
  assert.deepEqual(patched.devDependencies, { typescript: '^5.9.3', vitest: '^4.1.8' });
  assert.deepEqual(patched.peerDependencies, { vitest: '^4.1.8' });
});

test('applyPublishManifest writes the patched bytes and restores the original exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-publish-manifest-'));
  const path = join(dir, 'package.json');
  const originalBytes = `${JSON.stringify(sample(), null, 2)}\n`;
  writeFileSync(path, originalBytes, 'utf8');
  try {
    const { restore } = applyPublishManifest(path, { version: '0.1.0-canary.sha.' + SHA, gitHead: SHA, inSetNames });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.version, `0.1.0-canary.sha.${SHA}`);
    assert.equal(written.resolutions['@jinn-network/evidence-protocol'], undefined);
    restore();
    assert.equal(readFileSync(path, 'utf8'), originalBytes);
    restore();
    assert.equal(readFileSync(path, 'utf8'), originalBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
