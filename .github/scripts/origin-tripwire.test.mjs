import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_EXCLUSIONS,
  findEnforcedScopeViolations,
  findLegacyOriginOccurrences,
  isEnforcedPath,
  isExcludedPath,
  matchesLegacyOrigin,
} from './origin-tripwire.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

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
    // Excluded even though `client/src/` is an enforced scope: exclusions win.
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
  assert.equal(isExcludedPath('apps/jinn-agent/src/x.ts', DEFAULT_EXCLUSIONS), true);
  assert.equal(isExcludedPath('packages/core/schema.json', DEFAULT_EXCLUSIONS), false);
  // A path that merely starts with the same characters as an excluded prefix, without the
  // trailing separator, must not be treated as excluded.
  assert.equal(isExcludedPath('legacy-lookalike/schema.json', DEFAULT_EXCLUSIONS), false);
});

// --- Enforcement (DR-2026-08-04, component C2) ---

test('isEnforcedPath covers the source scopes an identifier can be minted from', () => {
  for (const enforced of [
    '.github/scripts/build-profile-root.mjs',
    'client/src/daemon/native.ts',
    'plugin/runtime/src/index.ts',
    'packages/discovery/protocol/src/identifiers.ts',
    'packages/evidence/protocol/schemas/task.schema.json',
    'packages/discovery/facts/trust/profiles/key-binding.v1.json',
  ]) {
    assert.equal(isEnforcedPath(enforced), true, enforced);
  }
  for (const reported of [
    'apps/website/index.html', // the product site legitimately names the apex
    'architecture/generated/platform-topology.md', // generated output
    'packages/trust/core/fixtures/sealing-v1/key-binding.json', // sealed pre-re-seal bytes
    'docs/runbooks/stack-npm-publishing.md',
    'client/test/daemon/native-trust-catalog.test.ts',
    'README.md',
  ]) {
    assert.equal(isEnforcedPath(reported), false, reported);
  }
});

test('a violation inside an enforced scope is reported; the same string outside one is not', () => {
  withTempRepo((root) => {
    mkdirSync(join(root, 'packages', 'core', 'src'), { recursive: true });
    mkdirSync(join(root, 'packages', 'core', 'fixtures'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'core', 'src', 'identifiers.ts'),
      "export const KIND = 'https://jinn.network/records/task/1.0';\n",
    );
    writeFileSync(
      join(root, 'packages', 'core', 'fixtures', 'sealed.json'),
      '{"kind": "https://jinn.network/records/task/1.0"}\n',
    );

    assert.equal(findLegacyOriginOccurrences({ repoRoot: root }).length, 2);
    assert.deepEqual(
      findEnforcedScopeViolations({ repoRoot: root }).map(({ path }) => path),
      ['packages/core/src/identifiers.ts'],
    );
  });
});

test('every excluded exact path exists, so the list cannot rot into a silent blanket', () => {
  for (const path of DEFAULT_EXCLUSIONS.paths) {
    assert.equal(existsSync(join(repoRoot, path)), true, path);
  }
});

test('the exclusion list is closed: widening it is a reviewed edit', () => {
  // Named here so that adding an exclusion means touching this assertion too. Each entry's
  // reason lives beside it in origin-tripwire.mjs.
  assert.deepEqual([...DEFAULT_EXCLUSIONS.paths].sort(), [
    '.github/scripts/origin-tripwire.mjs',
    '.github/scripts/origin-tripwire.test.mjs',
    '.github/scripts/public-surface-assets.mjs',
    '.github/scripts/public-surface-assets.test.mjs',
    'client/src/daemon/bridge-legacy-delivery.ts',
    'packages/benchmarking/records/src/identifiers.test.ts',
    'packages/discovery/facts/benchmarking/src/identifiers.test.ts',
    'packages/discovery/protocol/src/grammar.test.ts',
    'packages/environments/chain-record/src/identifiers.test.ts',
    'packages/environments/chain-record/src/primitives.test.ts',
    'packages/environments/information-world/src/identifiers.test.ts',
    'packages/environments/record/src/identifiers.test.ts',
    'packages/evidence/trace/src/vocabulary.test.ts',
    'packages/task-execution/backend-local/assembly/src/backend.evidence.test.ts',
  ]);
  assert.deepEqual(DEFAULT_EXCLUSIONS.prefixes, [
    'spec/',
    'log/',
    'docs/press/',
    'docs/superpowers/',
    'legacy/',
    'apps/jinn-agent/',
  ]);
});

test('this repository is clean: the CLI exits zero on the real tree', () => {
  const output = execFileSync(
    process.execPath,
    [join(repoRoot, '.github/scripts/origin-tripwire.mjs'), '--root', repoRoot],
    { encoding: 'utf8' },
  );
  assert.match(output, /no https:\/\/jinn\.network\/ occurrences in the enforced source scopes/u);
});

test('the CLI exits non-zero and names the DR when an enforced scope regresses', () => {
  withTempRepo((root) => {
    mkdirSync(join(root, 'client', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'client', 'src', 'regressed.ts'),
      "export const KIND = 'https://jinn.network/records/task/1.0';\n",
    );
    assert.throws(
      () => execFileSync(
        process.execPath,
        [join(repoRoot, '.github/scripts/origin-tripwire.mjs'), '--root', root],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /DR-2026-08-04 re-seal/u);
        assert.match(error.stderr, /client\/src\/regressed\.ts:1/u);
        return true;
      },
    );
  });
});
