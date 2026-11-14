import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  CLAIM_PIN_SOURCES,
  COLOPHON_PUBLISH_WORKFLOW,
  FIRST_CUT_PLATFORM_PIN_PATH,
  PRODUCT_RELEASE_PLATFORM_PINS_PATH,
  READER_INSTRUCTION_DOCS,
  applyColophonPublishManifest,
  assertClaimPinsMatchPublish,
  assertClaimReaderPinsMatchPublish,
  assertPlatformSourceMatchesReceipt,
  assertReaderInstructionPinsResolve,
  assertReceiptRowsServed,
  checkClaimPins,
  checkProductReleaseReceipt,
  collectClaimReaderPins,
  collectPinsFromSource,
  collectReaderInstructionPins,
  fetchPublishedReaderVersions,
  gitChangedFiles,
  loadFirstCutPlatformPin,
  loadProductReleasePlatformPin,
  platformSourceDirectories,
  registeredReaderReleases,
  transformColophonManifestForPublish,
  transformColophonReadmeForPublish,
  validateProductReleasePlatformPin,
  validateProductReleasePlatformPins,
} from './colophon-publish-manifest.mjs';
import { loadPlatformCatalog } from './platform-catalog.mjs';
import { buildRegistrationList } from './stack-trusted-publishers.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const PIN_SHA = '1ed36166faf16ea4b96b021ceff0397f83a0a80c';
const PIN_VERSION = `0.1.0-canary.sha.${PIN_SHA}`;
const PRODUCT_SHA = '2f249073718111afd810127ff7bbbc19b206dc93';
const V2_PIN_SHA = 'e00b2fc47fc5635b007eb349fb1e41aa81bb3c50';
const V2_PIN_VERSION = `0.1.0-canary.sha.${V2_PIN_SHA}`;
const V21_PIN_SHA = '0533a224cf99f06d7facf0c23455f2781a5b9e62';
const V21_PIN_VERSION = `0.1.0-canary.sha.${V21_PIN_SHA}`;
// The platform canary check 0.2.1, core 0.1.0 and cli 0.1.0 release against (issues #4733, #4886).
const CHECK_PIN_SHA = '272455add1170766f064181c105071519a6baf95';
const CHECK_PIN_VERSION = `0.1.0-canary.sha.${CHECK_PIN_SHA}`;
const CHECK_PIN_RUN_URL = 'https://github.com/Jinn-Network/mono/actions/runs/38246145514/attempts/1';
// The platform canary check 0.2.2, core 0.1.1 and cli 0.1.1 release against (issue #5120).
const RELEASE_PIN_SHA = 'f2aa6f30f2c7d7bcfc4c11e1f6b69f3f44c28603';
const RELEASE_PIN_VERSION = `0.1.0-canary.sha.${RELEASE_PIN_SHA}`;
const RELEASE_PIN_RUN_URL = 'https://github.com/Jinn-Network/mono/actions/runs/41639352404/attempts/1';
const RELEASE_DECISION = 'operator-authorization-2026-10-30-issue-5120';
// Issue #4894: identifiers the protocol spec release serves resolve, so the disclosure tells them
// apart from the rest, which are names. The blanket form calls every identifier a name.
const SERVED_AND_NAMED_DISCLOSURE =
  /Protocol identifiers[\s\S]{0,96}?spec\s+release\s+serves\s+resolve\s+to\s+their[\s\S]{0,16}?documents;\s+the\s+rest\s+are\s+names,\s+not\s+addresses/u;
const BLANKET_NAMES_DISCLOSURE = /Protocol identifiers(?: in the installed platform packages)?\s+are\s+names/u;

/** The checker, under the name it publishes as today. */
function checkerManifest() {
  return JSON.parse(readFileSync(join(repoRoot, 'packages/benchmark-product/check/package.json'), 'utf8'));
}

/**
 * The historical `@colophon-claims/verify@0.2.1` publish: the same implementation under the name it
 * shipped under, before it depended on `@jinn-network/verify`. The receipts attest that publish, so
 * it is this shape -- not the alias package -- that a receipt test must present.
 */
function legacyVerifyManifest() {
  const { '@jinn-network/verify': _published, ...dependencies } = checkerManifest().dependencies;
  return { ...checkerManifest(), name: '@colophon-claims/verify', version: '0.2.1', dependencies };
}

/** The passthrough alias package that keeps `@colophon-claims/verify` resolving (issue #4188). */
function aliasManifest() {
  return JSON.parse(readFileSync(join(repoRoot, 'packages/benchmark-product/verify/package.json'), 'utf8'));
}

test('the first-cut pin names one exact stack-canary receipt, not a dist-tag', () => {
  const pin = loadFirstCutPlatformPin(repoRoot);
  assert.equal(pin.schemaVersion, 2);
  assert.equal(pin.decision, 'DR-2026-08-17-c');
  assert.equal(pin.platformSourceSha, PIN_SHA);
  assert.equal(pin.platformVersion, PIN_VERSION);
  assert.equal(pin.platformDistTag, 'canary');
  assert.equal(pin.platformLatestVersion, '0.0.0');
  assert.doesNotMatch(pin.platformVersion, /@canary|^canary$/u);
  assert.deepEqual(pin.productRelease, {
    packageName: '@colophon-claims/verify',
    version: '0.1.0',
    distTag: 'latest',
    sourceSha: PRODUCT_SHA,
    publishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/32504027116',
    registryIntegrity: 'sha512-Wtp6q40AYKTYk0Yqy5mJzpUcooZe9uab3GEF7vbF6delhEBmImAZqX8WjoYBHIcHGbg7FxKzCVldIyn796wORA==',
    provenanceUrl: 'https://registry.npmjs.org/-/npm/v1/attestations/@colophon-claims%2fverify@0.1.0',
  });
  assert.equal(FIRST_CUT_PLATFORM_PIN_PATH, 'packages/benchmark-product/first-cut-platform-pin.json');
});

test('the verifier 0.2 patch release selects its attested parser-capable closure without changing the historical receipt', () => {
  const manifest = legacyVerifyManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  assert.equal(pin.decision, 'operator-authorization-2026-08-26');
  assert.equal(pin.product.packageName, '@colophon-claims/verify');
  assert.equal(pin.product.version, '0.2.1');
  assert.equal(pin.platformSourceSha, V21_PIN_SHA);
  assert.equal(pin.platformVersion, V21_PIN_VERSION);
  assert.equal(pin.stackPublishRunUrl, 'https://github.com/Jinn-Network/mono/actions/runs/33517790412/attempts/2');
  assert.equal(PRODUCT_RELEASE_PLATFORM_PINS_PATH, 'packages/benchmark-product/product-release-platform-pins.json');
  assert.equal(pin.platformPackages.length, 15);
  for (const pkg of pin.platformPackages) {
    assert.equal(pkg.version, V21_PIN_VERSION, pkg.name);
    assert.equal(pkg.gitHead, V21_PIN_SHA, pkg.name);
    assert.match(pkg.integrity, /^sha512-/u, pkg.name);
    assert.match(pkg.provenanceUrl, /^https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations\/%40jinn-network%2F/u, pkg.name);
  }
  const historical = loadProductReleasePlatformPin(repoRoot, { ...manifest, version: '0.2.0' });
  assert.equal(historical.decision, 'DR-2026-08-22-a');
  assert.equal(historical.platformSourceSha, V2_PIN_SHA);
  assert.equal(historical.platformVersion, V2_PIN_VERSION);
  assert.equal(loadFirstCutPlatformPin(repoRoot).platformVersion, PIN_VERSION);
});

test('each shipped README states the pin its selected receipt actually applies', () => {
  // The three READMEs ship in the tarballs, so a receipt re-pinned without them would publish a
  // package whose own README names a platform version it was not built against (issue #4886).
  for (const product of ['check', 'core', 'cli']) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, `packages/benchmark-product/${product}/package.json`), 'utf8'));
    const pin = loadProductReleasePlatformPin(repoRoot, manifest);
    const readme = readFileSync(join(repoRoot, `packages/benchmark-product/${product}/README.md`), 'utf8');
    assert.equal(pin.platformVersion, RELEASE_PIN_VERSION, product);
    assert.match(readme, new RegExp(`\`${pin.platformVersion}\` receipt`, 'u'), product);
    assert.doesNotMatch(readme, /e00b2fc47fc5635b007eb349fb1e41aa81bb3c50/u, product);
    assert.doesNotMatch(readme, new RegExp(V21_PIN_SHA, 'u'), product);
  }
});

test('core 0.1.1 and cli 0.1.1 select the same attested stack-canary receipt as the checker they depend on', () => {
  const core = JSON.parse(readFileSync(join(repoRoot, 'packages/benchmark-product/core/package.json'), 'utf8'));
  const cli = JSON.parse(readFileSync(join(repoRoot, 'packages/benchmark-product/cli/package.json'), 'utf8'));
  // core depends on the checker and shares eleven Jinn packages with it. A core pinned to another
  // platform sha would install a second copy of each, so the three receipts move together.
  const checkPin = loadProductReleasePlatformPin(repoRoot, checkerManifest());
  const corePin = loadProductReleasePlatformPin(repoRoot, core);
  assert.equal(corePin.decision, RELEASE_DECISION);
  assert.equal(corePin.product.packageName, '@colophon-claims/core');
  assert.equal(corePin.product.version, '0.1.1');
  assert.equal(corePin.platformSourceSha, RELEASE_PIN_SHA);
  assert.equal(corePin.platformVersion, RELEASE_PIN_VERSION);
  assert.equal(corePin.stackPublishRunUrl, RELEASE_PIN_RUN_URL);
  assert.equal(corePin.platformSourceSha, checkPin.platformSourceSha);
  assert.equal(corePin.platformPackages.length, 27);
  for (const row of checkPin.platformPackages) {
    const shared = corePin.platformPackages.find((pkg) => pkg.name === row.name);
    if (shared !== undefined) assert.deepEqual(shared, row, row.name);
  }
  const patchedCore = transformColophonManifestForPublish(core, corePin);
  const coreJinn = Object.entries(patchedCore.dependencies).filter(([name]) => name.startsWith('@jinn-network/'));
  assert.equal(coreJinn.length, 27);
  for (const [name, version] of coreJinn) {
    assert.equal(version, RELEASE_PIN_VERSION, name);
  }
  const cliPin = loadProductReleasePlatformPin(repoRoot, cli);
  assert.equal(cliPin.decision, RELEASE_DECISION);
  assert.equal(cliPin.product.packageName, '@colophon-claims/cli');
  assert.equal(cliPin.product.version, '0.1.1');
  assert.equal(cliPin.platformSourceSha, RELEASE_PIN_SHA);
  assert.equal(cliPin.stackPublishRunUrl, RELEASE_PIN_RUN_URL);
  assert.equal(cliPin.platformPackages.length, 0);
  const patchedCli = transformColophonManifestForPublish(cli, cliPin);
  assert.equal(patchedCli.dependencies['@colophon-claims/core'], '0.1.1');
  assert.equal(patchedCli.dependencies['@colophon-claims/check'], '0.2.2');
  assert.doesNotMatch(JSON.stringify(patchedCli), /portal:/u);
});

test('the published CLI README names the claimant verbs and documents launch as the service\'s', () => {
  const readme = readFileSync(join(repoRoot, 'packages/benchmark-product/cli/README.md'), 'utf8');
  // The claimant path in the order a brought run needs it (issue #4943): the table used to start
  // at `method`, which cannot run before `init` and `draft create`, and left out `quote`, which
  // `lock` requires. The CLI package's own suite holds this order against core's exported list.
  const claimantPath = ['init', 'draft create', 'method', 'arm add', 'quote', 'lock', 'anchor', 'run import', 'collect', 'report', 'publish'];
  const rows = claimantPath.map((verb) => readme.indexOf(`| \`${verb}\` |`));
  for (const [index, at] of rows.entries()) assert.notEqual(at, -1, claimantPath[index]);
  assert.deepEqual(rows, [...rows].sort((left, right) => left - right));
  for (const verb of ['inspect', 'results', 'status']) {
    assert.match(readme, new RegExp(verb, 'u'), verb);
  }
  assert.doesNotMatch(readme, /`launch`, `resume`, `preview`, `quote`/u);
  assert.match(readme, /launch/u);
  assert.match(readme, /service/u);
  assert.match(readme, new RegExp(RELEASE_PIN_VERSION, 'u'));
  assert.match(readme, SERVED_AND_NAMED_DISCLOSURE);
  assert.doesNotMatch(readme, BLANKET_NAMES_DISCLOSURE);
  assert.match(readme, /What this does not yet prove/u);
  assert.doesNotMatch(readme, /spec\.jinn\.network/u);
});

// The walkthrough is the document a claimant follows from `init` to a checked bundle (issue #4942).
// It ends on the reader's side, so it prints a reader line, and it is reached from the README a
// claimant holds after an install.
test('the claimant walkthrough is a reader instruction, and the published CLI README links it', () => {
  const walkthrough = 'packages/benchmark-product/CLAIMANT-WALKTHROUGH.md';
  assert.ok(READER_INSTRUCTION_DOCS.includes(walkthrough), 'the walkthrough must be scanned for reader lines');
  // Every reader line it prints is the first checker release, the one a public-bundle/10 claim
  // pins, and that line resolves against the checker's own ledger.
  const pins = collectReaderInstructionPins(repoRoot, [walkthrough]);
  assert.deepEqual(pins, { '@colophon-claims/check': ['0.2.1'] });
  assert.deepEqual(assertReaderInstructionPinsResolve(pins), pins);

  // The link is written on the branch ref, the one form the publish step pins to its commit.
  const readme = readFileSync(join(repoRoot, 'packages/benchmark-product/cli/README.md'), 'utf8');
  assert.ok(
    readme.includes(`(https://github.com/Jinn-Network/mono/blob/next/${walkthrough})`),
    'the CLI README must link the walkthrough on the next ref',
  );
  // Both anchor provider values are identifiers under that origin. The walkthrough names them,
  // which is why it is its own document: the README names none (see the test above).
  assert.match(readFileSync(join(repoRoot, walkthrough), 'utf8'), /spec\.jinn\.network\/trust\/anchor-profiles\//u);
  assert.doesNotMatch(readme, /spec\.jinn\.network/u);
  // The README states what a claimant must know before `quote`: the two-arm minimum (issue #4948).
  assert.match(readme, /A draft needs at least two arms\./u);
});

// A README written against the `next` branch is right in the repository and wrong in a tarball: the
// branch moves on, and the README a reader installed keeps pointing at whatever the documents have
// become since. The `--apply` step already stamps the publishing commit into the manifest as
// `gitHead`, so it pins the README's repository links to that same commit (issue #4954).
const PUBLISH_HEAD = '4954c0ffee4954c0ffee4954c0ffee4954c0ffee';
const SHIPPED_README_PRODUCTS = ['check', 'core', 'cli'];

/** A throwaway copy of one product's manifest and README: everything `--apply` reads or writes there. */
function stagedProduct(product) {
  const dir = mkdtempSync(join(tmpdir(), `colophon-publish-readme-${product}-`));
  for (const file of ['package.json', 'README.md']) {
    copyFileSync(join(repoRoot, 'packages/benchmark-product', product, file), join(dir, file));
  }
  return dir;
}

function runApply(manifestPath, gitHead) {
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  if (gitHead !== undefined) env.GITHUB_SHA = gitHead;
  return spawnSync(
    process.execPath,
    [join(repoRoot, '.github/scripts/colophon-publish-manifest.mjs'), '--apply', manifestPath],
    { env, encoding: 'utf8' },
  );
}

test('the --apply step pins every repository link in each shipped README to the publishing commit (issue #4954)', () => {
  for (const product of SHIPPED_README_PRODUCTS) {
    const dir = stagedProduct(product);
    try {
      const manifestPath = join(dir, 'package.json');
      const readmePath = join(dir, 'README.md');
      const source = readFileSync(readmePath, 'utf8');
      // The repository is the one the package's own manifest names, so the links a reader follows
      // and the `repository` field npm shows cannot come apart.
      const repository = JSON.parse(readFileSync(manifestPath, 'utf8')).repository.url.replace(/\.git$/u, '');
      assert.equal(repository, 'https://github.com/Jinn-Network/mono', product);
      const onBranch = source.split(`${repository}/blob/next/`).length + source.split(`${repository}/tree/next/`).length - 2;
      assert.ok(onBranch > 0, `${product}: the README links no repository document, so this test would prove nothing`);

      const applied = runApply(manifestPath, PUBLISH_HEAD);
      assert.equal(applied.status, 0, applied.stderr);
      const published = readFileSync(readmePath, 'utf8');
      assert.doesNotMatch(published, /\/(?:blob|tree)\/next\//u, `${product}: a link still names the branch`);
      const onCommit = published.split(`${repository}/blob/${PUBLISH_HEAD}/`).length
        + published.split(`${repository}/tree/${PUBLISH_HEAD}/`).length - 2;
      assert.equal(onCommit, onBranch, `${product}: every link must keep its path at the commit`);
      // Nothing but the ref moved.
      assert.equal(published.replaceAll(`/${PUBLISH_HEAD}/`, '/next/'), source, product);
      // The README names the commit the manifest names.
      assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).gitHead, PUBLISH_HEAD, product);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('--apply with no publishing commit leaves the README on the branch, where its links still resolve', () => {
  const dir = stagedProduct('check');
  try {
    const readmePath = join(dir, 'README.md');
    const source = readFileSync(readmePath, 'utf8');
    for (const gitHead of [undefined, 'next', PUBLISH_HEAD.slice(0, 12)]) {
      copyFileSync(join(repoRoot, 'packages/benchmark-product/check/package.json'), join(dir, 'package.json'));
      const applied = runApply(join(dir, 'package.json'), gitHead);
      assert.equal(applied.status, 0, applied.stderr);
      assert.equal(readFileSync(readmePath, 'utf8'), source, `GITHUB_SHA=${gitHead}`);
      assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).gitHead, undefined, `GITHUB_SHA=${gitHead}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README transform moves only this repository\'s next-branch links', () => {
  const readme = [
    '[guide](https://github.com/Jinn-Network/mono/blob/next/packages/benchmark-product/PUBLIC-BUNDLE.md#formats)',
    '[kit](https://github.com/Jinn-Network/mono/tree/next/packages/benchmark-product/check/fixtures)',
    '<https://github.com/Jinn-Network/mono/blob/next/README.md>',
    // Another repository has its own history: this commit does not exist there.
    '[other](https://github.com/Jinn-Network/example-other-repository/blob/next/README.md)',
    '[prefix](https://github.com/Jinn-Network/mono-example/blob/next/README.md)',
    // Not a branch link, so there is nothing to pin.
    '[package](https://www.npmjs.com/package/@colophon-claims/check)',
    'A directory named blob/next/ in prose, and the word next.',
    '',
  ].join('\n');
  assert.equal(
    transformColophonReadmeForPublish(readme, { gitHead: PUBLISH_HEAD }),
    [
      `[guide](https://github.com/Jinn-Network/mono/blob/${PUBLISH_HEAD}/packages/benchmark-product/PUBLIC-BUNDLE.md#formats)`,
      `[kit](https://github.com/Jinn-Network/mono/tree/${PUBLISH_HEAD}/packages/benchmark-product/check/fixtures)`,
      `<https://github.com/Jinn-Network/mono/blob/${PUBLISH_HEAD}/README.md>`,
      '[other](https://github.com/Jinn-Network/example-other-repository/blob/next/README.md)',
      '[prefix](https://github.com/Jinn-Network/mono-example/blob/next/README.md)',
      '[package](https://www.npmjs.com/package/@colophon-claims/check)',
      'A directory named blob/next/ in prose, and the word next.',
      '',
    ].join('\n'),
  );
  assert.equal(transformColophonReadmeForPublish(readme), readme);
  assert.equal(transformColophonReadmeForPublish(readme, { gitHead: 'next' }), readme);
});

test('restoring an applied publish manifest restores the README beside it', () => {
  const dir = stagedProduct('core');
  try {
    const manifestPath = join(dir, 'package.json');
    const readmePath = join(dir, 'README.md');
    const manifestSource = readFileSync(manifestPath, 'utf8');
    const readmeSource = readFileSync(readmePath, 'utf8');
    const pin = loadProductReleasePlatformPin(repoRoot, JSON.parse(manifestSource));
    const applied = applyColophonPublishManifest(manifestPath, pin, { gitHead: PUBLISH_HEAD });
    assert.notEqual(readFileSync(manifestPath, 'utf8'), manifestSource);
    assert.notEqual(readFileSync(readmePath, 'utf8'), readmeSource);
    applied.restore();
    assert.equal(readFileSync(manifestPath, 'utf8'), manifestSource);
    assert.equal(readFileSync(readmePath, 'utf8'), readmeSource);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the verifier 0.2 exception cannot become an implicit product or version exception', () => {
  const manifest = legacyVerifyManifest();
  assert.throws(
    () => loadProductReleasePlatformPin(repoRoot, { ...manifest, version: '0.2.2' }),
    /no immutable platform receipt/u,
  );
  assert.throws(
    () => loadProductReleasePlatformPin(repoRoot, { ...manifest, name: '@colophon-claims/web', version: '0.1.0' }),
    /no immutable platform receipt/u,
  );
});

test('the one-time receipt rejects hostile coherent rewrites and malformed registry facts', () => {
  const manifest = legacyVerifyManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  const mutate = (apply) => {
    const copy = structuredClone(pin);
    apply(copy);
    return copy;
  };
  assert.throws(
    () => validateProductReleasePlatformPin(mutate((copy) => {
      copy.platformSourceSha = 'a'.repeat(40);
      copy.platformVersion = `0.1.0-canary.sha.${copy.platformSourceSha}`;
      for (const row of copy.platformPackages) {
        row.gitHead = copy.platformSourceSha;
        row.version = copy.platformVersion;
        row.provenanceUrl = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(row.name)}@${copy.platformVersion}`;
      }
    }), manifest),
    /registered product release|immutable @colophon-claims\/verify@0\.2\.1/u,
  );
  assert.throws(
    () => validateProductReleasePlatformPin(mutate((copy) => {
      copy.platformPackages[0].integrity = 'sha512-not-a-registry-integrity';
    }), manifest),
    /immutable @colophon-claims\/verify@0\.2\.1/u,
  );
  assert.throws(
    () => validateProductReleasePlatformPin(mutate((copy) => {
      copy.platformPackages.reverse();
    }), manifest),
    /sorted @colophon-claims\/verify@0\.2\.1 closure/u,
  );
  assert.throws(
    () => validateProductReleasePlatformPin(mutate((copy) => {
      copy.platformPackages[0].extra = 'drift';
    }), manifest),
    /package row shape drift/u,
  );
});

test('the receipt collection refuses added or duplicate rows and root-key drift', () => {
  const manifest = legacyVerifyManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  const receipts = JSON.parse(readFileSync(join(repoRoot, PRODUCT_RELEASE_PLATFORM_PINS_PATH), 'utf8')).receipts;
  assert.throws(
    () => validateProductReleasePlatformPins({ schemaVersion: 1, receipts: [...receipts, structuredClone(pin)] }, manifest),
    /exact ordered immutable product-release receipts/u,
  );
  assert.throws(
    () => validateProductReleasePlatformPins({ receipts: [pin], schemaVersion: 1 }, manifest),
    /exact ordered immutable product-release receipts/u,
  );
  assert.throws(
    () => validateProductReleasePlatformPins({ schemaVersion: 1, receipts: [...receipts].reverse() }, manifest),
    /exact ordered immutable product-release receipts/u,
  );
  const duplicate = structuredClone(pin);
  duplicate.platformPackages[1] = structuredClone(duplicate.platformPackages[0]);
  assert.throws(
    () => validateProductReleasePlatformPin(duplicate, manifest),
    /sorted @colophon-claims\/verify@0\.2\.1 closure/u,
  );
});

test('publish transform keeps the Colophon product version and pins every Jinn runtime dep to the 0.2 receipt', () => {
  const pin = loadProductReleasePlatformPin(repoRoot, legacyVerifyManifest());
  const patched = transformColophonManifestForPublish(legacyVerifyManifest(), pin);
  assert.equal(patched.name, '@colophon-claims/verify');
  assert.equal(patched.version, '0.2.1');
  const jinnDeps = Object.entries(patched.dependencies).filter(([name]) => name.startsWith('@jinn-network/'));
  assert.ok(jinnDeps.length >= 8);
  for (const [name, version] of jinnDeps) {
    assert.equal(version, V21_PIN_VERSION, name);
  }
  assert.equal(patched.dependencies.zod, '4.4.3');
  assert.equal(patched.dependencies['@fontsource-variable/newsreader'], '5.3.0');
});

test('publish transform strips portal and workspace resolutions and rewrites prepack for npm', () => {
  const pin = loadProductReleasePlatformPin(repoRoot, legacyVerifyManifest());
  const patched = transformColophonManifestForPublish(legacyVerifyManifest(), pin);
  const serialized = JSON.stringify(patched);
  assert.doesNotMatch(serialized, /portal:/u);
  assert.doesNotMatch(serialized, /workspace:/u);
  assert.doesNotMatch(serialized, /"@canary"|: "canary"/u);
  assert.equal(patched.resolutions?.['@noble/hashes'], '2.2.0');
  assert.equal(patched.scripts.prepack, 'npm run build');
});

test('publish transform refuses a floating canary dist-tag in the pin or source deps', () => {
  const pin = loadProductReleasePlatformPin(repoRoot, legacyVerifyManifest());
  assert.throws(
    () => transformColophonManifestForPublish(legacyVerifyManifest(), { ...pin, platformVersion: 'canary' }),
    /floating canary dist-tag/u,
  );
  const tagged = legacyVerifyManifest();
  tagged.dependencies['@jinn-network/trust-core'] = 'canary';
  assert.throws(
    () => transformColophonManifestForPublish(tagged, pin),
    /floating canary dist-tag/u,
  );
});

test('Increment 2 moves cli and core onto the demand-gated independent product line; web stays private', () => {
  const catalog = loadPlatformCatalog(repoRoot);
  const check = catalog.packages.find((pkg) => pkg.name === '@colophon-claims/check');
  const verify = catalog.packages.find((pkg) => pkg.name === '@colophon-claims/verify');
  const core = catalog.packages.find((pkg) => pkg.name === '@colophon-claims/core');
  const cli = catalog.packages.find((pkg) => pkg.name === '@colophon-claims/cli');
  const web = catalog.packages.find((pkg) => pkg.name === '@colophon-claims/web');
  assert.equal(check.releaseGroup, 'colophon-claims-v1');
  assert.equal(check.publishPolicy, 'independent');
  // Both published names sit on the same release group and publish independently of each other:
  // the alias is a release, not a build artifact of the checker (issue #4188).
  assert.equal(verify.releaseGroup, 'colophon-claims-v1');
  assert.equal(verify.publishPolicy, 'independent');
  assert.match(verify.role, /alias/u);
  assert.equal(core.releaseGroup, 'colophon-claims-v1');
  assert.equal(core.publishPolicy, 'independent');
  assert.equal(cli.releaseGroup, 'colophon-claims-v1');
  assert.equal(cli.publishPolicy, 'independent');
  assert.equal(web.releaseGroup, 'transitional-or-private');
  assert.equal(web.publishPolicy, 'never');
  const group = catalog.releaseGroups['colophon-claims-v1'];
  assert.equal(group.expectedPackageCount, 4);
  assert.deepEqual(group.publishPolicies, ['independent']);
  assert.equal(group.stackPublished, false);
  assert.equal(group.canary, false);
  assert.equal(group.stable, false);
  assert.equal(catalog.releaseGroups['transitional-or-private'].expectedPackageCount, 10);
});

test('the checker 0.2.2 selects its own receipt at the platform canary it builds against', () => {
  // A receipt attests one stack-canary publish: its run URL, per-package integrity and provenance
  // cannot be fabricated. The checker's receipt is its own row, recorded on operator authorization
  // (issue #5120). It walks to the 15 package names check 0.2.1 recorded, plus `verify`, which the
  // checker now calls at runtime, and the two `verify` brings. The 0.2.1 row is left untouched.
  const manifest = checkerManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  assert.equal(pin.decision, RELEASE_DECISION);
  assert.equal(pin.product.packageName, '@colophon-claims/check');
  assert.equal(pin.product.version, '0.2.2');
  assert.equal(pin.platformSourceSha, RELEASE_PIN_SHA);
  assert.equal(pin.platformVersion, RELEASE_PIN_VERSION);
  assert.equal(pin.stackPublishRunUrl, RELEASE_PIN_RUN_URL);
  assert.equal(pin.platformPackages.length, 18);
  const previous = loadProductReleasePlatformPin(repoRoot, { ...legacyVerifyManifest(), name: '@colophon-claims/check' });
  assert.equal(previous.decision, 'operator-authorization-2026-09-23-issue-4733');
  assert.equal(previous.platformSourceSha, CHECK_PIN_SHA);
  assert.equal(previous.platformVersion, CHECK_PIN_VERSION);
  assert.equal(previous.stackPublishRunUrl, CHECK_PIN_RUN_URL);
  assert.equal(previous.platformPackages.length, 15);
  const legacy = loadProductReleasePlatformPin(repoRoot, legacyVerifyManifest());
  assert.equal(legacy.decision, 'operator-authorization-2026-08-26');
  assert.equal(legacy.platformSourceSha, V21_PIN_SHA);
  assert.deepEqual(
    previous.platformPackages.map((pkg) => pkg.name),
    legacy.platformPackages.map((pkg) => pkg.name),
  );
  assert.deepEqual(
    pin.platformPackages.map((pkg) => pkg.name),
    [
      ...previous.platformPackages.map((pkg) => pkg.name),
      '@jinn-network/evidence-offer',
      '@jinn-network/record-discovery-protocol',
      '@jinn-network/verify',
    ].sort(),
  );
  for (const pkg of pin.platformPackages) {
    assert.equal(pkg.version, RELEASE_PIN_VERSION, pkg.name);
    assert.equal(pkg.gitHead, RELEASE_PIN_SHA, pkg.name);
    assert.match(pkg.integrity, /^sha512-/u, pkg.name);
  }
  const patched = transformColophonManifestForPublish(manifest, pin);
  assert.equal(patched.name, '@colophon-claims/check');
  assert.equal(patched.version, '0.2.2');
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(patched[section])) {
      if (name.startsWith('@jinn-network/')) assert.equal(version, RELEASE_PIN_VERSION, `${section}.${name}`);
    }
  }
  assert.doesNotMatch(JSON.stringify(patched), /portal:/u);
});

test('the 0.2.2 release receipts record each package\'s own latest tag rather than assuming 0.0.0 (issue #5120)', () => {
  // The maintainer pointed `@jinn-network/verify`'s npm `latest` at a canary build, so one shared
  // `platformLatestVersion: 0.0.0` would be false. These receipts read each package's `latest` from
  // npm when they were made, and the digest seals what they read.
  const manifest = checkerManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  assert.equal(Object.hasOwn(pin, 'platformLatestVersion'), false);
  const latest = Object.fromEntries(pin.platformPackages.map((pkg) => [pkg.name, pkg.latestVersion]));
  assert.equal(latest['@jinn-network/verify'], '0.1.0-canary.sha.86fb8cca1b8061911cf1b0ff7e2c612d0215cf95');
  for (const [name, version] of Object.entries(latest)) {
    if (name !== '@jinn-network/verify') assert.equal(version, '0.0.0', name);
  }
  for (const product of ['core', 'cli']) {
    const productPin = loadProductReleasePlatformPin(repoRoot, productManifest(product));
    assert.equal(Object.hasOwn(productPin, 'platformLatestVersion'), false, product);
    for (const pkg of productPin.platformPackages) assert.equal(typeof pkg.latestVersion, 'string', pkg.name);
  }

  const floating = structuredClone(pin);
  floating.platformPackages[0].latestVersion = 'canary';
  assert.throws(() => validateProductReleasePlatformPin(floating, manifest), /exact version npm's latest tag served/u);
  const unrecorded = structuredClone(pin);
  delete unrecorded.platformPackages[0].latestVersion;
  assert.throws(() => validateProductReleasePlatformPin(unrecorded, manifest), /row shape drift/u);
  const assumed = { ...structuredClone(pin), platformLatestVersion: '0.0.0' };
  assert.throws(() => validateProductReleasePlatformPin(assumed, manifest), /immutable verifier 0\.2 receipt shape/u);
  const rewritten = structuredClone(pin);
  rewritten.platformPackages.find((pkg) => pkg.name === '@jinn-network/verify').latestVersion = '0.0.0';
  assert.throws(
    () => validateProductReleasePlatformPin(rewritten, manifest),
    /retain the immutable @colophon-claims\/check@0\.2\.2 receipt values/u,
  );

  // An earlier receipt keeps the shape it was sealed in, and still records 0.0.0 for all.
  const previous = loadProductReleasePlatformPin(repoRoot, { ...legacyVerifyManifest(), name: '@colophon-claims/check' });
  assert.equal(previous.platformLatestVersion, '0.0.0');
  const moved = { ...structuredClone(previous), platformLatestVersion: latest['@jinn-network/verify'] };
  assert.throws(
    () => validateProductReleasePlatformPin(moved, { ...legacyVerifyManifest(), name: '@colophon-claims/check' }),
    /must retain its recorded stack-canary receipt/u,
  );
});

test('the alias may not borrow a receipt for a publish run that never happened', () => {
  // The alias declares no Jinn dependency, so the workflow never runs `--apply` on it and it has
  // no receipt to select (issue #4188).
  assert.throws(
    () => loadProductReleasePlatformPin(repoRoot, aliasManifest()),
    /no immutable platform receipt is registered for @colophon-claims\/verify@0\.2\.3/u,
  );
  const receipts = JSON.parse(readFileSync(join(repoRoot, PRODUCT_RELEASE_PLATFORM_PINS_PATH), 'utf8')).receipts;
  assert.deepEqual(
    receipts.map((pin) => `${pin.product.packageName}@${pin.product.version}`),
    [
      '@colophon-claims/verify@0.2.0',
      '@colophon-claims/verify@0.2.1',
      '@colophon-claims/core@0.1.0',
      '@colophon-claims/cli@0.1.0',
      '@colophon-claims/check@0.2.1',
      '@colophon-claims/core@0.1.1',
      '@colophon-claims/cli@0.1.1',
      '@colophon-claims/check@0.2.2',
    ],
    'a receipt names the publish run it attests, so re-keying one onto another name would forge it',
  );
});

test('Colophon trusted publishing is a separate workflow and never joins the stack', () => {
  const stack = buildRegistrationList(repoRoot);
  assert.equal(stack.length, 76);
  assert.equal(stack.some((row) => row.package.startsWith('@colophon-claims/')), false);
  assert.equal(COLOPHON_PUBLISH_WORKFLOW, 'colophon-npm-publish.yml');
  const workflow = readFileSync(join(repoRoot, '.github/workflows', COLOPHON_PUBLISH_WORKFLOW), 'utf8');
  assert.match(workflow, /^name: Colophon npm Publish/mu);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^  push:/mu);
  assert.doesNotMatch(workflow, /secrets\.NODE_AUTH_TOKEN/u);
  assert.match(workflow, /environment: npm-publish/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /unset NODE_AUTH_TOKEN/u);
  assert.match(workflow, /npm publish --access public/u);
  assert.match(workflow, /transformColophonManifestForPublish|colophon-publish-manifest/u);
});

test('first-cut public surfaces disclose origin-free protocol identifiers', () => {
  const readme = readFileSync(join(repoRoot, 'packages/benchmark-product/check/README.md'), 'utf8');
  const cli = readFileSync(join(repoRoot, 'packages/benchmark-product/check/src/cli.ts'), 'utf8');
  for (const [label, text] of [['README', readme], ['CLI', cli]]) {
    assert.match(text, SERVED_AND_NAMED_DISCLOSURE, label);
    assert.doesNotMatch(text, BLANKET_NAMES_DISCLOSURE, label);
    assert.match(text, /bytes installed from npm/u, label);
    assert.doesNotMatch(text, /spec\.jinn\.network/u, label);
  }
  assert.match(readme, /What this does not yet prove/u);
});

test('every claim pin in the tree names a published reader, and the tree pins each version being published', () => {
  const pins = collectClaimReaderPins(repoRoot);
  assert.ok(
    pins['@colophon-claims/verify'].includes('0.2.1'),
    'the frozen closures must keep pinning the version published under the retired name',
  );
  assert.deepEqual(pins['@colophon-claims/check'], ['0.2', '0.2.1']);
  assert.deepEqual(
    assertClaimReaderPinsMatchPublish(pins, '@colophon-claims/check', checkerManifest().version),
    pins,
  );
  assert.deepEqual(
    assertClaimReaderPinsMatchPublish(pins, '@colophon-claims/verify', aliasManifest().version),
    pins,
  );
  for (const source of CLAIM_PIN_SOURCES) {
    assert.match(readFileSync(join(repoRoot, source), 'utf8'), /@colophon-claims\/(?:verify|check)@/u, source);
  }
  assert.deepEqual(registeredReaderReleases('@colophon-claims/verify'), ['0.1.0', '0.2.0', '0.2.1', '0.2.2', '0.2.3']);
  assert.deepEqual(registeredReaderReleases('@colophon-claims/check'), ['0.2.1', '0.2.2']);
  assert.throws(() => registeredReaderReleases('@colophon-claims/core'), /no registered release ledger/u);
});

test('publishing one reader name never lets the other name borrow the version going out', () => {
  const pins = { '@colophon-claims/check': ['0.2'], '@colophon-claims/verify': ['0.9.9'] };
  assert.throws(
    () => assertClaimReaderPinsMatchPublish(pins, '@colophon-claims/check', '0.2.1', (name) =>
      (name === '@colophon-claims/check' ? ['0.2.1'] : ['0.1.0', '0.2.1'])),
    /claim pins name unpublished @colophon-claims\/verify@0\.9\.9; publishing @colophon-claims\/check@0\.2\.1 does not publish them/u,
  );
  assert.throws(
    () => assertClaimReaderPinsMatchPublish(
      { '@colophon-claims/verify': ['0.2'] },
      '@colophon-claims/check',
      '0.2.1',
      () => ['0.2.1'],
    ),
    /no claim pin names 0\.2\.1/u,
    'a reader nothing in the tree asks for is still refused when the other name asks for its line',
  );
});

test('the publish guard refuses both orderings that seal an unrunnable command into a bundle', () => {
  assert.throws(
    () => assertClaimPinsMatchPublish(['0.1.0', '0.1', '0.2', '0.2.0', '0.2.1'], '0.2.0', ['0.1.0']),
    /claim pins name unpublished verifier 0\.2\.1; publish those before 0\.2\.0/u,
  );
  assert.throws(
    () => assertClaimPinsMatchPublish(['0.1.0', '0.1'], '0.2.1', ['0.1.0']),
    /no claim pin names 0\.2\.1/u,
  );
  assert.throws(
    () => assertClaimPinsMatchPublish(['0.2.1', '0.3'], '0.2.1', ['0.1.0']),
    /claim compatible lines @0\.3 resolve to no published verifier/u,
  );
  assert.deepEqual(
    assertClaimPinsMatchPublish(['0.1.0', '0.1', '0.2', '0.2.0', '0.2.1'], '0.2.1', ['0.1.0', '0.2.0']),
    ['0.1.0', '0.1', '0.2', '0.2.0', '0.2.1'],
  );
});

test('the publish workflow guards each package, and releases the alias only after the checker', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows', COLOPHON_PUBLISH_WORKFLOW), 'utf8');
  const guard = workflow.indexOf('--check-claim-pins packages/benchmark-product/check/package.json');
  const apply = workflow.indexOf('--apply packages/benchmark-product/check/package.json');
  assert.ok(guard > 0, 'the workflow must run the claim-pin guard');
  assert.ok(guard < apply, 'the guard must refuse before the manifest is rewritten for publish');
  const aliasGuard = workflow.indexOf('--check-claim-pins packages/benchmark-product/verify/package.json');
  const checkerPublish = workflow.indexOf('npm run build');
  const aliasGate = workflow.indexOf('npm view "@colophon-claims/check@${pinned}" version');
  assert.ok(aliasGuard > apply, 'the alias is guarded after the checker manifest is rewritten');
  // npm versions are immutable in both directions. A checker published and then refused its alias
  // leaves `npx @colophon-claims/verify@0.2` on the pre-rename 0.2.1 until another checker version
  // ships, so the alias's own guard refuses before the checker goes out; and an alias released
  // against a checker version that is not there permanently breaks that same command, so the alias
  // publishes only after the checker resolves on npm.
  assert.ok(checkerPublish > 0 && aliasGuard < checkerPublish, 'the alias guard refuses before the checker is published');
  assert.ok(aliasGate > checkerPublish, 'the alias is published after the checker it re-enters');
  assert.match(workflow, /npm view "@colophon-claims\/check@\$\{pinned\}" version/u);
  // The checker step is re-entrant: a version npm already serves is skipped rather than
  // republished, so a run that failed after the checker went out (alias gate, alias publish) can
  // be re-dispatched to finish the pair instead of dying on the immutable version with E403.
  const checkerSkip = workflow.indexOf('npm view "@colophon-claims/check@${version}" version');
  assert.ok(checkerSkip > checkerPublish && checkerSkip < aliasGate, 'the checker publish is gated on its own version being absent from npm');
  assert.match(workflow, /if npm view "@colophon-claims\/check@\$\{version\}" version[^\n]*; then\n[^\n]*skipping[^\n]*\n\s+else\n\s+npm publish --access public\n\s+fi/u);
  assert.match(workflow, /options:\n(?:[^\n]*\n)*? {10}- check\n {10}- core\n {10}- cli/u);
});

// `npm publish` returns before the registry serves the version: npm processes a provenance publish
// asynchronously. The SDK lane measured 54 to 310 seconds (#4900) and the stack lane 1 to 10
// minutes with one version at about 29 minutes (#4919), so a single `npm view` straight after the
// checker publish fails a run whose immutable publish has already succeeded. The gate is held to
// the stack lane's 45 minutes as an invariant, not as exact loop strings.
test('the alias gate waits out npm asynchronous publish processing, and still refuses a checker npm never serves (issue #4931)', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows', COLOPHON_PUBLISH_WORKFLOW), 'utf8');
  const stepAt = workflow.indexOf('- name: Require the pinned checker version to resolve before releasing the alias');
  assert.notEqual(stepAt, -1, 'the alias gate step must exist');
  const nextStepAt = workflow.indexOf('- name:', stepAt + 1);
  const step = workflow.slice(stepAt, nextStepAt);
  assert.ok(
    workflow.startsWith('- name: Publish the passthrough alias from the public registry', nextStepAt),
    'the gate is the step directly before the alias publish',
  );

  const queries = Number(step.match(/seq 1 (\d+)/u)?.[1]);
  const sleepSeconds = Number(step.match(/sleep (\d+)/u)?.[1]);
  assert.ok(queries > 0, 'the gate must poll in a bounded `seq 1 N` loop');
  assert.ok(sleepSeconds > 0, 'the gate must sleep between polls');
  const waitSeconds = queries * sleepSeconds;
  assert.ok(
    waitSeconds >= 45 * 60,
    `the gate waits ${queries} x ${sleepSeconds}s = ${waitSeconds}s; npm took about 29 minutes to serve ` +
      'one accepted version, so the budget must be at least 45 minutes',
  );

  // A longer wait is not a weaker gate. The step succeeds early only when npm serves the pinned
  // version, and an exhausted wait fails the run before the alias publish instead of falling through.
  assert.match(step, /if npm view "@colophon-claims\/check@\$\{pinned\}" version[^\n]*; then\n\s+exit 0\n/u);
  assert.equal((step.match(/exit 0/gu) ?? []).length, 1, 'serving the pinned version is the only early success');
  assert.match(step, /::error::[^\n]*@colophon-claims\/check@\$\{pinned\}/u);
  assert.match(step, /\n\s+exit 1\n/u);
  assert.doesNotMatch(step, /\|\| true|continue-on-error/u);

  // The former 30 minute timeout covered install, build and both publishes with no wait at all.
  const timeoutMinutes = Number(workflow.match(/^ {4}timeout-minutes: (\d+)$/mu)?.[1]);
  assert.ok(
    timeoutMinutes * 60 >= waitSeconds + 30 * 60,
    `timeout-minutes is ${timeoutMinutes}; the job must outlast the ${waitSeconds}s wait with 30 minutes ` +
      'left for install, build and both publishes',
  );
});

/** One job's steps, each as its own lines with comments and blank lines dropped. */
function jobSteps(workflowName, job) {
  const workflow = readFileSync(join(repoRoot, '.github/workflows', workflowName), 'utf8');
  const jobAt = workflow.indexOf(`\n  ${job}:\n`);
  assert.notEqual(jobAt, -1, `${workflowName} must declare the ${job} job`);
  const nextJobAt = workflow.slice(jobAt + 1).search(/\n {2}[A-Za-z_][\w-]*:\n/u);
  const body = nextJobAt === -1 ? workflow.slice(jobAt) : workflow.slice(jobAt, jobAt + 1 + nextJobAt);
  return body
    .split(/\n(?= {6}- )/u)
    .slice(1)
    .map((step) => step.split('\n').filter((line) => line.trim() && !line.trimStart().startsWith('#')));
}

function stepNamed(steps, name) {
  const found = steps.filter((step) => step[0] === `      - name: ${name}`);
  assert.equal(found.length, 1, `exactly one step must be named "${name}"`);
  return found[0];
}

/** The commands of a step's `run:`, whether it is a one-line scalar or a block. */
function runLines(step) {
  const at = step.findIndex((line) => /^ {8}run:/u.test(line));
  assert.notEqual(at, -1, `${step[0].trim()} must run something`);
  const inline = step[at].replace(/^ {8}run:\s*/u, '');
  return inline === '|' ? step.slice(at + 1).map((line) => line.trim()) : [inline];
}

// The cli tarball carries the private web application: cli's build script compiles
// packages/benchmark-product/web and copies its standalone output into `dist/local-web`. The web
// package resolves core, the checker and the platform packages through Yarn portals to the
// checkout, so that build needs the whole closure built from source first. Product CI prepares it
// ahead of its own cli step. The publish job did not, and a cli dispatch died in its build on a
// missing node_modules state file. These assertions hold the publish job to product CI's own
// commands instead of a second recipe that could drift from the one CI verifies.
test('the cli dispatch prepares the private web build input the way product CI does, before the cli build (issue #4933)', () => {
  const publish = jobSteps(COLOPHON_PUBLISH_WORKFLOW, 'publish-colophon');
  const product = jobSteps('benchmark-product-ci.yml', 'product');
  const cliOnly = "        if: ${{ github.event.inputs.package == 'cli' }}";
  const installAndBuild = (directory) => `(cd ${directory} && yarn install --immutable && yarn build)`;

  const prepared = [
    'Enable Corepack before the Yarn cache lookup',
    'Set up Node with the Yarn cache for the private web build input',
    'Enable Yarn 4.13.0',
    'Build portal dependencies from source',
    'Build the checker and core from source',
    'Prepare private Colophon web build input',
  ].map((name) => stepNamed(publish, name));
  for (const step of prepared) {
    // Skipped on the check and core dispatches, so those two paths run exactly what they ran before.
    assert.ok(step.includes(cliOnly), `${step[0].trim()} must run for the cli dispatch only`);
    // The manifest the receipt step pins, and the registry install of the pinned core and checker,
    // belong to the cli step. Nothing here may reach into that directory or run npm.
    assert.doesNotMatch(step.join('\n'), /benchmark-product\/cli|\bnpm\b/u, step[0].trim());
  }

  const build = publish.findIndex((step) =>
    step.includes('        working-directory: packages/benchmark-product/${{ github.event.inputs.package }}'));
  assert.notEqual(build, -1, 'the core and cli install, build and publish step must exist');
  assert.deepEqual(runLines(publish[build]), ['unset NODE_AUTH_TOKEN', 'npm install', 'npm run build', 'npm publish --access public']);
  const order = prepared.map((step) => publish.indexOf(step));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the web build input is prepared in product CI order');
  assert.ok(order.at(-1) < build, 'the web build input must be ready before the cli build runs');

  // Corepack and the pinned Yarn: the same commands as product CI.
  for (const name of ['Enable Corepack before the Yarn cache lookup', 'Enable Yarn 4.13.0']) {
    assert.deepEqual(runLines(stepNamed(publish, name)), runLines(stepNamed(product, name)), name);
  }

  // The portal closure: the same directories in the same dependency order, each installed from its
  // lockfile and built. The one test product CI runs inside that block stays in product CI.
  const portalDirectories = runLines(stepNamed(product, 'Build portal dependencies from source')).map((line) => {
    const directory = line.match(/^\(cd (\S+) && yarn install --immutable && (?:.+ && )?yarn build\)$/u)?.[1];
    assert.ok(directory, `product CI portal build line is not an install-and-build: ${line}`);
    return directory;
  });
  assert.ok(portalDirectories.length > 0, 'product CI must build its portal dependencies from source');
  assert.deepEqual(
    runLines(stepNamed(publish, 'Build portal dependencies from source')),
    portalDirectories.map(installAndBuild),
  );

  // Then the checker and core, which web reaches through its portal to core, where product CI
  // builds them: after the portal closure and before the web install.
  const family = ['check', 'core'].map((name) => `packages/benchmark-product/${name}`);
  assert.deepEqual(runLines(stepNamed(publish, 'Build the checker and core from source')), family.map(installAndBuild));
  const productSteps = ['Build portal dependencies from source', 'Verify public bundle checker', 'Verify Colophon core',
    'Prepare private Colophon web build input', 'Verify Colophon CLI'].map((name) => stepNamed(product, name));
  const productOrder = productSteps.map((step) => product.indexOf(step));
  assert.deepEqual(productOrder, [...productOrder].sort((a, b) => a - b), 'product CI prepares the same input in this order');
  assert.ok(productSteps[1].includes(`        working-directory: ${family[0]}`));
  assert.ok(productSteps[2].includes(`        working-directory: ${family[1]}`));

  // Then the web install itself: product CI's step, with only the cli condition added.
  const web = stepNamed(publish, 'Prepare private Colophon web build input');
  assert.deepEqual(web.filter((line) => line !== cliOnly), productSteps[3]);

  // The cached Node setup names the lockfile of every project these steps install, and no other.
  const setup = stepNamed(publish, 'Set up Node with the Yarn cache for the private web build input');
  assert.ok(setup.includes('        uses: actions/setup-node@v7'));
  assert.ok(setup.includes('          cache: yarn'));
  const pathsAt = setup.indexOf('          cache-dependency-path: |');
  assert.notEqual(pathsAt, -1, 'the cached Node setup must declare its lockfiles');
  assert.deepEqual(
    setup.slice(pathsAt + 1).map((line) => line.trim()),
    [...portalDirectories, ...family, 'packages/benchmark-product/web'].map((directory) => `${directory}/yarn.lock`),
  );
});

test('the guard reads what npm actually serves, and fails closed when it cannot', async () => {
  const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  assert.deepEqual(
    await fetchPublishedReaderVersions('@colophon-claims/verify', ok({ versions: { '0.1.0': {}, '0.2.0': {} } })),
    ['0.1.0', '0.2.0'],
  );
  await assert.rejects(
    () => fetchPublishedReaderVersions('@colophon-claims/verify', async () => ({ ok: false, status: 503 })),
    /cannot read published @colophon-claims\/verify versions from npm: HTTP 503/u,
  );
  await assert.rejects(
    () => fetchPublishedReaderVersions('@colophon-claims/verify', ok({ versions: {} })),
    /npm reports no published versions/u,
  );
});

test('a name npm has never served falls back to the offline ledger instead of blocking its own first publish', async () => {
  // A 404 is the registry answering, not failing: it is what a never-published name returns, so
  // refusing there would make the guard block the release it exists to gate, permanently.
  assert.deepEqual(
    await fetchPublishedReaderVersions('@colophon-claims/check', async () => ({ ok: false, status: 404 })),
    ['0.2.1', '0.2.2'],
  );
  await assert.rejects(
    () => fetchPublishedReaderVersions('@colophon-claims/check', async () => ({ ok: false, status: 503 })),
    /cannot read published @colophon-claims\/check versions from npm: HTTP 503/u,
    'every status but 404 still refuses -- a registry that cannot be read is not a registry that is empty',
  );
  await assert.rejects(
    () => fetchPublishedReaderVersions('@colophon-claims/core', async () => ({ ok: false, status: 404 })),
    /no registered release ledger/u,
    'the fallback is the ledger, so a name with no ledger entry has nothing to fall back to',
  );
});

/**
 * Categories deliberately outside both pin lists. Naming them here is the point: the walk below
 * classifies every file in the product tree that mentions a reader specifier, so a pin can only
 * escape both lists by landing in a category someone wrote down (issue #3648).
 */
const PIN_EXEMPT_CATEGORIES = [
  ['lockfile', (path) => path.endsWith('yarn.lock')],
  ['golden bundle fixture', (path) => /(^|\/)(fixtures|__fixtures__)\//u.test(path)],
  ['test file', (path) => /(\.test\.[a-z]+|(^|\/)test\/)/u.test(path)],
];
const WALK_SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.yarn']);
/** The languages `collectPinsFromSource` can tokenize. Anything else must be classified by hand. */
const SCANNABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Every file under the product tree, whatever its extension or depth. */
function productTreeFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!WALK_SKIPPED_DIRS.has(entry.name)) productTreeFiles(path, found);
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/**
 * A file carries a reader specifier under either published name. Keying this walk on the retired
 * name alone would drop a file out of `sealed` the moment its instruction moves to the new one --
 * without a word, because a file that is never read is never unclassified either (issue #4188).
 */
const READER_SPECIFIER = /@colophon-claims\/(?:verify|check)@/u;

// The root README and the public checking guide sit outside the product tree and quote the same
// command, so the guard lists them by name (issue #4888).
test('the reader instructions outside the product tree are guarded too', () => {
  for (const doc of ['README.md', 'apps/website/content/docs/check-a-claim.mdx']) {
    assert.ok(READER_INSTRUCTION_DOCS.includes(doc), `${doc} must be scanned for reader lines`);
    const pins = collectReaderInstructionPins(repoRoot, [doc]);
    assert.ok(Object.keys(pins).length > 0, `${doc} quotes a reader pin`);
    assert.deepEqual(assertReaderInstructionPinsResolve(pins), pins);
  }
});

test('every reader specifier in the product tree is classified, whatever its extension or directory', () => {
  const sealed = [];
  const docs = [];
  const mentionOnly = [];
  const unclassified = [];
  for (const absolute of productTreeFiles(join(repoRoot, 'packages/benchmark-product'))) {
    const path = absolute.slice(repoRoot.length + 1);
    let text;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    if (!READER_SPECIFIER.test(text)) continue;
    if (PIN_EXEMPT_CATEGORIES.some(([, matches]) => matches(path))) continue;
    if (path.endsWith('.md')) docs.push(path);
    else if (!SCANNABLE_EXTENSIONS.some((extension) => path.endsWith(extension))) unclassified.push(path);
    else if (Object.keys(collectPinsFromSource(text)).length > 0) sealed.push(path);
    else mentionOnly.push(path);
  }
  assert.deepEqual(
    unclassified.sort(),
    [],
    'a reader pin in a language the pin scan cannot tokenize needs a decision, not a guess',
  );
  assert.deepEqual(sealed.sort(), [...CLAIM_PIN_SOURCES].sort());
  assert.deepEqual(
    docs.sort(),
    READER_INSTRUCTION_DOCS.filter((path) => path.startsWith('packages/benchmark-product/')).sort(),
  );
  assert.deepEqual(mentionOnly.sort(), [
    'packages/benchmark-product/check/src/assets.ts',
    // The alias shim explains, in a comment, which sealed instructions it exists to keep resolving.
    // It seals nothing itself: it is six files of re-export with no bundle behind them.
    'packages/benchmark-product/verify/index.js',
  ]);
});

/**
 * The exact pin set each claim source seals. Asserting the whole set, not just that the file yields
 * something, is what catches a *partial* drop: a multi-pin file that loses one pin but keeps another
 * stays `sealed` in the exhaustiveness walk above and would otherwise pass unnoticed (issue #3900).
 */
const CLAIM_PIN_SETS = {
  'packages/benchmark-product/core/src/legacy-closures.ts': {
    '@colophon-claims/verify': ['0.1', '0.1.0', '0.2', '0.2.0', '0.2.1'],
  },
  'packages/benchmark-product/check/src/legacy-closures.ts': {
    '@colophon-claims/verify': ['0.1', '0.1.0', '0.2', '0.2.0', '0.2.1'],
  },
  // The composed `/10` claim's lines: the first checker release, which reads the format, and the
  // checker's `@0.2` line, which admits no release before it (issue #4746).
  'packages/benchmark-product/check/src/capabilities.ts': { '@colophon-claims/check': ['0.2', '0.2.1'] },
  // NEXT-STEPS.md is written to the operator's own disk beside the demo output, sealed into no
  // bundle, so it is a fresh instruction and moves.
  'packages/benchmark-product/cli/src/main.ts': { '@colophon-claims/check': ['0.2'] },
};

test('every CLAIM_PIN_SOURCES entry contributes exactly the pins it seals', () => {
  assert.deepEqual(Object.keys(CLAIM_PIN_SETS).sort(), [...CLAIM_PIN_SOURCES].sort());
  for (const source of CLAIM_PIN_SOURCES) {
    assert.deepEqual(
      collectClaimReaderPins(repoRoot, [source]),
      CLAIM_PIN_SETS[source],
      `${source} no longer seals the pins the publish guard expects to see from it`,
    );
  }
});

test('a reader version named only in a comment is not a sealed pin', () => {
  assert.deepEqual(collectPinsFromSource('// pin `@colophon-claims/verify@0.9.9` once 0.9.9 ships\n'), {});
  assert.deepEqual(collectPinsFromSource('/* bump to @colophon-claims/verify@0.9.9 */\n'), {});
  assert.deepEqual(
    collectPinsFromSource('const C = "npx @colophon-claims/verify@0.2.1 <dir>";'),
    { '@colophon-claims/verify': ['0.2.1'] },
  );
  assert.deepEqual(
    collectPinsFromSource('const C = `see https://x/y and run npx @colophon-claims/check@0.2 <dir>`;'),
    { '@colophon-claims/check': ['0.2'] },
  );
  assert.deepEqual(
    collectPinsFromSource('const A = "npx @colophon-claims/verify@0.1 <dir>"; const B = "npx @colophon-claims/check@0.2 <dir>";'),
    { '@colophon-claims/check': ['0.2'], '@colophon-claims/verify': ['0.1'] },
    'a file may seal both names, and each one resolves against its own ledger',
  );
  assert.deepEqual(
    collectClaimReaderPins(repoRoot, ['packages/benchmark-product/check/src/assets.ts']),
    {},
    'assets.ts names a version only in prose, so it seals nothing and is off the pin list',
  );
});

test('the pin scan reaches into a template interpolation, and refuses what it cannot place', () => {
  assert.deepEqual(
    collectPinsFromSource('const a = `x ${y ? `npx @colophon-claims/verify@0.9.9 <dir>` : ""} z`;'),
    { '@colophon-claims/verify': ['0.9.9'] },
    'a nested template is still a sealed string, not code the scan may skip',
  );
  assert.deepEqual(
    collectPinsFromSource('const a = `${{ k: 1 }.k} npx @colophon-claims/verify@0.2.1 <dir>`;'),
    { '@colophon-claims/verify': ['0.2.1'] },
  );
  assert.throws(
    () => collectPinsFromSource('const c = npx @colophon-claims/verify@9.9.9 <dir>;', 'probe.ts'),
    /cannot tell whether @colophon-claims\/verify@9\.9\.9 in probe\.ts is sealed or explained/u,
    'a pin the scan cannot place must fail loudly, never vanish from the publish guard',
  );
});

test('a regex literal cannot swallow the pin on its line, or the pins on the lines after it', () => {
  const sealed = 'npx @colophon-claims/verify@9.9.9 <dir>';
  assert.deepEqual(
    collectPinsFromSource(`const _U = /^https:\\/\\//; export const P = "${sealed}";`, 'probe.ts'),
    { '@colophon-claims/verify': ['9.9.9'] },
    'the escaped slashes in a URL regex are not a line comment, and the pin after them is sealed',
  );
  assert.deepEqual(
    collectPinsFromSource(`const _U = /a\\/*b/;\nexport const P = "${sealed}";`, 'probe.ts'),
    { '@colophon-claims/verify': ['9.9.9'] },
    'an escaped slash-star inside a regex is not a block comment swallowing the rest of the file',
  );
  assert.deepEqual(
    collectPinsFromSource(`const q = /"/; const c = "${sealed}";`, 'probe.ts'),
    { '@colophon-claims/verify': ['9.9.9'] },
    'a regex carrying a quote no longer defeats the scan',
  );
  assert.deepEqual(collectPinsFromSource('const q = /foo/; const n = a / b / c;'), {});
  assert.throws(
    () => collectPinsFromSource(`const q = /${sealed}/;`, 'probe.ts'),
    /cannot tell whether @colophon-claims\/verify@9\.9\.9 in probe\.ts is sealed or explained/u,
    'a specifier inside a regex literal is neither sealed nor prose, so it refuses',
  );
  assert.throws(
    () => collectPinsFromSource(`/* unterminated\nconst c = "${sealed}";`, 'probe.ts'),
    /cannot tell whether @colophon-claims\/verify@9\.9\.9 in probe\.ts is sealed or explained/u,
    'an unterminated block comment refuses its tail rather than calling every pin in it prose',
  );
});

test('a comment naming an unpublished reader does not refuse a publish, but a constant still does', () => {
  const published = ['0.1.0', '0.2.0'];
  const name = '@colophon-claims/verify';
  const commented = 'const C = "npx @colophon-claims/verify@0.2.1 <dir>";\n// bumps to @colophon-claims/verify@0.9.9 next\n';
  assert.deepEqual(
    assertClaimPinsMatchPublish(collectPinsFromSource(commented)[name], '0.2.1', published),
    ['0.2.1'],
  );
  const sealed = 'const C = "npx @colophon-claims/verify@0.2.1 <dir>";\nconst D = "npx @colophon-claims/verify@0.9.9 <dir>";\n';
  assert.throws(
    () => assertClaimPinsMatchPublish(collectPinsFromSource(sealed)[name], '0.2.1', published),
    /claim pins name unpublished verifier 0\.9\.9/u,
  );
});

test('a sealed bare-major line is a pin the guard can see, not an invisible one', () => {
  assert.deepEqual(
    collectPinsFromSource('const C = "npx @colophon-claims/verify@1 <dir>";'),
    { '@colophon-claims/verify': ['1'] },
  );
  assert.throws(
    () => assertClaimPinsMatchPublish(['0.2.1', '1'], '0.2.1', ['0.1.0', '0.2.0']),
    /claim compatible lines @1 resolve to no published verifier/u,
  );
});

test('the publish guard admits a patch release a frozen compatible line already asks for', () => {
  const pins = ['0.1.0', '0.1', '0.2', '0.2.0', '0.2.1'];
  assert.deepEqual(
    assertClaimPinsMatchPublish(pins, '0.2.2', ['0.0.0', '0.1.0', '0.2.0', '0.2.1']),
    pins,
    'the frozen @0.2 line exists precisely so a later 0.2.x fix reaches those readers',
  );
  assert.throws(
    () => assertClaimPinsMatchPublish(pins, '0.3.0', ['0.0.0', '0.1.0', '0.2.0', '0.2.1']),
    /no claim pin names 0\.3\.0 and no compatible line admits it/u,
  );
});

test('reader instructions name only reader versions npm serves, under whichever name they print', () => {
  const pins = collectReaderInstructionPins(repoRoot);
  assert.deepEqual(assertReaderInstructionPinsResolve(pins), pins);
  assert.ok(pins['@colophon-claims/check'].length > 0, 'the docs must reach the name being published');
  assert.match(
    readFileSync(join(repoRoot, 'packages/benchmark-product/EXTERNAL-VERIFICATION.md'), 'utf8'),
    /npx @colophon-claims\/check@0\.2 <bundle-dir>/u,
    'the external path is a fresh instruction, not a sealed quotation: @0.2 reads /2 identically '
      + 'and also reads the /6, /7 and /8 bundles this same document tabulates, so it is the only '
      + 'line a cold external verifier can be sent to (#4188)',
  );
  const ledger = () => ['0.1.0', '0.2.0', '0.2.1'];
  assert.throws(
    () => assertReaderInstructionPinsResolve({ '@colophon-claims/verify': ['1'] }, ledger),
    /reader instructions name unpublished @colophon-claims\/verify@1;/u,
  );
  assert.throws(
    () => assertReaderInstructionPinsResolve({ '@colophon-claims/check': ['0.9.9'] }, ledger),
    /reader instructions name unpublished @colophon-claims\/check@0\.9\.9;/u,
  );
  assert.throws(
    () => assertReaderInstructionPinsResolve({ '@colophon-claims/check': ['0.2'] }, () => ['0.1.0']),
    /reader instructions name unpublished @colophon-claims\/check@0\.2;/u,
    'each name resolves against its own ledger, so the checker cannot borrow the alias line',
  );
});

/** A registry stand-in serving exactly `served` (package name -> versions); any other name 404s. */
function registryServing(served) {
  return async (url) => {
    const name = decodeURIComponent(url.slice('https://registry.npmjs.org/'.length));
    if (!Object.hasOwn(served, name)) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ versions: Object.fromEntries(served[name].map((v) => [v, {}])) }) };
  };
}

function productManifest(name) {
  return JSON.parse(readFileSync(join(repoRoot, `packages/benchmark-product/${name}/package.json`), 'utf8'));
}

test('the check dispatch admits the checker version it publishes, and no other unserved checker pin (issue #4746)', async () => {
  // Every /10 claim pins the first checker release, which the same `check` dispatch publishes
  // after its guards run. npm serves only the name's 0.0.0 reservation until then, so the checker's
  // own guard admits exactly the version going out, and the alias guard, which also runs before the
  // checker publish, resolves the checker pins against the ledger naming that version. Neither path
  // is new: this pins that the composed pin passes both without widening either.
  const pins = collectClaimReaderPins(repoRoot);
  assert.deepEqual(pins['@colophon-claims/check'], ['0.2', '0.2.1']);
  assert.deepEqual(await checkClaimPins(repoRoot, checkerManifest(), ['0.0.0', '0.2.1']), pins);
  assert.deepEqual(await checkClaimPins(repoRoot, aliasManifest(), ['0.1.0', '0.2.0', '0.2.1', '0.2.2']), pins);
  assert.throws(
    () => assertClaimReaderPinsMatchPublish(
      { ...pins, '@colophon-claims/check': ['0.2', '0.2.1', '0.2.9'] },
      '@colophon-claims/check',
      '0.2.2',
      (name) => (name === '@colophon-claims/check' ? ['0.0.0', '0.2.1'] : registeredReaderReleases(name)),
    ),
    /claim pins name unpublished verifier 0\.2\.9; publish those before 0\.2\.2/u,
  );
});

test('core and cli refuse until npm serves every reader the tree pins (issue #4746)', async () => {
  // core and cli publish no reader, so no version of theirs satisfies a reader pin, and the offline
  // ledger names a release before npm serves it, so it is not evidence here either. They are
  // dispatched after `check`; a core published first would seal claims whose reader line 404s.
  const beforeCheck = registryServing({
    '@colophon-claims/check': ['0.0.0'],
    '@colophon-claims/verify': ['0.1.0', '0.2.0', '0.2.1'],
  });
  for (const manifest of [productManifest('core'), productManifest('cli')]) {
    await assert.rejects(
      () => checkClaimPins(repoRoot, manifest, undefined, beforeCheck),
      new RegExp(
        `claim pins name @colophon-claims/check@0\\.2, @0\\.2\\.1, which npm does not serve; publish @colophon-claims/check before ${manifest.name}@0\\.1\\.1`,
        'u',
      ),
    );
  }
  await assert.rejects(
    () => checkClaimPins(repoRoot, productManifest('core'), undefined, registryServing({
      '@colophon-claims/verify': ['0.1.0', '0.2.0', '0.2.1', '0.2.2'],
    })),
    /claim pins name @colophon-claims\/check@0\.2, @0\.2\.1, which npm does not serve/u,
    'a 404 is not a first publish here: nothing under a reader name goes out in this dispatch',
  );
  await assert.rejects(
    () => checkClaimPins(repoRoot, productManifest('core'), undefined, async () => ({ ok: false, status: 503 })),
    /cannot read published @colophon-claims\/check versions from npm: HTTP 503/u,
  );
  const afterCheck = registryServing({
    '@colophon-claims/check': ['0.0.0', '0.2.1'],
    '@colophon-claims/verify': ['0.1.0', '0.2.0', '0.2.1', '0.2.2'],
  });
  for (const manifest of [productManifest('core'), productManifest('cli')]) {
    assert.deepEqual(await checkClaimPins(repoRoot, manifest, undefined, afterCheck), collectClaimReaderPins(repoRoot));
  }
});

test('the publish workflow guards core and cli on served reader pins before rewriting or publishing them (issue #4746)', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows', COLOPHON_PUBLISH_WORKFLOW), 'utf8');
  const product = 'packages/benchmark-product/${{ github.event.inputs.package }}/package.json';
  const guard = workflow.indexOf(`--check-claim-pins ${product}`);
  const apply = workflow.indexOf(`--apply ${product}`);
  assert.ok(guard > 0, 'core and cli must run the claim-pin guard');
  assert.ok(guard < apply, 'the guard must refuse before the manifest is rewritten for publish');
  const step = workflow.slice(workflow.lastIndexOf('- name:', guard), guard);
  assert.match(step, /if: \$\{\{ github\.event\.inputs\.package == 'core' \|\| github\.event\.inputs\.package == 'cli' \}\}/u);
});

// The receipt against npm and against the dispatched commit's platform source (issue #5044).
//
// The offline validator compares the receipts file with PRODUCT_RELEASES, two files in the same
// commit. So a row edited together with its digest passes it, and so does a receipt whose canary
// predates the platform source the tree's own products are built and tested against. The
// `--check-receipt` step reads npm for every row and git for the source, before anything is
// rewritten or published.

/** The script's canonical JSON, so a test can recompute the digest PRODUCT_RELEASES holds. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function receiptDigest(receipt) {
  return createHash('sha256').update(canonicalJson(receipt)).digest('hex');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
}

function currentReceipts() {
  return JSON.parse(readFileSync(join(repoRoot, PRODUCT_RELEASE_PLATFORM_PINS_PATH), 'utf8')).receipts;
}

/**
 * What npm serves for each version the receipts record, as `name@version` to version document. On
 * 2026-11-13 the registry served all 117 rows of the eight receipts with exactly these `gitHead` and
 * `integrity` values. `edit` makes it serve something else.
 */
function servedAsRecorded(receipts, edit = () => {}) {
  const documents = new Map();
  for (const receipt of receipts) {
    for (const row of receipt.platformPackages) {
      documents.set(`${row.name}@${row.version}`, {
        name: row.name,
        version: row.version,
        gitHead: row.gitHead,
        dist: { integrity: row.integrity },
      });
    }
  }
  edit(documents);
  return documents;
}

/** A registry stand-in serving the version documents in `documents`; any other version 404s. */
function registryServingVersions(documents) {
  return async (url) => {
    const { origin, pathname } = new URL(url);
    assert.equal(origin, 'https://registry.npmjs.org');
    const at = pathname.lastIndexOf('/');
    const id = `${decodeURIComponent(pathname.slice(1, at))}@${decodeURIComponent(pathname.slice(at + 1))}`;
    const document = documents.get(id);
    return document === undefined
      ? { ok: false, status: 404 }
      : { ok: true, status: 200, json: async () => structuredClone(document) };
  };
}

/** The same stand-in for a spawned script: loaded with `--import`, it replaces `fetch`. */
const REGISTRY_STUB_SOURCE = `import { readFileSync } from 'node:fs';
const served = JSON.parse(readFileSync(process.env.COLOPHON_RECEIPT_TEST_REGISTRY, 'utf8'));
globalThis.fetch = async (url) => {
  const { pathname } = new URL(url);
  const at = pathname.lastIndexOf('/');
  const id = decodeURIComponent(pathname.slice(1, at)) + '@' + decodeURIComponent(pathname.slice(at + 1));
  return Object.hasOwn(served, id)
    ? { ok: true, status: 200, json: async () => served[id] }
    : { ok: false, status: 404 };
};
`;

const noPlatformSourceChange = () => [];
// A row only the checker's 0.2.2 receipt records, so a refusal on it names one receipt.
const VERIFY_ROW = `@jinn-network/verify@${RELEASE_PIN_VERSION}`;
const OTHER_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

/**
 * The `@colophon-claims/check@0.2.1` receipt as it stood before #5030 re-pinned it, on platform
 * canary 1c023eb, whose task-execution-profiles has no `external-verifier` family. Every field but
 * the row integrities follows from the commit; the test below holds it to the digest
 * PRODUCT_RELEASES recorded for it then.
 */
const PRE_5030_CHECK_SHA = '1c023eb4c24201435e665ddae9d297f286a196bc';
const PRE_5030_CHECK_DIGEST = '9560178d3a2bceb5998d8953ef9ab7c41880b928c037be774778149000b5cacc';
const PRE_5030_CHECK_INTEGRITIES = {
  '@jinn-network/benchmarking-aggregate': 'sha512-mh+1RiyWiTiAHY1Hal/0ubrA4zqy/lNxlpA/b7r01g7fq3puXl6JYw62Wx1XoAvp9FfQtvPa4MXc0VYMLVB9RA==',
  '@jinn-network/benchmarking-evidence': 'sha512-0ay6dBdpGbgmJmL9C0UaigN2JNt81iYp1McIwLsrvB19kgRVNnFSIXmZxe4lGF0tXzZtEOdA2No+jRb63BjMoQ==',
  '@jinn-network/benchmarking-interop': 'sha512-TY+Io4dYcseBq6LybEYaa8juIZNWUEpB3aSRfFfXZb7K4FDEs/ppha4QfUXBJUG8XNM62zW8FpWsxSc/IvvH5g==',
  '@jinn-network/benchmarking-local': 'sha512-PMYOKMf119jlEQB7dRh2ryAufc9YS2hA8rid979UN4pIJcsQDCEcqN7w8v9VGr9HeAr9t06qUjxBd8CwH3es0A==',
  '@jinn-network/benchmarking-protocol': 'sha512-vv2BkDNfMcJtbww3COLlUM+x+Ed8E+KSJ2/UVJd+M8EnQcIZ0s7FwbNittgxfRSBNNYMvyn8qQtggoWaHXff5Q==',
  '@jinn-network/benchmarking-records': 'sha512-E9Rc116V993LcETtIuRQtktXWTu0i5DKjodP66wtizuqZpdPtVenN/kpVG3EHHbTE7v/HLlOvXqPWYqP7zTHNQ==',
  '@jinn-network/benchmarking-run': 'sha512-Xo+9dcKzQFuCJWHNTGB5x3gqOcyB1/YedmVpzwcg9pDlsiazVv3lvmFF0rZHRZc/N0qNytWV0QPlwIm1Aqy74g==',
  '@jinn-network/environment-record': 'sha512-+72SXtYQexIWs2hbyeW+kM8GsMfJFy/HhP+IR6XEHNGzQL3iKs5v51Ca/RY7fvFVqnG1eQ3SM4lvLBEjWCncGQ==',
  '@jinn-network/evidence-protocol': 'sha512-S3fH7zBySD+tXl62NhXQbGM/bXY8VmE6NjPK45pZaZrd4QFYU6EhUAHtxlZaEW2d0wWsnqt7aR7txmvYwL0wnQ==',
  '@jinn-network/task-admission': 'sha512-hfT/C1l6ulTeukkAvR8Aj6NVshJhf6jh62Ld5Xd+W6/tCf3pQ73GElxOWgYwoMqN8cfzG7tRiliy+4WrufIaAw==',
  '@jinn-network/task-execution-profiles': 'sha512-md/E54HkYXXcCXawE1zPfSZJWir6v0tHCGhNQuQdQRc/MeacUANsDG7Q8RkWmoEoi0JS8Mmk1vGIUAaz8hztpw==',
  '@jinn-network/task-execution-protocol': 'sha512-XCaHbFRjdXLNYwBJBgl0Cs8833e990Zuj0sZfyFpP9FsNvBcEZMiZ/eicraAa5Y59YeQNdg3ivp/dz9ZcWZqhw==',
  '@jinn-network/trust-core': 'sha512-VDS7QL+ySi+zb/R1exOKIjpsYAoy7zgct5HmdRyHxbeTREJ6g5Yo/VPLxNsvlcZtJ6Rvnw4fYqhmi8COTDtuMw==',
  '@jinn-network/trust-resolve': 'sha512-A/3y6l6sW/mIDlVK0yS0wBuqpvGlxkGlZC+30pu3pzX40EVdLpEsck7KjxFjm6YfEQ5WTrB7nn3YzhDVDvAM/g==',
  '@jinn-network/trust-testing': 'sha512-mhipGBPO28ZgfrN5xy3o0zw4wYosFKnTO4rwk0vUQT7SDACzd/bgeps8LF7S7L2DfiF+1DqTa74A1or+EjMeCA==',
};

function pre5030CheckReceipt() {
  const platformVersion = `0.1.0-canary.sha.${PRE_5030_CHECK_SHA}`;
  return {
    decision: 'operator-authorization-2026-09-23-issue-4733',
    product: { packageName: '@colophon-claims/check', version: '0.2.1' },
    platformSourceSha: PRE_5030_CHECK_SHA,
    platformVersion,
    platformDistTag: 'canary',
    platformLatestVersion: '0.0.0',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/36838465494/attempts/1',
    platformPackages: Object.entries(PRE_5030_CHECK_INTEGRITIES).map(([name, integrity]) => ({
      name,
      version: platformVersion,
      gitHead: PRE_5030_CHECK_SHA,
      integrity,
      provenanceUrl: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${platformVersion}`,
    })),
  };
}

test('the check receipt as it stood before #5030 stops a check dispatch: its canary predates the platform source (issue #5044)', async () => {
  const receipt = pre5030CheckReceipt();
  assert.equal(receiptDigest(receipt), PRE_5030_CHECK_DIGEST, 'the fixture is the receipt PRODUCT_RELEASES accepted before #5030');
  // npm still serves exactly what it records, so no registry read tells this receipt apart.
  await assertReceiptRowsServed([receipt], registryServingVersions(servedAsRecorded([receipt])));

  // The checker as it stood then, before it depended on @jinn-network/verify.
  const manifest = { ...legacyVerifyManifest(), name: '@colophon-claims/check' };
  const sources = platformSourceDirectories(repoRoot, manifest);
  // Part of what `git diff --name-only 1c023eb 272455a -- packages/task-execution/profiles` lists:
  // the family's source, a fixture it ships, and a test, which no published file is built from.
  const differing = [
    'packages/task-execution/profiles/fixtures/evaluation-spec/golden/external-verifier-minimal.json',
    'packages/task-execution/profiles/src/evaluation-spec/family-blocks.test.ts',
    'packages/task-execution/profiles/src/evaluation-spec/schema.ts',
  ];
  const asked = [];
  assert.throws(
    () => assertPlatformSourceMatchesReceipt(receipt, sources, (sha, directories) => {
      asked.push({ sha, directories });
      return differing;
    }),
    (error) => {
      assert.match(error.message, /^the @colophon-claims\/check@0\.2\.1 receipt pins the platform canary built from 1c023eb4c24201435e665ddae9d297f286a196bc, but this commit's platform source differs from that commit in 2 files/u);
      assert.match(error.message, /\n {2}packages\/task-execution\/profiles\/src\/evaluation-spec\/schema\.ts\n/u);
      assert.match(error.message, /\n {2}packages\/task-execution\/profiles\/fixtures\/evaluation-spec\/golden\/external-verifier-minimal\.json\n/u);
      assert.doesNotMatch(error.message, /\.test\.ts/u);
      return true;
    },
  );
  assert.equal(asked.length, 1);
  assert.equal(asked[0].sha, PRE_5030_CHECK_SHA);
  assert.ok(asked[0].directories.includes('packages/task-execution/profiles'));
});

test('a receipt row that differs from what npm serves stops a dispatch of any of the three packages (issue #5044)', async () => {
  const receipts = currentReceipts();
  assert.deepEqual(
    receipts
      .filter((receipt) => receipt.platformPackages.some((row) => `${row.name}@${row.version}` === VERIFY_ROW))
      .map((receipt) => `${receipt.product.packageName}@${receipt.product.version}`),
    ['@colophon-claims/check@0.2.2'],
  );
  const recorded = receipts.at(-1).platformPackages.find((row) => row.name === '@jinn-network/verify');
  const prefix = `the @colophon-claims/check@0\\.2\\.2 receipt row ${escapeRegExp(VERIFY_ROW)} records`;
  for (const product of ['check', 'core', 'cli']) {
    const manifest = productManifest(product);
    const served = registryServingVersions(servedAsRecorded(receipts));
    const pin = await checkProductReleaseReceipt(repoRoot, manifest, { fetchImpl: served, changedFiles: noPlatformSourceChange });
    assert.equal(`${pin.product.packageName}@${pin.product.version}`, `${manifest.name}@${manifest.version}`);
    // Every row of every receipt is read. The cli receipt records no row of its own, and its
    // install still brings in the checker's packages through core.
    await assert.rejects(
      () => checkProductReleaseReceipt(repoRoot, manifest, {
        fetchImpl: registryServingVersions(servedAsRecorded(receipts, (documents) => {
          documents.get(VERIFY_ROW).dist.integrity = OTHER_INTEGRITY;
        })),
        changedFiles: noPlatformSourceChange,
      }),
      new RegExp(`${prefix} integrity ${escapeRegExp(recorded.integrity)}, but npm serves ${escapeRegExp(OTHER_INTEGRITY)} for that version`, 'u'),
      product,
    );
    await assert.rejects(
      () => checkProductReleaseReceipt(repoRoot, manifest, {
        fetchImpl: registryServingVersions(servedAsRecorded(receipts, (documents) => {
          documents.get(VERIFY_ROW).gitHead = 'b'.repeat(40);
        })),
        changedFiles: noPlatformSourceChange,
      }),
      new RegExp(`${prefix} gitHead ${RELEASE_PIN_SHA}, but npm serves ${'b'.repeat(40)} for that version`, 'u'),
      product,
    );
  }
});

test('a dispatch of any of the three packages stops when this commit\'s platform source is not its receipt\'s (issue #5044)', async () => {
  const served = registryServingVersions(servedAsRecorded(currentReceipts()));
  // The one source file #5045 found changed after the canary, before #5049 held it back.
  const changed = 'packages/benchmarking/aggregate/src/paired-majority-delta-method.ts';
  for (const product of ['check', 'core', 'cli']) {
    const manifest = productManifest(product);
    const asked = [];
    await assert.rejects(
      () => checkProductReleaseReceipt(repoRoot, manifest, {
        fetchImpl: served,
        changedFiles: (sha, directories) => {
          asked.push(sha);
          return directories.includes('packages/benchmarking/aggregate') ? [changed] : [];
        },
      }),
      new RegExp(
        `the ${escapeRegExp(`${manifest.name}@${manifest.version}`)} receipt pins the platform canary built from ${RELEASE_PIN_SHA}, but this commit's platform source differs from that commit in 1 file:\\n {2}${escapeRegExp(changed)}\\n`,
        'u',
      ),
      product,
    );
    assert.deepEqual(asked, [RELEASE_PIN_SHA], product);
  }
});

test('the registry check fails closed and names the row when npm does not serve it or cannot be read (issue #5044)', async () => {
  const receipts = currentReceipts();
  await assertReceiptRowsServed(receipts, registryServingVersions(servedAsRecorded(receipts)));
  await assert.rejects(
    () => assertReceiptRowsServed(receipts, registryServingVersions(servedAsRecorded(receipts, (documents) => {
      documents.delete(VERIFY_ROW);
    }))),
    new RegExp(`the @colophon-claims/check@0\\.2\\.2 receipt row ${escapeRegExp(VERIFY_ROW)} names a version npm does not serve`, 'u'),
  );
  await assert.rejects(
    () => assertReceiptRowsServed(receipts, async () => ({ ok: false, status: 503 })),
    /cannot check the @colophon-claims\/verify@0\.2\.0 receipt row @jinn-network\/benchmarking-aggregate@0\.1\.0-canary\.sha\.e00b2fc47fc5635b007eb349fb1e41aa81bb3c50 against npm: HTTP 503/u,
  );
  // A version document that lacks the field does not match it.
  await assert.rejects(
    () => assertReceiptRowsServed(receipts, registryServingVersions(servedAsRecorded(receipts, (documents) => {
      delete documents.get(VERIFY_ROW).dist;
    }))),
    /records integrity sha512-[^,]+, but npm serves none for that version/u,
  );
});

test('a row edited together with its PRODUCT_RELEASES digest passes --apply and is still refused by --check-receipt (issue #5044)', () => {
  const stage = mkdtempSync(join(tmpdir(), 'colophon-receipt-row-'));
  try {
    cpSync(join(repoRoot, '.github/scripts'), join(stage, '.github/scripts'), { recursive: true });
    for (const product of ['check', 'core', 'cli']) {
      mkdirSync(join(stage, 'packages/benchmark-product', product), { recursive: true });
      copyFileSync(
        join(repoRoot, 'packages/benchmark-product', product, 'package.json'),
        join(stage, 'packages/benchmark-product', product, 'package.json'),
      );
    }
    const pins = JSON.parse(readFileSync(join(repoRoot, PRODUCT_RELEASE_PLATFORM_PINS_PATH), 'utf8'));
    const served = servedAsRecorded(pins.receipts);
    const receipt = pins.receipts.find(({ product }) => `${product.packageName}@${product.version}` === '@colophon-claims/check@0.2.2');
    const row = receipt.platformPackages.find(({ name }) => name === '@jinn-network/verify');
    const servedIntegrity = row.integrity;
    const recordedDigest = receiptDigest(receipt);
    row.integrity = OTHER_INTEGRITY;
    writeFileSync(join(stage, PRODUCT_RELEASE_PLATFORM_PINS_PATH), `${JSON.stringify(pins, null, 2)}\n`);
    const scriptPath = join(stage, '.github/scripts/colophon-publish-manifest.mjs');
    const script = readFileSync(scriptPath, 'utf8');
    assert.equal(script.split(`receiptSha256: '${recordedDigest}'`).length, 2, 'PRODUCT_RELEASES holds the checker receipt digest once');
    writeFileSync(scriptPath, script.replace(`receiptSha256: '${recordedDigest}'`, `receiptSha256: '${receiptDigest(receipt)}'`));

    // Both files of the commit were edited, so the offline validator behind --apply accepts them.
    const env = { ...process.env };
    delete env.GITHUB_SHA;
    const applyDir = join(stage, 'apply');
    mkdirSync(applyDir);
    copyFileSync(join(repoRoot, 'packages/benchmark-product/check/package.json'), join(applyDir, 'package.json'));
    const applied = spawnSync(process.execPath, [scriptPath, '--apply', join(applyDir, 'package.json')], { env, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);

    // npm is not in the commit. Each dispatch reads it and stops on the edited row.
    const registryPath = join(stage, 'registry.json');
    writeFileSync(registryPath, JSON.stringify(Object.fromEntries(served)));
    const stubPath = join(stage, 'registry-stub.mjs');
    writeFileSync(stubPath, REGISTRY_STUB_SOURCE);
    for (const product of ['check', 'core', 'cli']) {
      const checked = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(stubPath).href, scriptPath, '--check-receipt', `packages/benchmark-product/${product}/package.json`],
        { env: { ...env, COLOPHON_RECEIPT_TEST_REGISTRY: registryPath }, encoding: 'utf8' },
      );
      assert.equal(checked.status, 1, `${product}: ${checked.stdout}${checked.stderr}`);
      assert.match(
        checked.stderr,
        new RegExp(`the @colophon-claims/check@0\\.2\\.2 receipt row ${escapeRegExp(VERIFY_ROW)} records integrity ${escapeRegExp(OTHER_INTEGRITY)}, but npm serves ${escapeRegExp(servedIntegrity)}`, 'u'),
        product,
      );
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('the platform source check counts every file a package is built or published from, and ignores only its unshipped tests (issue #5044)', () => {
  const manifest = checkerManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  const sources = platformSourceDirectories(repoRoot, manifest);
  const aggregate = 'packages/benchmarking/aggregate';
  const asked = [];
  const compare = (files) => () => assertPlatformSourceMatchesReceipt(pin, sources, (sha, directories) => {
    asked.push({ sha, directories });
    return files;
  });
  assert.doesNotThrow(compare([]));
  assert.deepEqual(asked[0], { sha: RELEASE_PIN_SHA, directories: sources.map(({ directory }) => directory) });
  // Every package in the closure builds with a tsconfig.build.json that excludes src/**/*.test.ts,
  // and none lists `src` or a vitest config in `files`, so these are not shipped (#5045, #5214).
  assert.doesNotThrow(compare([`${aggregate}/src/paired-majority-delta-method.test.ts`, `${aggregate}/vitest.config.ts`]));
  // The source file #5045 found changed after the canary, held back by #5049 and tracked by #5048,
  // and the other files a build or a tarball reads.
  for (const file of [
    `${aggregate}/src/paired-majority-delta-method.ts`,
    `${aggregate}/package.json`,
    `${aggregate}/yarn.lock`,
    `${aggregate}/README.md`,
    `${aggregate}/tsconfig.build.json`,
    'packages/task-execution/profiles/fixtures/evaluation-spec/golden/external-verifier-minimal.json',
  ]) {
    assert.throws(
      compare([`${aggregate}/src/registry.test.ts`, file]),
      (error) => {
        assert.match(error.message, new RegExp(`^the @colophon-claims/check@0\\.2\\.2 receipt pins the platform canary built from ${RELEASE_PIN_SHA}, but this commit's platform source differs from that commit in 1 file`, 'u'));
        assert.match(error.message, new RegExp(`\\n {2}${escapeRegExp(file)}\\n`, 'u'));
        assert.doesNotMatch(error.message, /registry\.test\.ts/u);
        return true;
      },
      file,
    );
  }
  // A comparison that cannot run refuses; it never reads as no difference.
  assert.throws(
    () => assertPlatformSourceMatchesReceipt(pin, sources, () => {
      throw new Error('cannot fetch platform commit');
    }),
    /cannot fetch platform commit/u,
  );
});

test('the platform source check ignores only test files that no files entry of their package ships (issue #5214)', () => {
  const manifest = checkerManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  const sources = platformSourceDirectories(repoRoot, manifest);
  const evidence = 'packages/evidence/protocol';
  const shipped = `${evidence}/fixtures/golden-execution-evidence-v1/execution/inputs/repository/test/slug.test.ts`;
  const compare = (files) => () => assertPlatformSourceMatchesReceipt(pin, sources, () => files);
  assert.ok(sources.some(({ directory }) => directory === evidence), 'evidence-protocol is in the compared closure');
  // `fixtures/` is in that package's `files`, so this test-named file is packed and published.
  assert.throws(compare([shipped]), (error) => {
    assert.ok(error.message.includes(`\n  ${shipped}\n`));
    return true;
  });
  // A test under `src` is covered by no entry, and neither is a config at the package root.
  assert.doesNotThrow(compare([`${evidence}/src/slug.test.ts`, `${evidence}/vitest.config.ts`]));
});

test('self-test: the exemption refuses every test file npm may ship and passes only unshipped ones (issue #5214)', () => {
  const manifest = checkerManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  const check = (files, changed) => () => assertPlatformSourceMatchesReceipt(
    pin,
    [{ name: 'x', directory: 'packages/x', ...(files === undefined ? {} : { files }) }],
    () => changed,
  );
  assert.throws(check(['/fixtures'], ['packages/x/fixtures/a.test.ts']), /fixtures\/a\.test\.ts/u);
  assert.throws(check(['dist/**/*.ts'], ['packages/x/dist/a.test.ts']), /dist\/a\.test\.ts/u);
  assert.throws(check(undefined, ['packages/x/src/a.test.ts']), /src\/a\.test\.ts/u);
  assert.throws(check(['dist/'], ['packages/x/README.test.ts']), /README\.test\.ts/u);
  // Near miss: tests that no entry can reach are not flagged.
  assert.doesNotThrow(check(['dist/', 'fixtures/'], ['packages/x/src/a.test.ts', 'packages/x/vitest.config.ts']));
});

test('the refusal names the real remedies, not a re-pin (issue #5214)', () => {
  const manifest = checkerManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  const sources = platformSourceDirectories(repoRoot, manifest);
  assert.throws(
    () => assertPlatformSourceMatchesReceipt(pin, sources, () => ['packages/benchmarking/aggregate/src/index.ts']),
    (error) => {
      assert.doesNotMatch(error.message, /re-pin/u);
      assert.match(error.message, /If npm already serves \S+, its receipt cannot change: publish a new version with its own receipt, or, for an alias-only publish, retry the dispatch from the commit of the first run\./u);
      assert.match(error.message, /If npm does not serve \S+ yet, record its receipt against a canary built from this commit's platform source\./u);
      return true;
    },
  );
});

test('the platform source compared is every platform package the dispatched package installs (issue #5044)', () => {
  const directories = (product) => platformSourceDirectories(repoRoot, productManifest(product));
  const checkPin = loadProductReleasePlatformPin(repoRoot, checkerManifest());
  const corePin = loadProductReleasePlatformPin(repoRoot, productManifest('core'));
  const check = directories('check');
  // The checker's receipt records its whole install closure.
  assert.deepEqual(check.map(({ name }) => name), checkPin.platformPackages.map(({ name }) => name));
  assert.ok(check.some(({ name, directory }) =>
    name === '@jinn-network/task-execution-profiles' && directory === 'packages/task-execution/profiles'));
  // core's receipt records its direct dependencies. Its install also brings what they bring, and
  // the checker's packages.
  const core = directories('core');
  for (const { name } of [...corePin.platformPackages, ...checkPin.platformPackages]) {
    assert.ok(core.some((source) => source.name === name), name);
  }
  assert.ok(core.length > corePin.platformPackages.length);
  // cli records none and installs core and the checker. Its build also compiles the private web
  // application from this tree's platform source (#5045).
  assert.deepEqual(directories('cli'), core);
  assert.throws(
    () => platformSourceDirectories(repoRoot, {
      name: '@colophon-claims/check',
      version: '0.2.2',
      dependencies: { '@jinn-network/not-in-this-tree': '0.1.0' },
    }),
    /cannot find the source of @jinn-network\/not-in-this-tree in this tree/u,
  );
});

test('the source comparison reads git, fetching the receipt commit a shallow checkout lacks, and fails closed (issue #5044)', () => {
  const root = mkdtempSync(join(tmpdir(), 'colophon-receipt-git-'));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'no-global-config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (repository, files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repository, path, '..'), { recursive: true });
      writeFileSync(join(repository, path), text);
    }
  };
  try {
    const origin = join(root, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '--quiet');
    write(origin, { 'pkg/a/src/index.ts': 'one\n', 'pkg/a/src/index.test.ts': 'one\n', 'pkg/b/index.ts': 'one\n', 'other.txt': 'one\n' });
    git(origin, 'add', '.');
    git(origin, 'commit', '--quiet', '--no-verify', '-m', 'canary');
    const canary = git(origin, 'rev-parse', 'HEAD');
    write(origin, { 'pkg/a/src/index.ts': 'two\n', 'pkg/a/src/index.test.ts': 'two\n', 'other.txt': 'two\n' });
    git(origin, 'commit', '--quiet', '--no-verify', '-am', 'next');
    const clone = join(root, 'clone');
    git(root, 'clone', '--quiet', '--depth=1', pathToFileURL(origin).href, clone);
    assert.notEqual(
      spawnSync('git', ['cat-file', '-e', `${canary}^{commit}`], { cwd: clone, env }).status,
      0,
      'the shallow clone starts without the canary commit',
    );

    assert.deepEqual(gitChangedFiles(clone, canary, ['pkg/a', 'pkg/b']), ['pkg/a/src/index.test.ts', 'pkg/a/src/index.ts']);
    assert.deepEqual(gitChangedFiles(clone, canary, ['pkg/b']), []);
    assert.deepEqual(gitChangedFiles(clone, git(clone, 'rev-parse', 'HEAD'), ['pkg/a']), []);
    assert.throws(
      () => gitChangedFiles(clone, 'c'.repeat(40), ['pkg/a']),
      new RegExp(`cannot fetch platform commit ${'c'.repeat(40)} from origin`, 'u'),
    );
    // A diff git cannot run is a refusal, never an empty list.
    assert.throws(
      () => gitChangedFiles(clone, canary, [':(not-a-magic)pkg/a']),
      new RegExp(`cannot compare platform commit ${canary} with HEAD`, 'u'),
    );
    for (const value of ['--upload-pack=true', canary.slice(0, 12), undefined]) {
      assert.throws(() => gitChangedFiles(clone, value, ['pkg/a']), /must be a 40-character commit sha/u, String(value));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every dispatch checks its receipt against npm and this commit before anything is rewritten or published (issue #5044)', () => {
  const publish = jobSteps(COLOPHON_PUBLISH_WORKFLOW, 'publish-colophon');
  const step = stepNamed(publish, 'Refuse a receipt that npm or this commit\'s platform source contradicts');
  assert.deepEqual(runLines(step), [
    'node .github/scripts/colophon-publish-manifest.mjs --check-receipt packages/benchmark-product/${{ github.event.inputs.package }}/package.json',
  ]);
  assert.ok(!step.some((line) => /^ {8}if:/u.test(line)), 'the step runs for check, core and cli alike');
  const at = publish.indexOf(step);
  const rewritesOrPublishes = publish.filter((other) => /--apply |npm publish/u.test(other.join('\n')));
  assert.equal(rewritesOrPublishes.length, 5, 'two --apply steps and three npm publish steps');
  for (const other of rewritesOrPublishes) {
    assert.ok(publish.indexOf(other) > at, `${other[0].trim()} must come after the receipt check`);
  }
});
