import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(
  resolve(root, '.github/workflows/layer-npm-publish.yml'),
  'utf8',
);
const ci = readFileSync(
  resolve(root, '.github/workflows/layer-ci.yml'),
  'utf8',
);
const stableVersionVerifier = resolve(
  root,
  '.github/scripts/verify-layer-stable-version.mjs',
);

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function releaseFixture(overrides = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-layer-stable-version-'));
  const version = '0.1.0';
  writeJson(resolve(fixture, 'packages/plugin/package.json'), {
    name: '@jinn-network/plugin',
    version,
    ...overrides.plugin,
  });
  writeJson(resolve(fixture, 'packages/core/package.json'), {
    name: '@jinn-network/core',
    version,
    dependencies: { '@jinn-network/plugin': version },
    ...overrides.core,
  });
  writeJson(resolve(fixture, 'packages/layer/package.json'), {
    name: '@jinn-network/jinn-layer',
    version,
    dependencies: {
      '@jinn-network/plugin': version,
      '@jinn-network/core': version,
    },
    ...overrides.layer,
  });
  writeJson(
    resolve(fixture, 'apps/jinn-agent/plugins/jinn/layer-runtime.json'),
    {
      package: '@jinn-network/jinn-layer',
      version,
      bin: 'runtime/node_modules/.bin/jinn-layer',
      ...overrides.runtime,
    },
  );
  return fixture;
}

function verifyStableVersion(fixture, version) {
  return spawnSync(
    process.execPath,
    [stableVersionVerifier, '--root', fixture, '--version', version],
    { encoding: 'utf8' },
  );
}

test('layer CI is paths-filtered and rehearses the npm-shaped package', () => {
  assert.match(ci, /'packages\/layer\/\*\*'/);
  assert.match(ci, /yarn pack:smoke/);
  assert.match(ci, /yarn typecheck/);
  assert.match(ci, /yarn test/);
  assert.match(ci, /yarn build/);
});

test('canary publication is dependency ordered and restricted to next', () => {
  assert.match(workflow, /branches: \[next\]/);
  assert.match(workflow, /plugin-canary:/);
  assert.match(workflow, /core-canary:/);
  assert.match(workflow, /needs: plugin-canary/);
  assert.match(workflow, /layer-canary:/);
  assert.match(workflow, /needs: core-canary/);
  assert.match(workflow, /-canary\.\$\{SHORT_SHA\}/);
  assert.match(workflow, /npm publish --access public --tag canary/);
  assert.match(workflow, /if: github\.event_name == 'push'/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./);
});

test('stable publication is human-gated, exact-ref gated, and uses the same trusted workflow', () => {
  assert.match(workflow, /release:\n\s+types: \[published\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release_tag:/);
  assert.match(workflow, /release_sha:/);
  assert.match(workflow, /stable-publish:/);
  assert.match(workflow, /environment: npm-publish/);
  assert.match(workflow, /startsWith\(github\.event\.release\.tag_name, 'layer-v'\)/);
  assert.match(workflow, /verify-layer-stable-version\.mjs/);
  assert.match(workflow, /npm publish .*--tag latest/s);
  assert.match(workflow, /git ls-remote origin "refs\/tags\/\$\{RELEASE_TAG\}"/);
  assert.match(workflow, /TAG_SHA.*RELEASE_SHA/s);
});

test('OIDC is job-scoped to publish jobs and actions are immutable', () => {
  const globalPermissions = workflow.slice(0, workflow.indexOf('jobs:'));
  assert.doesNotMatch(globalPermissions, /id-token: write/);
  for (const job of ['plugin-canary', 'core-canary', 'layer-canary', 'stable-publish']) {
    const start = workflow.indexOf(`  ${job}:`);
    assert.notEqual(start, -1, `missing ${job}`);
    const remainder = workflow.slice(start + 1);
    const nextHeader = remainder.match(/\n  [a-z0-9_-]+:\n/u);
    const next = nextHeader?.index === undefined
      ? -1
      : start + 1 + nextHeader.index;
    const block = workflow.slice(start, next === -1 ? undefined : next);
    assert.match(block, /permissions:\n\s+contents: read\n\s+id-token: write/);
  }
  for (const action of ['checkout', 'setup-node']) {
    const uses = [...workflow.matchAll(
      new RegExp(`uses: actions/${action}@([^\\s]+)\\s+# v7`, 'g'),
    )];
    assert.ok(uses.length > 0, `missing actions/${action}`);
    for (const [, revision] of uses) {
      assert.match(revision, /^[0-9a-f]{40}$/u);
    }
  }
});

test('stable version verifier accepts only coherent package and runtime pins', () => {
  const fixture = releaseFixture();
  try {
    const result = verifyStableVersion(fixture, '0.1.0');
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('stable version verifier fails closed for canaries and pin drift', () => {
  const coherent = releaseFixture();
  const runtimeDrift = releaseFixture({ runtime: { version: '0.0.9' } });
  const dependencyDrift = releaseFixture({
    layer: {
      dependencies: {
        '@jinn-network/plugin': '0.1.0',
        '@jinn-network/core': '0.0.9',
      },
    },
  });
  try {
    const canary = verifyStableVersion(coherent, '0.1.0-canary.deadbeef');
    assert.notEqual(canary.status, 0);
    assert.match(canary.stderr, /stable semver/);

    const runtime = verifyStableVersion(runtimeDrift, '0.1.0');
    assert.notEqual(runtime.status, 0);
    assert.match(runtime.stderr, /runtime pin/);

    const dependency = verifyStableVersion(dependencyDrift, '0.1.0');
    assert.notEqual(dependency.status, 0);
    assert.match(dependency.stderr, /dependency pin/);
  } finally {
    for (const fixture of [coherent, runtimeDrift, dependencyDrift]) {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

test('local pack smoke never publishes', () => {
  const smoke = readFileSync(
    resolve(root, 'packages/layer/scripts/pack-smoke.mjs'),
    'utf8',
  );
  assert.match(smoke, /npm.*pack/s);
  assert.match(smoke, /session.*pickup/s);
  assert.match(smoke, /session.*end/s);
  assert.doesNotMatch(smoke, /npm['"]?,\s*\[['"]publish/);
  assert.doesNotMatch(smoke, /npm publish/);
});
