import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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
const publisherRunbookPath = resolve(
  root,
  'docs/runbooks/layer-npm-publishing.md',
);
const publisherRunbook = existsSync(publisherRunbookPath)
  ? readFileSync(publisherRunbookPath, 'utf8')
  : '';

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
    resolve(fixture, 'plugin/frozen/layer-runtime.json'),
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

function yamlBlock(source, key, indent = 2) {
  const prefix = ' '.repeat(indent);
  const marker = `${prefix}${key}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${key}`);
  const remainder = source.slice(start + marker.length);
  const nextHeader = remainder.match(
    new RegExp(`^${prefix}[a-z0-9_-]+:\\s*$`, 'mu'),
  );
  const next = nextHeader?.index === undefined
    ? -1
    : start + marker.length + nextHeader.index;
  return source.slice(start, next === -1 ? undefined : next);
}

function jobBlock(job) {
  return yamlBlock(yamlBlock(workflow, 'jobs', 0), job);
}

test('layer CI is paths-filtered and rehearses the npm-shaped package', () => {
  assert.match(ci, /'packages\/layer\/\*\*'/);
  assert.match(ci, /yarn pack:smoke/);
  assert.match(ci, /yarn typecheck/);
  assert.match(ci, /yarn test/);
  assert.match(ci, /yarn build/);
});

test('layer CI client compatibility filter names only existing test files', () => {
  const jobs = yamlBlock(ci, 'jobs', 0);
  const clientCompat = yamlBlock(jobs, 'client-compat');
  const testPaths = [...clientCompat.matchAll(/\b(test\/[^\s\\]+\.test\.ts)\b/gu)]
    .map((match) => match[1]);
  assert.ok(testPaths.length > 0, 'client-compat must run an explicit test filter');
  for (const testPath of testPaths) {
    assert.ok(
      existsSync(resolve(root, 'operator', testPath)),
      `client-compat references missing test: ${testPath}`,
    );
  }
});

test('layer CI runs both stable publish suites when publisher surfaces change', () => {
  const check = yamlBlock(yamlBlock(ci, 'jobs', 0), 'check');
  assert.match(
    check,
    /node --test \.github\/scripts\/layer-publish-workflow\.test\.mjs/,
  );
  assert.match(
    check,
    /node --test \.github\/scripts\/publish-layer-stable\.test\.mjs/,
  );

  const triggers = yamlBlock(ci, 'on', 0);
  for (const event of ['pull_request', 'push']) {
    const trigger = yamlBlock(triggers, event);
    for (const path of [
      '.github/workflows/layer-npm-publish.yml',
      '.github/scripts/layer-publish-workflow.test.mjs',
      '.github/scripts/publish-layer-stable.mjs',
      '.github/scripts/publish-layer-stable.test.mjs',
      '.github/scripts/verify-layer-stable-version.mjs',
      'docs/runbooks/layer-npm-publishing.md',
    ]) {
      assert.ok(
        trigger.includes(`- '${path}'`),
        `${event} must include ${path}`,
      );
    }
  }
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

test('publish jobs build each package before running its tests', () => {
  for (const job of ['plugin-canary', 'core-canary', 'layer-canary']) {
    const block = jobBlock(job);
    const build = block.indexOf('\n      - run: yarn build\n');
    const tests = block.indexOf('\n      - run: yarn test\n');
    assert.ok(build >= 0, `${job} must build its package`);
    assert.ok(tests > build, `${job} must build before testing`);
  }

  const stable = jobBlock('stable-publish');
  for (const packageName of ['plugin', 'core', 'layer']) {
    const packageBlock = stable.slice(
      stable.indexOf(`working-directory: packages/${packageName}`),
    );
    const build = packageBlock.indexOf('- run: yarn build');
    const tests = packageBlock.indexOf('- run: yarn test');
    assert.ok(build >= 0, `stable publish must build ${packageName}`);
    assert.ok(tests > build, `stable publish must build ${packageName} before testing`);
  }
});

test('stable publication is manual-only from exact next and uses its protected environment', () => {
  assert.doesNotMatch(workflow, /\n  release:\n\s+types: \[published\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release_tag:/);
  assert.match(workflow, /release_sha:/);
  const stable = jobBlock('stable-publish');
  assert.match(stable, /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/next'/);
  assert.match(stable, /environment: npm-stable-publish/);
  assert.match(stable, /RELEASE_TAG: \$\{\{ inputs\.release_tag \}\}/);
  assert.match(stable, /RELEASE_SHA: \$\{\{ inputs\.release_sha \}\}/);
  assert.match(stable, /ref: next/);
  assert.doesNotMatch(stable, /ref: \$\{\{ inputs\.release_sha \}\}/);
  assert.match(stable, /verify-layer-stable-version\.mjs/);
  assert.match(stable, /git ls-remote origin "refs\/tags\/\$\{RELEASE_TAG\}"/);
  assert.match(stable, /TAG_SHA.*RELEASE_SHA/s);
  assert.doesNotMatch(stable, /github\.event\.release/);
});

test('stable publication proves release ancestry from trusted next before release checkout', () => {
  const stable = jobBlock('stable-publish');
  const trustedCheckout = stable.indexOf('name: Check out trusted next history');
  const trustGate = stable.indexOf('name: Validate release identity and next ancestry');
  const stagePublisher = stable.indexOf('name: Stage publisher from protected next');
  const releaseCheckout = stable.indexOf('name: Check out validated release commit');
  const verifier = stable.indexOf('verify-layer-stable-version.mjs');
  const install = stable.indexOf('npm install -g');
  const publisher = stable.indexOf('node /tmp/publish-layer-stable.mjs');

  assert.ok(trustedCheckout >= 0);
  assert.ok(trustGate > trustedCheckout);
  assert.ok(stagePublisher > trustGate);
  assert.ok(releaseCheckout > stagePublisher);
  assert.ok(verifier > releaseCheckout);
  assert.ok(install > verifier);
  assert.ok(publisher > install);

  const trustedCheckoutBlock = stable.slice(trustedCheckout, trustGate);
  assert.match(trustedCheckoutBlock, /ref: next/);
  assert.match(trustedCheckoutBlock, /fetch-depth: 0/);
  assert.doesNotMatch(
    trustedCheckoutBlock,
    /ref: \$\{\{ inputs\.release_sha \}\}/,
  );

  const trustGateBlock = stable.slice(trustGate, stagePublisher);
  assert.ok(
    trustGateBlock.includes('[[ ! "${RELEASE_SHA}" =~ ^[0-9a-f]{40}$ ]]'),
  );
  assert.ok(
    trustGateBlock.includes(
      '[[ ! "${RELEASE_TAG}" =~ ^layer-v([0-9]+\\.[0-9]+\\.[0-9]+)$ ]]',
    ),
  );
  assert.match(
    trustGateBlock,
    /git merge-base --is-ancestor "\$\{RELEASE_SHA\}" origin\/next/,
  );
  assert.doesNotMatch(trustGateBlock, /verify-layer-stable-version\.mjs/);
  assert.doesNotMatch(trustGateBlock, /publish-layer-stable\.mjs/);
  assert.doesNotMatch(trustGateBlock, /(?:npm|yarn) install/);

  const stagePublisherBlock = stable.slice(stagePublisher, releaseCheckout);
  assert.match(
    stagePublisherBlock,
    /git show origin\/next:\.github\/scripts\/publish-layer-stable\.mjs/,
  );

  const releaseCheckoutBlock = stable.slice(releaseCheckout, verifier);
  assert.match(
    releaseCheckoutBlock,
    /git checkout --detach "\$\{RELEASE_SHA\}"/,
  );
});

test('stable publication builds the complete set before the retry-safe publisher runs', () => {
  const stable = jobBlock('stable-publish');
  const pluginBuild = stable.indexOf('working-directory: packages/plugin');
  const coreBuild = stable.indexOf('working-directory: packages/core');
  const layerBuild = stable.indexOf('working-directory: packages/layer');
  const publish = stable.indexOf('node /tmp/publish-layer-stable.mjs');
  assert.ok(pluginBuild >= 0);
  assert.ok(coreBuild > pluginBuild);
  assert.ok(layerBuild > coreBuild);
  assert.ok(publish > layerBuild);
  assert.doesNotMatch(stable, /npm publish/);
  assert.doesNotMatch(stable, /^\s+(?:-\s+)?(?:run:\s*)?npm dist-tag/m);
  assert.match(stable, /PUBLISH_VERSION=.*GITHUB_ENV/s);
  assert.match(stable, /OIDC.*does not authenticate.*dist-tag/s);
  assert.match(stable, /protected manual environment.*transient partial-release window/s);
});

test('operator runbook defines the one-publisher configuration and diagnosis path', () => {
  assert.match(workflow, /docs\/runbooks\/layer-npm-publishing\.md/);
  for (const packageName of [
    '@jinn-network/plugin',
    '@jinn-network/core',
    '@jinn-network/jinn-layer',
  ]) {
    assert.match(publisherRunbook, new RegExp(packageName.replace('/', '\\/')));
  }
  assert.match(publisherRunbook, /GitHub Actions/);
  assert.match(publisherRunbook, /Jinn-Network\/mono/);
  assert.match(publisherRunbook, /workflow filename.*layer-npm-publish\.yml/i);
  assert.match(publisherRunbook, /allowed action.*npm publish/i);
  assert.match(publisherRunbook, /one trusted publisher/i);
  assert.match(publisherRunbook, /optional.*Environment.*blank/is);
  assert.match(publisherRunbook, /npm-publish/);
  assert.match(publisherRunbook, /npm-stable-publish/);
  assert.match(publisherRunbook, /required reviewer/i);
  assert.match(publisherRunbook, /branch policy.*next/i);
  assert.match(publisherRunbook, /dist\.integrity/);
  assert.match(publisherRunbook, /dist-tags\.latest/);
  assert.match(publisherRunbook, /E404|ENEEDAUTH|403/);
  assert.match(publisherRunbook, /https:\/\/docs\.npmjs\.com\/trusted-publishers\//);
});

test('OIDC is job-scoped to publish jobs and actions are immutable', () => {
  const globalPermissions = workflow.slice(0, workflow.indexOf('jobs:'));
  assert.doesNotMatch(globalPermissions, /id-token: write/);
  for (const job of ['plugin-canary', 'core-canary', 'layer-canary', 'stable-publish']) {
    const block = jobBlock(job);
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
