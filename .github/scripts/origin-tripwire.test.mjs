import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_EXCLUSIONS,
  findLegacyOriginOccurrences,
  isExcludedPath,
  matchesLegacyOrigin,
} from './origin-tripwire.mjs';

function withTempRepo(run) {
  const root = mkdtempSync(join(tmpdir(), 'jinn-origin-tripwire-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reports a hit with the correct repository-relative path and 1-based line number', () => {
  withTempRepo((root) => {
    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'core', 'schema.json'),
      '{\n  "$id": "https://jinn.network/schemas/task/v1"\n}\n',
    );

    const hits = findLegacyOriginOccurrences({ repoRoot: root });
    assert.deepEqual(hits, [
      {
        path: 'packages/core/schema.json',
        line: 2,
        text: '  "$id": "https://jinn.network/schemas/task/v1"',
      },
    ]);
  });
});

test('an excluded exact path is not reported', () => {
  withTempRepo((root) => {
    mkdirSync(join(root, 'client', 'src', 'daemon'), { recursive: true });
    writeFileSync(
      join(root, 'client', 'src', 'daemon', 'bridge-legacy-delivery.ts'),
      "export const KEY = 'https://jinn.network/bridge/legacy-execution-envelope/1.0';\n",
    );

    const hits = findLegacyOriginOccurrences({ repoRoot: root });
    assert.deepEqual(hits, []);
  });
});

test('an excluded directory prefix is not reported', () => {
  withTempRepo((root) => {
    mkdirSync(join(root, 'spec'), { recursive: true });
    writeFileSync(
      join(root, 'spec', '2026-01-01-example.md'),
      'The origin was `https://jinn.network/schemas/task/v1`.\n',
    );

    const hits = findLegacyOriginOccurrences({ repoRoot: root });
    assert.deepEqual(hits, []);
  });
});

test('does not flag the canonical spec.jinn.network origin as a legacy occurrence', () => {
  withTempRepo((root) => {
    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'core', 'schema.json'),
      '{\n  "$id": "https://spec.jinn.network/schemas/task/v1"\n}\n',
    );

    const hits = findLegacyOriginOccurrences({ repoRoot: root });
    assert.deepEqual(hits, []);
    assert.equal(matchesLegacyOrigin('https://spec.jinn.network/schemas/task/v1'), false);
    assert.equal(matchesLegacyOrigin('https://jinn.network/schemas/task/v1'), true);
  });
});

test('node_modules and dist are skipped', () => {
  withTempRepo((root) => {
    mkdirSync(join(root, 'node_modules', 'some-dep'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'some-dep', 'index.js'),
      "module.exports = 'https://jinn.network/whatever';\n",
    );
    mkdirSync(join(root, 'packages', 'core', 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'core', 'dist', 'bundle.js'),
      "export const x = 'https://jinn.network/whatever';\n",
    );

    const hits = findLegacyOriginOccurrences({ repoRoot: root });
    assert.deepEqual(hits, []);
  });
});

test('a hit outside the frozen files and dated-record trees is still reported alongside exclusions', () => {
  withTempRepo((root) => {
    mkdirSync(join(root, 'client', 'src', 'daemon'), { recursive: true });
    writeFileSync(
      join(root, 'client', 'src', 'daemon', 'bridge-legacy-delivery.ts'),
      "export const KEY = 'https://jinn.network/bridge/legacy-execution-envelope/1.0';\n",
    );
    mkdirSync(join(root, 'spec'), { recursive: true });
    writeFileSync(join(root, 'spec', '2026-01-01-example.md'), 'https://jinn.network/x\n');
    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'core', 'schema.json'),
      '{"$id": "https://jinn.network/schemas/task/v1"}\n',
    );

    const hits = findLegacyOriginOccurrences({ repoRoot: root });
    assert.deepEqual(hits, [
      {
        path: 'packages/core/schema.json',
        line: 1,
        text: '{"$id": "https://jinn.network/schemas/task/v1"}',
      },
    ]);
  });
});

test('isExcludedPath: exact paths and directory prefixes both match, unrelated paths do not', () => {
  assert.equal(
    isExcludedPath('client/src/daemon/bridge-legacy-delivery.ts', DEFAULT_EXCLUSIONS),
    true,
  );
  assert.equal(isExcludedPath('spec/2026-01-01-example.md', DEFAULT_EXCLUSIONS), true);
  assert.equal(isExcludedPath('log/decisions/2026-08-04-x.md', DEFAULT_EXCLUSIONS), true);
  assert.equal(isExcludedPath('docs/press/2026-08-04-x.md', DEFAULT_EXCLUSIONS), true);
  assert.equal(isExcludedPath('legacy/anything.ts', DEFAULT_EXCLUSIONS), true);
  assert.equal(isExcludedPath('packages/core/schema.json', DEFAULT_EXCLUSIONS), false);
  // A path that merely starts with the same characters as an excluded prefix, without the
  // trailing separator, must not be treated as excluded.
  assert.equal(isExcludedPath('legacy-lookalike/schema.json', DEFAULT_EXCLUSIONS), false);
});
