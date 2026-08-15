import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { fixtureCatalog, fixtureRepo, packageEntry } from './platform-catalog-test-fixture.mjs';
import { publicationSurfaceViolations } from './stack-publication-surface.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

function controlledRepo({ publicSurface, manifest, directories = [] }) {
  const catalog = fixtureCatalog();
  const index = catalog.packages.findIndex((pkg) => pkg.name === '@jinn-network/fixture-core-01');
  const name = '@jinn-network/fixture-publication-surface';
  const directory = 'packages/fixture/publication-surface';
  catalog.packages[index] = packageEntry(name, directory, { publicSurface });
  const manifests = Object.fromEntries(catalog.packages.map((pkg) => [
    pkg.path,
    { name: pkg.name, version: '0.1.0', files: [] },
  ]));
  manifests[directory] = { name, version: '0.1.0', ...manifest };
  const root = fixtureRepo({
    catalog,
    manifests,
  });
  for (const path of directories) mkdirSync(join(root, directory, path), { recursive: true });
  return { root, directory };
}

test('every schema, profile, and fixture directory is inside the packed files allowlist', () => {
  const violations = publicationSurfaceViolations(repoRoot)
    .filter((violation) => violation.includes('does not exist')
      || violation.includes('absent from "files"')
      || violation.endsWith('is undeclared'));
  assert.deepEqual(violations, []);
});

test('every packed publication directory is reachable through an exports subpath', () => {
  const violations = publicationSurfaceViolations(repoRoot)
    .filter((violation) => violation.includes('has no reachable export target')
      || violation.includes('conformance subpath'));
  assert.deepEqual(violations, []);
});

test('declared schema, profile, and fixture paths must exist and be packed', () => {
  const { root, directory } = controlledRepo({
    publicSurface: {
      schemas: ['assets/schemas'],
      profiles: [],
      fixtures: [],
      conformance: [],
    },
    manifest: { files: ['dist/'], exports: { '.': './dist/index.js' } },
  });
  try {
    assert.deepEqual(publicationSurfaceViolations(root), [
      `${directory}: publicSurface.schemas path assets/schemas does not exist`,
      `${directory}: publicSurface.schemas path assets/schemas is absent from "files"`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packed schema, profile, and fixture directories must be catalog-declared', () => {
  const { root, directory } = controlledRepo({
    publicSurface: { schemas: [], profiles: [], fixtures: [], conformance: [] },
    manifest: {
      files: ['schemas/', 'profile/', 'fixtures/'],
      exports: {
        './schemas/*': './schemas/*',
        './profile/*': './profile/*',
        './fixtures/*': './fixtures/*',
      },
    },
    directories: ['schemas', 'profile', 'fixtures'],
  });
  try {
    assert.deepEqual(publicationSurfaceViolations(root), [
      `${directory}: packed fixture path fixtures is undeclared`,
      `${directory}: packed profile path profile is undeclared`,
      `${directory}: packed schema path schemas is undeclared`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('declared conformance subpaths must exist as exports keys', () => {
  const { root, directory } = controlledRepo({
    publicSurface: { schemas: [], profiles: [], fixtures: [], conformance: ['./testing'] },
    manifest: { files: ['dist/'], exports: { '.': './dist/index.js' } },
  });
  try {
    assert.deepEqual(publicationSurfaceViolations(root), [
      `${directory}: conformance subpath ./testing is absent from "exports"`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packed declared directories require a reachable export target', () => {
  const { root, directory } = controlledRepo({
    publicSurface: {
      schemas: [],
      profiles: [],
      fixtures: ['assets/fixtures'],
      conformance: [],
    },
    manifest: { files: ['assets/'], exports: { '.': './dist/index.js' } },
    directories: ['assets/fixtures'],
  });
  try {
    assert.deepEqual(publicationSurfaceViolations(root), [
      `${directory}: publicSurface.fixtures path assets/fixtures has no reachable export target`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compiled module directories do not become inferred static publication surfaces', () => {
  const { root } = controlledRepo({
    publicSurface: { schemas: [], profiles: [], fixtures: [], conformance: [] },
    manifest: { files: ['dist/'], exports: { '.': './dist/index.js' } },
    directories: ['dist/schemas'],
  });
  try {
    assert.deepEqual(publicationSurfaceViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cataloged release packages without an explicit files allowlist fail closed', () => {
  const { root, directory } = controlledRepo({
    publicSurface: { schemas: [], profiles: [], fixtures: [], conformance: [] },
    manifest: { exports: { '.': './dist/index.js' } },
    directories: ['fixtures'],
  });
  try {
    assert.deepEqual(publicationSurfaceViolations(root), [
      `${directory}: package.json must declare an explicit "files" allowlist`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
