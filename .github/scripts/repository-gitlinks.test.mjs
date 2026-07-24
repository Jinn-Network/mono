import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function assertSubmoduleMetadataIsValid(cwd) {
  const result = git(cwd, ['submodule', 'foreach', '--recursive', 'true']);
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
}

test('every repository gitlink has valid root-level submodule metadata', () => {
  assertSubmoduleMetadataIsValid(root);
});

test('the guard rejects an unregistered gitlink', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-unregistered-gitlink-'));
  try {
    git(fixture, ['init', '-q']);
    git(fixture, ['config', 'user.name', 'Test']);
    git(fixture, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(fixture, 'README.md'), 'fixture\n');
    git(fixture, ['add', 'README.md']);
    git(fixture, ['commit', '-q', '-m', 'fixture']);
    const sha = git(fixture, ['rev-parse', 'HEAD']).stdout.trim();

    mkdirSync(join(fixture, 'legacy'), { recursive: true });
    git(fixture, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${sha},legacy/unregistered`,
    ]);

    assert.throws(
      () => assertSubmoduleMetadataIsValid(fixture),
      /No url found for submodule path 'legacy\/unregistered'/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
