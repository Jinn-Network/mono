import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'lifecycle-notifications');
const PACKAGE_NAME = '@jinn-network/lifecycle-notifications';

test('lifecycle-notifications inventory is the one named package with no Jinn dependencies', () => {
  const path = join(packageRoot, 'package.json');
  assert.ok(existsSync(path), `missing package manifest: ${path}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(manifest.name, PACKAGE_NAME);
  assert.equal(manifest.repository?.directory, 'packages/lifecycle-notifications');
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const jinn = Object.keys(manifest[section] ?? {}).filter((name) => name.startsWith('@jinn-network/'));
    assert.deepEqual(jinn, [], `${section} must not declare Jinn packages`);
  }
});
