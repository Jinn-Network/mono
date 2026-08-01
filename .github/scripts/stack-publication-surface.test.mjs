import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { discoverStackPackages } from './stack-package-graph.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const PUBLICATION_DIRECTORIES = ['schemas', 'profiles', 'profile', 'fixtures'];

function publicationDirectories(packageDirectory) {
  return PUBLICATION_DIRECTORIES.filter((name) => {
    const path = join(repoRoot, packageDirectory, name);
    return existsSync(path) && statSync(path).isDirectory();
  });
}

test('every schema, profile, and fixture directory is inside the packed files allowlist', () => {
  const violations = [];
  for (const pkg of discoverStackPackages(repoRoot)) {
    const files = (pkg.manifest.files ?? []).map((entry) => entry.replace(/\/$/, ''));
    for (const directory of publicationDirectories(pkg.directory)) {
      if (!files.includes(directory)) {
        violations.push(`${pkg.directory}: ${directory}/ exists but is not in "files"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('every packed publication directory is reachable through an exports subpath', () => {
  const violations = [];
  for (const pkg of discoverStackPackages(repoRoot)) {
    const exportTargets = Object.values(pkg.manifest.exports ?? {})
      .flatMap((value) => (typeof value === 'string' ? [value] : Object.values(value)))
      .filter((value) => typeof value === 'string');
    for (const directory of publicationDirectories(pkg.directory)) {
      const reachable = exportTargets.some((target) => target.includes(`./${directory}/`) || target === `./${directory}/*`);
      if (!reachable) {
        violations.push(`${pkg.directory}: ${directory}/ is packed but has no exports subpath`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
