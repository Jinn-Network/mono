import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalJsonBytes } from './build-prepublication-bundle.mjs';
import { buildProfileRoot } from './build-profile-root.mjs';
import {
  disableReleaseGroup,
  fixtureCatalog,
  fixtureRepo,
} from './platform-catalog-test-fixture.mjs';
import {
  createVerificationReceipt,
  verificationGateConclusionIds,
} from './platform-verification-receipt.mjs';
import {
  NPM_REGISTRY,
  publishVerifiedPlatform,
} from './publish-verified-platform.mjs';
import {
  buildRegistrationList,
  renderRegistrationMarkdown,
} from './stack-trusted-publishers.mjs';

const SHA = 'c'.repeat(40);
const REPOSITORY = 'Jinn-Network/mono';
const SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/platform-verification.yml`;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sri(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function successfulConclusions() {
  return Object.fromEntries(
    verificationGateConclusionIds(fixtureCatalog(), 'platform-v1')
      .map((gate) => [gate, 'success']),
  );
}

function publicationFixture({
  platformPackageNames,
  mutateCatalog,
  allowIneligibleRegistrationFixture = false,
} = {}) {
  const catalog = fixtureCatalog();
  if (platformPackageNames) {
    const selected = new Set(platformPackageNames);
    catalog.packages = catalog.packages.filter(({ name, releaseGroup }) => (
      releaseGroup !== 'platform-v1' || selected.has(name)
    ));
    catalog.releaseGroups['platform-v1'].expectedPackageCount = selected.size;
  }
  mutateCatalog?.(catalog);
  const profilePackage = catalog.packages.find(({ name }) => name === '@jinn-network/fixture-protocol');
  profilePackage.publicSurface.schemas = ['schemas'];
  const repoRoot = fixtureRepo({ catalog });
  const root = mkdtempSync(join(tmpdir(), 'jinn-verified-publication-'));
  const verificationRoot = join(root, '.platform-verification');
  const packRoot = join(verificationRoot, 'pack');
  mkdirSync(join(packRoot, 'tarballs'), { recursive: true });

  const catalogPath = join(repoRoot, 'architecture/platform-packages.v1.json');
  const sourceProfileRoot = join(repoRoot, profilePackage.path, 'schemas');
  mkdirSync(sourceProfileRoot, { recursive: true });
  writeFileSync(join(sourceProfileRoot, 'profile.schema.json'), `${JSON.stringify({
    $id: 'https://spec.jinn.network/fixture/profile.schema.json',
    type: 'object',
  }, null, 2)}\n`, 'utf8');

  const packages = catalog.packages
    .filter(({ releaseGroup }) => releaseGroup === 'platform-v1')
    .sort((left, right) => left.path.localeCompare(right.path));
  const coreNames = packages
    .map(({ name }) => name)
    .filter((name) => name.startsWith('@jinn-network/fixture-core-'))
    .sort();
  const firstWave = [...coreNames, '@jinn-network/fixture-protocol'].sort();
  const waves = [firstWave, ['@jinn-network/fixture-application']];
  const packageOrder = waves.flat();
  const packageVersion = `0.1.0-canary.sha.${SHA}`;
  const catalogDigest = sha256(readFileSync(catalogPath));
  const tarballs = packageOrder.map((name, index) => {
    const filename = `tarballs/package-${String(index + 1).padStart(2, '0')}.tgz`;
    const bytes = Buffer.from(`publication-tarball:${name}`);
    writeFileSync(join(packRoot, filename), bytes);
    return { name, filename, integrity: sri(bytes) };
  });
  const pack = {
    schemaVersion: 1,
    sourceSha: SHA,
    catalog: { path: 'architecture/platform-packages.v1.json', sha256: catalogDigest },
    releaseGroup: 'platform-v1',
    lane: 'canary',
    packageVersion,
    distTag: 'canary',
    waves,
    packageOrder,
    tarballs,
  };
  const publicSurface = {
    schemaVersion: 1,
    sourceSha: SHA,
    catalog: { path: 'architecture/platform-packages.v1.json', sha256: catalogDigest },
    releaseGroup: 'platform-v1',
    lane: 'canary',
    packages: packages.map(({ name, path, publicSurface }) => ({
      name,
      path,
      publicSurface,
    })),
  };
  const profileRoot = join(verificationRoot, 'profile-root');
  buildProfileRoot({
    repoRoot,
    outDir: profileRoot,
    commit: SHA,
    catalogDigest,
    releaseGroup: 'platform-v1',
    lane: 'canary',
  });

  const packManifestPath = join(packRoot, 'manifest.json');
  const publicManifestPath = join(verificationRoot, 'public-surface-manifest.json');
  const profileManifestPath = join(profileRoot, 'manifest.json');
  const trustedPublishersRoot = join(verificationRoot, 'trusted-publishers');
  const trustedPublishersJsonPath = join(trustedPublishersRoot, 'trusted-publishers.json');
  const trustedPublishersMarkdownPath = join(trustedPublishersRoot, 'trusted-publishers.md');
  const registrations = allowIneligibleRegistrationFixture
    ? packages.map(({ name: packageName }) => ({
      package: packageName,
      provider: 'GitHub Actions',
      organization: 'Jinn-Network',
      repository: 'mono',
      workflow: 'stack-npm-publish.yml',
      environment: 'npm-publish',
      allowedActions: ['npm publish'],
    }))
    : buildRegistrationList(repoRoot);
  mkdirSync(trustedPublishersRoot);
  writeFileSync(trustedPublishersJsonPath, `${JSON.stringify(registrations, null, 2)}\n`, 'utf8');
  writeFileSync(trustedPublishersMarkdownPath, renderRegistrationMarkdown(registrations), 'utf8');
  writeFileSync(packManifestPath, canonicalJsonBytes(pack), 'utf8');
  writeFileSync(publicManifestPath, canonicalJsonBytes(publicSurface), 'utf8');
  const receiptDir = join(root, '.platform-verification-receipt');
  mkdirSync(receiptDir);
  const receiptPath = join(receiptDir, 'verification-receipt.json');
  const receipt = createVerificationReceipt({
    repoRoot,
    sourceSha: SHA,
    catalogDigest,
    releaseGroup: 'platform-v1',
    lane: 'canary',
    packManifestPath,
    publicManifestPath,
    profileManifestPath,
    trustedPublishersRoot,
    trustedPublishersJsonPath,
    trustedPublishersMarkdownPath,
    conclusions: successfulConclusions(),
    outputPath: receiptPath,
  });
  return {
    repoRoot,
    root,
    verificationRoot,
    packRoot,
    profileRoot,
    packManifestPath,
    publicManifestPath,
    profileManifestPath,
    trustedPublishersRoot,
    trustedPublishersJsonPath,
    trustedPublishersMarkdownPath,
    receiptPath,
    outputPath: join(root, '.platform-publication/publication-receipt.json'),
    catalogDigest,
    receipt,
    packageVersion,
  };
}

function cleanup(fixture) {
  rmSync(fixture.repoRoot, { recursive: true, force: true });
  rmSync(fixture.root, { recursive: true, force: true });
}

function publisherArgs(fixture, overrides = {}) {
  return {
    repoRoot: fixture.repoRoot,
    verificationRoot: fixture.verificationRoot,
    verificationReceiptPath: fixture.receiptPath,
    sourceSha: SHA,
    releaseGroup: 'platform-v1',
    lane: 'canary',
    registry: NPM_REGISTRY,
    repository: REPOSITORY,
    outputPath: fixture.outputPath,
    ...overrides,
  };
}

function readSpec(spec) {
  const splitAt = spec.lastIndexOf('@');
  return { name: spec.slice(0, splitAt), version: spec.slice(splitAt + 1) };
}

function registryExec(fixture, options = {}) {
  const calls = [];
  const tarballByPath = new Map(fixture.receipt.tarballs.map((tarball) => [
    join(fixture.packRoot, tarball.filename),
    tarball,
  ]));
  const states = new Map();
  const publishedNames = new Set();
  for (const tarball of fixture.receipt.tarballs) {
    if (options.missingByDefault === false || options.existingNames?.includes(tarball.name)) {
      states.set(tarball.name, {
        version: fixture.packageVersion,
        integrity: tarball.integrity,
        tag: fixture.packageVersion,
      });
    }
  }
  if (options.stateMutations) options.stateMutations(states, fixture);

  const exec = (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    if (command === 'gh') {
      if (options.failAttestationPath && args[2] === options.failAttestationPath) {
        return { status: 1, stdout: '', stderr: 'attestation verification failed' };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    }
    if (command !== 'npm') throw new Error(`unexpected command ${command}`);
    if (args[0] === 'publish') {
      const tarball = tarballByPath.get(args[1]);
      assert.ok(tarball, `publisher used a receipt-bound tarball: ${args[1]}`);
      states.set(tarball.name, {
        version: fixture.packageVersion,
        integrity: tarball.integrity,
        tag: fixture.packageVersion,
      });
      publishedNames.add(tarball.name);
      if (options.afterPublish) options.afterPublish(states, tarball, calls);
      return { status: 0, stdout: '', stderr: '' };
    }
    assert.equal(args[0], 'view');
    const registryAt = args.indexOf('--registry');
    assert.equal(args[registryAt + 1], NPM_REGISTRY);
    const field = args[2];
    const targetName = field === 'dist-tags.canary' ? args[1] : readSpec(args[1]).name;
    const override = options.viewOverride?.({
      args,
      field,
      name: targetName,
      publishedNames,
      states,
    });
    if (override) return override;
    if (field === 'dist-tags.canary') {
      const state = states.get(args[1]);
      return state
        ? { status: 0, stdout: JSON.stringify(state.tag), stderr: '' }
        : { status: 1, stdout: '', stderr: 'npm error code E404' };
    }
    const { name, version } = readSpec(args[1]);
    const state = states.get(name);
    if (!state) return { status: 1, stdout: '', stderr: 'npm error code E404' };
    if (options.unreachableName === name && field === 'version') {
      return { status: 1, stdout: '', stderr: 'ECONNREFUSED registry unavailable' };
    }
    if (options.invalidJsonName === name && field === 'version') {
      return { status: 0, stdout: '{broken', stderr: '' };
    }
    if (field === 'version') return { status: 0, stdout: JSON.stringify(state.version ?? version), stderr: '' };
    if (field === 'dist.integrity') {
      return { status: 0, stdout: state.integrity === undefined ? '' : JSON.stringify(state.integrity), stderr: '' };
    }
    throw new Error(`unexpected npm view field ${field}`);
  };
  return { calls, exec, states };
}

function npmCalls(calls) {
  return calls.filter(({ command }) => command === 'npm');
}

function publishCalls(calls) {
  return calls.filter(({ command, args }) => command === 'npm' && args[0] === 'publish');
}

function rewriteReceipt(fixture, mutate) {
  const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
  mutate(receipt);
  writeFileSync(fixture.receiptPath, canonicalJsonBytes(receipt), 'utf8');
}

test('verifies every subject before npm, publishes the catalog receipt in wave order, and writes the final receipt', async () => {
  const fixture = publicationFixture();
  const fake = registryExec(fixture);
  try {
    const receipt = await publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec }));
    const ghCalls = fake.calls.filter(({ command }) => command === 'gh');
    const expectedSubjects = [
      fixture.packManifestPath,
      ...fixture.receipt.tarballs.map(({ filename }) => join(fixture.packRoot, filename)),
      fixture.publicManifestPath,
      fixture.profileManifestPath,
      join(fixture.profileRoot, fixture.receipt.surfaces.profile.documents[0].path),
      fixture.trustedPublishersJsonPath,
      fixture.trustedPublishersMarkdownPath,
      fixture.receiptPath,
    ];
    assert.deepEqual(ghCalls.map(({ args }) => args[2]), expectedSubjects);
    for (const { args } of ghCalls) {
      assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
      assert.equal(args[args.indexOf('--repo') + 1], REPOSITORY);
      assert.equal(args[args.indexOf('--signer-workflow') + 1], SIGNER_WORKFLOW);
      assert.equal(args[args.indexOf('--source-digest') + 1], SHA);
    }
    const firstNpmAt = fake.calls.findIndex(({ command }) => command === 'npm');
    const lastGhAt = fake.calls.findLastIndex(({ command }) => command === 'gh');
    assert.ok(lastGhAt < firstNpmAt, 'all provenance must verify before npm is reachable');
    assert.deepEqual(
      publishCalls(fake.calls).map(({ args }) => tarballByName(fixture, args[1])),
      fixture.receipt.packageOrder,
    );
    for (const { args } of publishCalls(fake.calls)) {
      assert.deepEqual(args.slice(2), [
        '--access', 'public',
        '--provenance',
        '--tag', 'canary',
        '--registry', NPM_REGISTRY,
      ]);
    }
    assert.equal(fake.calls.some(({ command, args }) => command === 'npm' && args[0] === 'pack'), false);
    assert.equal(fake.calls.some(({ command }) => command === 'yarn'), false);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.verificationReceiptSha256, sha256(readFileSync(fixture.receiptPath)));
    assert.equal(receipt.sourceSha, SHA);
    assert.deepEqual(receipt.catalog, fixture.receipt.catalog);
    assert.deepEqual(receipt.packageOrder, fixture.receipt.packageOrder);
    assert.deepEqual(receipt.waves, fixture.receipt.waves);
    assert.equal(receipt.packageVersion, fixture.packageVersion);
    assert.equal(receipt.distTag, 'canary');
    assert.deepEqual(receipt.npm, { registry: NPM_REGISTRY });
    assert.equal(receipt.trustedPublishers.registrationCount, fixture.receipt.packageOrder.length);
    assert.equal(receipt.trustedPublishers.jsonSha256, sha256(readFileSync(fixture.trustedPublishersJsonPath)));
    assert.equal(receipt.trustedPublishers.markdownSha256, sha256(readFileSync(fixture.trustedPublishersMarkdownPath)));
    assert.equal(receipt.observedRegistry.length, fixture.receipt.packageOrder.length);
    assert.deepEqual(receipt.observedRegistry.map(({ name }) => name), fixture.receipt.packageOrder);
    assert.equal(readFileSync(fixture.outputPath, 'utf8'), canonicalJsonBytes(receipt));
  } finally {
    cleanup(fixture);
  }
});

test('publishes a differently sized receipt only when registrations and tarballs match the catalog-derived set', async () => {
  const selected = [
    '@jinn-network/fixture-protocol',
    '@jinn-network/fixture-application',
    '@jinn-network/fixture-core-01',
  ];
  const fixture = publicationFixture({ platformPackageNames: selected });
  const fake = registryExec(fixture);
  try {
    const receipt = await publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec }));
    assert.deepEqual(new Set(receipt.packageOrder), new Set(selected));
    assert.equal(receipt.trustedPublishers.registrationCount, selected.length);
    assert.equal(receipt.observedRegistry.length, selected.length);
  } finally {
    cleanup(fixture);
  }
});

test('a fully disabled catalog group reaches no provenance or npm command', async () => {
  const fixture = publicationFixture({
    mutateCatalog: disableReleaseGroup,
    allowIneligibleRegistrationFixture: true,
  });
  const fake = registryExec(fixture);
  try {
    await assert.rejects(
      publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
      /release group platform-v1 is not eligible for canary publication/u,
    );
    assert.deepEqual(fake.calls, []);
  } finally {
    cleanup(fixture);
  }
});

function tarballByName(fixture, path) {
  return fixture.receipt.tarballs.find(({ filename }) => join(fixture.packRoot, filename) === path)?.name;
}

test('an exact-integrity existing catalog publication is an idempotent no-op', async () => {
  const fixture = publicationFixture();
  const fake = registryExec(fixture, { missingByDefault: false });
  try {
    const receipt = await publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec }));
    assert.deepEqual(publishCalls(fake.calls), []);
    assert.equal(receipt.observedRegistry.length, fixture.receipt.packageOrder.length);
    assert.ok(receipt.observedRegistry.every(({ version, distTag }) => (
      version === fixture.packageVersion && distTag === 'canary'
    )));
  } finally {
    cleanup(fixture);
  }
});

test('every non-success or missing verification conclusion blocks npm', async () => {
  for (const conclusion of ['failure', 'skipped', 'neutral', 'cancelled', 'stale', 'in_progress', '<missing>']) {
    const fixture = publicationFixture();
    const fake = registryExec(fixture);
    try {
      rewriteReceipt(fixture, (receipt) => {
        if (conclusion === '<missing>') delete receipt.conclusions.fixture;
        else receipt.conclusions.fixture = conclusion;
      });
      await assert.rejects(
        publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
        /verification receipt|gate fixture|missing required gate conclusion fixture/u,
      );
      assert.deepEqual(npmCalls(fake.calls), [], `${conclusion} must block npm`);
    } finally {
      cleanup(fixture);
    }
  }
});

test('every receipt identity, set, order, wave, version, tag, or surface digest mismatch blocks npm', async () => {
  const mutations = [
    ['source', (receipt) => { receipt.sourceSha = 'd'.repeat(40); }],
    ['catalog', (receipt) => { receipt.catalog.sha256 = '0'.repeat(64); }],
    ['release group', (receipt) => { receipt.releaseGroup = 'other-v1'; }],
    ['lane', (receipt) => { receipt.lane = 'stable'; }],
    ['package set', (receipt) => { receipt.packageOrder.pop(); }],
    ['package order', (receipt) => { receipt.packageOrder.reverse(); }],
    ['waves', (receipt) => { receipt.waves.reverse(); }],
    ['version', (receipt) => { receipt.packageVersion = '9.9.9'; }],
    ['tag', (receipt) => { receipt.distTag = 'latest'; }],
    ['tarball path', (receipt) => { receipt.tarballs[0].filename = 'tarballs/other.tgz'; }],
    ['tarball integrity', (receipt) => { receipt.tarballs[0].integrity = 'sha512-AAAA'; }],
    ['public digest', (receipt) => { receipt.surfaces.public.manifestSha256 = '0'.repeat(64); }],
    ['profile digest', (receipt) => { receipt.surfaces.profile.manifestSha256 = '0'.repeat(64); }],
  ];
  for (const [name, mutate] of mutations) {
    const fixture = publicationFixture();
    const fake = registryExec(fixture);
    try {
      rewriteReceipt(fixture, mutate);
      await assert.rejects(
        publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
        /verification receipt/u,
      );
      assert.deepEqual(npmCalls(fake.calls), [], `${name} mismatch must block npm`);
    } finally {
      cleanup(fixture);
    }
  }
});

test('actual tarball, public surface, profile root, or tarball inventory drift blocks npm', async () => {
  const mutations = [
    ['tarball bytes', (fixture) => writeFileSync(join(fixture.packRoot, fixture.receipt.tarballs[0].filename), 'drift')],
    ['public manifest', (fixture) => writeFileSync(fixture.publicManifestPath, '{}\n')],
    ['profile document', (fixture) => writeFileSync(
      join(fixture.profileRoot, fixture.receipt.surfaces.profile.documents[0].path),
      '{}\n',
    )],
    ['extra tarball', (fixture) => writeFileSync(join(fixture.packRoot, 'tarballs/extra.tgz'), 'extra')],
  ];
  for (const [name, mutate] of mutations) {
    const fixture = publicationFixture();
    const fake = registryExec(fixture);
    try {
      mutate(fixture);
      await assert.rejects(
        publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
        /manifest|integrity|profile root|tarball inventory/u,
      );
      assert.deepEqual(npmCalls(fake.calls), [], `${name} drift must block npm`);
    } finally {
      cleanup(fixture);
    }
  }
});

test('a non-canonical npm destination or repository identity blocks every external command', async () => {
  for (const overrides of [
    { registry: 'https://registry.example.test/' },
    { repository: 'not-a-repository' },
    { repository: 'Other/mono' },
  ]) {
    const fixture = publicationFixture();
    const fake = registryExec(fixture);
    try {
      await assert.rejects(
        publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec, ...overrides })),
        /registry|repository/u,
      );
      assert.deepEqual(fake.calls, []);
    } finally {
      cleanup(fixture);
    }
  }
});

test('trusted-publisher registration drift or absence blocks npm', async () => {
  const mutations = [
    (fixture) => rmSync(fixture.trustedPublishersJsonPath),
    (fixture) => {
      const registrations = JSON.parse(readFileSync(fixture.trustedPublishersJsonPath, 'utf8'));
      registrations.pop();
      writeFileSync(fixture.trustedPublishersJsonPath, `${JSON.stringify(registrations, null, 2)}\n`);
    },
    (fixture) => {
      const registrations = JSON.parse(readFileSync(fixture.trustedPublishersJsonPath, 'utf8'));
      registrations[0].repository = 'other';
      writeFileSync(fixture.trustedPublishersJsonPath, `${JSON.stringify(registrations, null, 2)}\n`);
    },
    (fixture) => {
      const registrations = JSON.parse(readFileSync(fixture.trustedPublishersJsonPath, 'utf8'));
      registrations[0].environment = '';
      writeFileSync(fixture.trustedPublishersJsonPath, `${JSON.stringify(registrations, null, 2)}\n`);
    },
    (fixture) => {
      const registrations = JSON.parse(readFileSync(fixture.trustedPublishersJsonPath, 'utf8'));
      delete registrations[0].allowedActions;
      writeFileSync(fixture.trustedPublishersJsonPath, `${JSON.stringify(registrations, null, 2)}\n`);
    },
    (fixture) => {
      const registrations = JSON.parse(readFileSync(fixture.trustedPublishersJsonPath, 'utf8'));
      registrations[0].allowedActions = ['npm publish', 'npm stage publish'];
      writeFileSync(fixture.trustedPublishersJsonPath, `${JSON.stringify(registrations, null, 2)}\n`);
    },
    (fixture) => writeFileSync(fixture.trustedPublishersMarkdownPath, '# drift\n'),
  ];
  for (const mutate of mutations) {
    const fixture = publicationFixture();
    const fake = registryExec(fixture);
    try {
      mutate(fixture);
      await assert.rejects(
        publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
        /trusted-publisher/u,
      );
      assert.deepEqual(npmCalls(fake.calls), []);
    } finally {
      cleanup(fixture);
    }
  }
});

test('any provenance verification failure blocks npm publication', async () => {
  const fixture = publicationFixture();
  const failedSubject = join(fixture.packRoot, fixture.receipt.tarballs[17].filename);
  const fake = registryExec(fixture, { failAttestationPath: failedSubject });
  try {
    await assert.rejects(
      publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
      /attestation verification failed/u,
    );
    assert.deepEqual(npmCalls(fake.calls), []);
  } finally {
    cleanup(fixture);
  }
});

test('an existing integrity or canary tag mismatch aborts the full-set preflight before any publish', async () => {
  for (const stateMutations of [
    (states, fixture) => states.set(fixture.receipt.packageOrder.at(-1), {
      version: fixture.packageVersion,
      integrity: 'sha512-DIFFERENT',
      tag: fixture.packageVersion,
    }),
    (states, fixture) => states.set(fixture.receipt.packageOrder.at(-1), {
      version: fixture.packageVersion,
      integrity: fixture.receipt.tarballs.at(-1).integrity,
      tag: '0.0.1',
    }),
  ]) {
    const fixture = publicationFixture();
    const fake = registryExec(fixture, {
      existingNames: [fixture.receipt.packageOrder.at(-1)],
      stateMutations,
    });
    try {
      await assert.rejects(
        publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
        /preflight .* mismatch/u,
      );
      assert.deepEqual(publishCalls(fake.calls), []);
    } finally {
      cleanup(fixture);
    }
  }
});

test('malformed or unreachable registry state fails closed before publication', async () => {
  for (const options of [
    { stateMutations: (states, fixture) => states.set(fixture.receipt.packageOrder[0], {
      version: fixture.packageVersion,
      tag: fixture.packageVersion,
    }), existingNames: ['@jinn-network/fixture-core-01'] },
    { unreachableName: '@jinn-network/fixture-core-01', existingNames: ['@jinn-network/fixture-core-01'] },
    { invalidJsonName: '@jinn-network/fixture-core-01', existingNames: ['@jinn-network/fixture-core-01'] },
  ]) {
    const fixture = publicationFixture();
    const fake = registryExec(fixture, options);
    try {
      await assert.rejects(
        publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
        /integrity|registry|invalid JSON/u,
      );
      assert.deepEqual(publishCalls(fake.calls), []);
    } finally {
      cleanup(fixture);
    }
  }
});

test('final registry integrity and canary tag drift prevents the publication receipt', async () => {
  for (const fieldToDrift of ['dist.integrity', 'dist-tags.canary']) {
    const fixture = publicationFixture();
    let observations = 0;
    const fake = registryExec(fixture, {
      viewOverride: ({ field, name, publishedNames }) => {
        if (name.endsWith('application') && publishedNames.has(name) && field === fieldToDrift) {
          observations += 1;
          if (observations === 2) {
            return { status: 0, stdout: '"final-drift"', stderr: '' };
          }
        }
        return undefined;
      },
    });
    try {
      await assert.rejects(
        publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
        /final .* mismatch/u,
      );
      assert.equal(existsSync(fixture.outputPath), false);
    } finally {
      cleanup(fixture);
    }
  }
});

test('a corrupt first post-publish observation stops before the second package', async () => {
  const fixture = publicationFixture();
  const fake = registryExec(fixture, {
    afterPublish: (states, tarball, calls) => {
      if (publishCalls(calls).length === 1) states.get(tarball.name).integrity = 'sha512-CORRUPT';
    },
  });
  try {
    await assert.rejects(
      publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
      /post-publish integrity mismatch/u,
    );
    assert.equal(publishCalls(fake.calls).length, 1);
    assert.equal(existsSync(fixture.outputPath), false);
  } finally {
    cleanup(fixture);
  }
});

test('post-publish version and tag propagation use bounded injected retries', async () => {
  for (const transientField of ['version', 'dist-tags.canary']) {
    const fixture = publicationFixture();
    let returnedTransient = false;
    const sleeps = [];
    const fake = registryExec(fixture, {
      viewOverride: ({ field, name, publishedNames }) => {
        if (!returnedTransient && field === transientField && publishedNames.has(name)) {
          returnedTransient = true;
          return transientField === 'version'
            ? { status: 1, stdout: '', stderr: 'npm error code E404' }
            : { status: 0, stdout: '"0.0.1"', stderr: '' };
        }
        return undefined;
      },
    });
    try {
      const receipt = await publishVerifiedPlatform(publisherArgs(fixture, {
        exec: fake.exec,
        registryRetryAttempts: 2,
        registryRetryDelayMs: 1,
        sleep: (ms) => sleeps.push(ms),
      }));
      assert.equal(receipt.observedRegistry.length, fixture.receipt.packageOrder.length);
      assert.equal(returnedTransient, true);
      assert.deepEqual(sleeps, [1]);
    } finally {
      cleanup(fixture);
    }
  }
});

test('the final publication receipt is immutable and an existing path blocks external access', async () => {
  const fixture = publicationFixture();
  const fake = registryExec(fixture);
  try {
    mkdirSync(join(fixture.root, '.platform-publication'));
    writeFileSync(fixture.outputPath, 'keep-me\n');
    await assert.rejects(
      publishVerifiedPlatform(publisherArgs(fixture, { exec: fake.exec })),
      /refusing to overwrite existing publication receipt/u,
    );
    assert.equal(readFileSync(fixture.outputPath, 'utf8'), 'keep-me\n');
    assert.deepEqual(fake.calls, []);
  } finally {
    cleanup(fixture);
  }
});
