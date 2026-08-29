import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  COLOPHON_PUBLISH_WORKFLOW,
  FIRST_CUT_PLATFORM_PIN_PATH,
  PRODUCT_RELEASE_PLATFORM_PINS_PATH,
  loadFirstCutPlatformPin,
  loadProductReleasePlatformPin,
  transformColophonManifestForPublish,
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
const V21_PIN_SHA = '7a138d2c104d09243e306952d0ce77caa64e4707';
const V21_PIN_VERSION = `0.1.0-canary.sha.${V21_PIN_SHA}`;

function verifyManifest() {
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
  const manifest = verifyManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  assert.equal(pin.decision, 'operator-authorization-2026-08-26');
  assert.equal(pin.product.packageName, '@colophon-claims/verify');
  assert.equal(pin.product.version, '0.2.1');
  assert.equal(pin.platformSourceSha, V21_PIN_SHA);
  assert.equal(pin.platformVersion, V21_PIN_VERSION);
  assert.equal(pin.stackPublishRunUrl, 'https://github.com/Jinn-Network/mono/actions/runs/32976208098');
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

test('the verifier 0.2 exception cannot become an implicit product or version exception', () => {
  const manifest = verifyManifest();
  assert.throws(
    () => loadProductReleasePlatformPin(repoRoot, { ...manifest, version: '0.2.2' }),
    /no immutable platform receipt/u,
  );
  assert.throws(
    () => loadProductReleasePlatformPin(repoRoot, { ...manifest, name: '@colophon-claims/core' }),
    /registered @colophon-claims\/verify 0\.2 patch release/u,
  );
});

test('the one-time receipt rejects hostile coherent rewrites and malformed registry facts', () => {
  const manifest = verifyManifest();
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
    /registered @colophon-claims\/verify 0\.2 patch release|immutable verifier 0\.2\.1/u,
  );
  assert.throws(
    () => validateProductReleasePlatformPin(mutate((copy) => {
      copy.platformPackages[0].integrity = 'sha512-not-a-registry-integrity';
    }), manifest),
    /immutable verifier 0\.2\.1/u,
  );
  assert.throws(
    () => validateProductReleasePlatformPin(mutate((copy) => {
      copy.platformPackages.reverse();
    }), manifest),
    /sorted verifier 0\.2 closure/u,
  );
  assert.throws(
    () => validateProductReleasePlatformPin(mutate((copy) => {
      copy.platformPackages[0].extra = 'drift';
    }), manifest),
    /package row shape drift/u,
  );
});

test('the receipt collection refuses added or duplicate rows and root-key drift', () => {
  const manifest = verifyManifest();
  const pin = loadProductReleasePlatformPin(repoRoot, manifest);
  const receipts = JSON.parse(readFileSync(join(repoRoot, PRODUCT_RELEASE_PLATFORM_PINS_PATH), 'utf8')).receipts;
  assert.throws(
    () => validateProductReleasePlatformPins({ schemaVersion: 1, receipts: [...receipts, structuredClone(pin)] }, manifest),
    /exact ordered immutable verifier 0\.2 receipts/u,
  );
  assert.throws(
    () => validateProductReleasePlatformPins({ receipts: [pin], schemaVersion: 1 }, manifest),
    /exact ordered immutable verifier 0\.2 receipts/u,
  );
  assert.throws(
    () => validateProductReleasePlatformPins({ schemaVersion: 1, receipts: [...receipts].reverse() }, manifest),
    /exact ordered immutable verifier 0\.2 receipts/u,
  );
  const duplicate = structuredClone(pin);
  duplicate.platformPackages[1] = structuredClone(duplicate.platformPackages[0]);
  assert.throws(
    () => validateProductReleasePlatformPin(duplicate, manifest),
    /sorted verifier 0\.2 closure/u,
  );
});

test('publish transform keeps the Colophon product version and pins every Jinn runtime dep to the 0.2 receipt', () => {
  const pin = loadProductReleasePlatformPin(repoRoot, verifyManifest());
  const patched = transformColophonManifestForPublish(verifyManifest(), pin);
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
  const pin = loadProductReleasePlatformPin(repoRoot, verifyManifest());
  const patched = transformColophonManifestForPublish(verifyManifest(), pin);
  const serialized = JSON.stringify(patched);
  assert.doesNotMatch(serialized, /portal:/u);
  assert.doesNotMatch(serialized, /workspace:/u);
  assert.doesNotMatch(serialized, /"@canary"|: "canary"/u);
  assert.equal(patched.resolutions?.['@noble/hashes'], '2.2.0');
  assert.equal(patched.scripts.prepack, 'npm run build');
});

test('publish transform refuses a floating canary dist-tag in the pin or source deps', () => {
  const pin = loadProductReleasePlatformPin(repoRoot, verifyManifest());
  assert.throws(
    () => transformColophonManifestForPublish(verifyManifest(), { ...pin, platformVersion: 'canary' }),
    /floating canary dist-tag/u,
  );
  const tagged = verifyManifest();
  tagged.dependencies['@jinn-network/trust-core'] = 'canary';
  assert.throws(
    () => transformColophonManifestForPublish(tagged, pin),
    /floating canary dist-tag/u,
  );
});

test('Increment 1 moves only verify onto a demand-gated independent product line', () => {
  const catalog = loadPlatformCatalog(repoRoot);
  const verify = catalog.packages.find((pkg) => pkg.name === '@colophon-claims/verify');
  const core = catalog.packages.find((pkg) => pkg.name === '@colophon-claims/core');
  const cli = catalog.packages.find((pkg) => pkg.name === '@colophon-claims/cli');
  const web = catalog.packages.find((pkg) => pkg.name === '@colophon-claims/web');
  assert.equal(verify.releaseGroup, 'colophon-claims-v1');
  assert.equal(verify.publishPolicy, 'independent');
  assert.equal(core.releaseGroup, 'transitional-or-private');
  assert.equal(core.publishPolicy, 'never');
  assert.equal(cli.publishPolicy, 'never');
  assert.equal(web.publishPolicy, 'never');
  const group = catalog.releaseGroups['colophon-claims-v1'];
  assert.equal(group.expectedPackageCount, 1);
  assert.deepEqual(group.publishPolicies, ['independent']);
  assert.equal(group.stackPublished, false);
  assert.equal(group.canary, false);
  assert.equal(group.stable, false);
  assert.equal(catalog.releaseGroups['transitional-or-private'].expectedPackageCount, 12);
});

test('Colophon trusted publishing is a separate workflow and never joins the stack 73', () => {
  const stack = buildRegistrationList(repoRoot);
  assert.equal(stack.length, 73);
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

test('first-cut public surfaces disclose that spec.jinn.network is not hosted', () => {
  // DR-2026-08-17-c Decision 5 (ratified, unamended — DR-2026-08-22 amends Decision 3 only) names
  // the npm README and the `npx` help among the surfaces that must carry this disclosure, so both
  // halves are guarded. Issue #3022 (AC-1) scopes its removal to default stdout, and `usage()` is
  // stderr on exit 2, so the two obligations do not conflict. The stdout claim is guarded where it
  // belongs, over rendered output rather than source text, at
  // `packages/benchmark-product/verify/test/cli.test.mjs`. `origin-tripwire.mjs` does not cover
  // this; it guards the retired pre-DR-2026-08-04 origin spelling instead.
  const readme = readFileSync(join(repoRoot, 'packages/benchmark-product/verify/README.md'), 'utf8');
  assert.match(readme, /spec\.jinn\.network/u, 'README');
  assert.match(readme, /not hosted/iu, 'README');
  assert.match(readme, /What this does not yet prove/u);

  const cli = readFileSync(join(repoRoot, 'packages/benchmark-product/verify/src/cli.ts'), 'utf8');
  assert.match(cli, /spec\.jinn\.network/u, 'CLI');
  assert.match(cli, /not hosted/iu, 'CLI');
});
