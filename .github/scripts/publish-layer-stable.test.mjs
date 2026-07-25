import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const publisher = resolve(root, '.github/scripts/publish-layer-stable.mjs');
const version = '0.1.0';
const packages = [
  { directory: 'packages/plugin', name: '@jinn-network/plugin' },
  { directory: 'packages/core', name: '@jinn-network/core' },
  { directory: 'packages/layer', name: '@jinn-network/jinn-layer' },
];

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function packedBytes(name) {
  return Buffer.from(`${JSON.stringify({ name, version })}\n`, 'utf8');
}

function integrityFor(name) {
  return `sha512-${createHash('sha512').update(packedBytes(name)).digest('base64')}`;
}

function tarballName(name) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

function createFixture(initialState = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-layer-stable-publish-'));
  const statePath = resolve(fixture, 'registry-state.json');
  const logPath = resolve(fixture, 'npm-calls.jsonl');
  const npmPath = resolve(fixture, 'fake-npm.mjs');

  for (const pkg of packages) {
    writeJson(resolve(fixture, pkg.directory, 'package.json'), {
      name: pkg.name,
      version,
    });
  }
  writeJson(statePath, { registry: {}, tags: {}, ...initialState });
  writeFileSync(npmPath, `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_NPM_STATE;
const logPath = process.env.FAKE_NPM_LOG;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n');
appendFileSync(logPath, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');

if (args[0] === 'pack') {
  const destination = args[args.indexOf('--pack-destination') + 1];
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const filename = manifest.name.replace(/^@/, '').replaceAll('/', '-') + '-' + manifest.version + '.tgz';
  mkdirSync(destination, { recursive: true });
  writeFileSync(resolve(destination, filename), JSON.stringify({ name: manifest.name, version: manifest.version }) + '\\n');
  process.stdout.write(JSON.stringify([{ name: manifest.name, version: manifest.version, filename }]) + '\\n');
} else if (args[0] === 'view') {
  const target = args[1];
  const field = args[2];
  if (state.viewError === target + ':' + field) {
    process.stderr.write(JSON.stringify({ error: { code: 'E401', summary: 'unauthorized' } }) + '\\n');
    process.exitCode = 1;
  } else if (field === 'dist.integrity' && Object.hasOwn(state.registry, target)) {
    if ((state.delayedIntegrity?.[target] ?? 0) > 0) {
      state.delayedIntegrity[target] -= 1;
      save();
      process.stderr.write(JSON.stringify({ error: { code: 'E404', summary: 'not found' } }) + '\\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(JSON.stringify(state.registry[target]) + '\\n');
    }
  } else if (field === 'dist.integrity' && (state.delayedIntegrity?.[target] ?? 0) > 0) {
    state.delayedIntegrity[target] -= 1;
    save();
    process.stderr.write(JSON.stringify({ error: { code: 'E404', summary: 'not found' } }) + '\\n');
    process.exitCode = 1;
  } else if (field === 'dist-tags.latest' && Object.hasOwn(state.tags, target)) {
    state.latestViews ??= {};
    state.latestViews[target] = (state.latestViews[target] ?? 0) + 1;
    const latest = state.corruptLatestOnFinal === target && state.latestViews[target] > 1
      ? '0.0.9'
      : state.tags[target];
    save();
    process.stdout.write(JSON.stringify(latest) + '\\n');
  } else {
    process.stderr.write(JSON.stringify({ error: { code: 'E404', summary: 'not found' } }) + '\\n');
    process.exitCode = 1;
  }
} else if (args[0] === 'publish') {
  const tarball = args[1];
  const packed = JSON.parse(readFileSync(tarball, 'utf8'));
  const spec = packed.name + '@' + packed.version;
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
  if (state.failPublish === spec) {
    process.stderr.write('simulated publish failure for ' + spec + '\\n');
    process.exitCode = 1;
  } else {
    state.registry[spec] = state.corruptPublish === spec ? 'sha512-corrupt' : integrity;
    state.tags[packed.name] = state.corruptLatest === spec ? '0.0.9' : packed.version;
    save();
  }
} else {
  process.stderr.write('unexpected fake npm command: ' + args.join(' ') + '\\n');
  process.exitCode = 2;
}
`, 'utf8');
  chmodSync(npmPath, 0o755);

  return { fixture, statePath, logPath, npmPath };
}

function runPublisher(context) {
  return spawnSync(
    process.execPath,
    [publisher, '--root', context.fixture, '--version', version, '--npm', context.npmPath],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_NPM_STATE: context.statePath,
        FAKE_NPM_LOG: context.logPath,
        JINN_NPM_REGISTRY_RETRY_DELAY_MS: '0',
      },
    },
  );
}

function callsFor(context) {
  return readFileSync(context.logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function cleanup(context) {
  rmSync(context.fixture, { recursive: true, force: true });
}

test('packs and preflights every package before publishing missing versions directly to latest', () => {
  const context = createFixture();
  try {
    const result = runPublisher(context);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const calls = callsFor(context);
    const packs = calls.filter(({ args }) => args[0] === 'pack');
    const publishes = calls.filter(({ args }) => args[0] === 'publish');
    const views = calls.filter(({ args }) => args[0] === 'view');
    assert.equal(packs.length, 3);
    assert.equal(publishes.length, 3);
    assert.equal(views.length, 15);
    assert.ok(calls.lastIndexOf(packs.at(-1)) < calls.indexOf(publishes[0]));
    for (const [index, publish] of publishes.entries()) {
      assert.deepEqual(publish.args.slice(2), ['--access', 'public', '--tag', 'latest']);
      const publishAt = calls.indexOf(publish);
      assert.deepEqual(calls[publishAt + 1].args.slice(0, 3), [
        'view',
        `${packages[index].name}@${version}`,
        'dist.integrity',
      ]);
      assert.deepEqual(calls[publishAt + 2].args.slice(0, 3), [
        'view',
        packages[index].name,
        'dist-tags.latest',
      ]);
    }
    assert.ok(!calls.some(({ args }) => args[0] === 'dist-tag'));
    const state = JSON.parse(readFileSync(context.statePath, 'utf8'));
    assert.deepEqual(state.tags, Object.fromEntries(packages.map(({ name }) => [name, version])));
  } finally {
    cleanup(context);
  }
});

for (const { failedPackage, publishedBeforeFailure } of [
  { failedPackage: packages[1], publishedBeforeFailure: packages.slice(0, 1) },
  { failedPackage: packages[2], publishedBeforeFailure: packages.slice(0, 2) },
]) {
  test(`resumes safely after publication fails at ${failedPackage.name}`, () => {
    const failedSpec = `${failedPackage.name}@${version}`;
    const context = createFixture({
      registry: {},
      tags: {},
      failPublish: failedSpec,
    });
    try {
      const first = runPublisher(context);
      assert.notEqual(first.status, 0);
      assert.match(first.stderr, /simulated publish failure/);
      const firstCalls = callsFor(context);
      const partial = JSON.parse(readFileSync(context.statePath, 'utf8'));
      assert.deepEqual(
        Object.keys(partial.registry),
        publishedBeforeFailure.map(({ name }) => `${name}@${version}`),
      );

      delete partial.failPublish;
      writeJson(context.statePath, partial);
      const second = runPublisher(context);
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const resumedPublishes = callsFor(context)
        .slice(firstCalls.length)
        .filter(({ args }) => args[0] === 'publish');
      assert.deepEqual(
        resumedPublishes.map(({ args }) => basename(args[1])),
        packages.slice(publishedBeforeFailure.length).map(({ name }) => tarballName(name)),
      );
      const complete = JSON.parse(readFileSync(context.statePath, 'utf8'));
      assert.equal(Object.keys(complete.registry).length, 3);
      assert.deepEqual(complete.tags, Object.fromEntries(packages.map(({ name }) => [name, version])));
    } finally {
      cleanup(context);
    }
  });
}

test('fails closed before any publish when an immutable registry version has different integrity', () => {
  const plugin = packages[0].name;
  const context = createFixture({
    registry: { [`${plugin}@${version}`]: 'sha512-different' },
    tags: {},
  });
  try {
    const result = runPublisher(context);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /integrity mismatch/i);
    assert.ok(!callsFor(context).some(({ args }) => args[0] === 'publish'));
  } finally {
    cleanup(context);
  }
});

test('stops before the next package when post-publish integrity does not match', () => {
  const core = packages[1].name;
  const context = createFixture({
    registry: {},
    tags: {},
    corruptPublish: `${core}@${version}`,
  });
  try {
    const result = runPublisher(context);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /integrity mismatch/i);
    const publishes = callsFor(context).filter(({ args }) => args[0] === 'publish');
    assert.equal(publishes.length, 2);
    assert.ok(!publishes.some(({ args }) => basename(args[1]).includes('jinn-layer')));
  } finally {
    cleanup(context);
  }
});

for (const [index, corrupted] of packages.slice(0, 2).entries()) {
  test(`stops before downstream publish when ${corrupted.name} latest is wrong`, () => {
    const context = createFixture({
      registry: {},
      tags: {},
      corruptLatest: `${corrupted.name}@${version}`,
    });
    try {
      const result = runPublisher(context);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /post-publish latest tag mismatch/i);
      const publishes = callsFor(context).filter(({ args }) => args[0] === 'publish');
      assert.equal(publishes.length, index + 1);
      assert.deepEqual(
        publishes.map(({ args }) => basename(args[1])),
        packages.slice(0, index + 1).map(({ name }) => tarballName(name)),
      );
    } finally {
      cleanup(context);
    }
  });
}

test('fails final verification when any latest tag does not select the exact version', () => {
  const layer = packages[2].name;
  const context = createFixture({
    registry: {},
    tags: {},
    corruptLatestOnFinal: layer,
  });
  try {
    const result = runPublisher(context);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /latest.*mismatch/i);
    const latestViews = callsFor(context).filter(
      ({ args }) => args[0] === 'view' && args[2] === 'dist-tags.latest',
    );
    assert.equal(latestViews.length, 6);
    assert.ok(!callsFor(context).some(({ args }) => args[0] === 'dist-tag'));
  } finally {
    cleanup(context);
  }
});

for (const { name, tags } of [
  { name: 'missing', tags: {} },
  { name: 'wrong', tags: { [packages[0].name]: '0.0.9' } },
]) {
  test(`fails before mutation when an existing matching version has a ${name} latest tag`, () => {
    const plugin = packages[0].name;
    const context = createFixture({
      registry: { [`${plugin}@${version}`]: integrityFor(plugin) },
      tags,
    });
    try {
      const result = runPublisher(context);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /preflight latest tag mismatch/i);
      assert.ok(!callsFor(context).some(({ args }) => args[0] === 'publish'));
    } finally {
      cleanup(context);
    }
  });
}

test('skips an existing version only when its exact local tarball integrity matches', () => {
  const plugin = packages[0].name;
  const context = createFixture({
    registry: { [`${plugin}@${version}`]: integrityFor(plugin) },
    tags: { [plugin]: version },
  });
  try {
    const result = runPublisher(context);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const publishes = callsFor(context).filter(({ args }) => args[0] === 'publish');
    assert.equal(publishes.length, 2);
    assert.ok(publishes.every(({ args }) => !basename(args[1]).includes('plugin')));
  } finally {
    cleanup(context);
  }
});

test('retries post-publish registry reads when npm propagation is briefly delayed', () => {
  const core = packages[1].name;
  const coreSpec = `${core}@${version}`;
  const context = createFixture({
    registry: {},
    tags: {},
    delayedIntegrity: { [coreSpec]: 2 },
  });
  try {
    const result = runPublisher(context);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const integrityViews = callsFor(context).filter(
      ({ args }) => args[0] === 'view' && args[1] === coreSpec && args[2] === 'dist.integrity',
    );
    assert.ok(integrityViews.length >= 4);
    const state = JSON.parse(readFileSync(context.statePath, 'utf8'));
    assert.equal(state.registry[coreSpec], integrityFor(core));
  } finally {
    cleanup(context);
  }
});
