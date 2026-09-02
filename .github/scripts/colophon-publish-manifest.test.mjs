import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  CLAIM_PIN_SOURCES,
  COLOPHON_PUBLISH_WORKFLOW,
  FIRST_CUT_PLATFORM_PIN_PATH,
  PRODUCT_RELEASE_PLATFORM_PINS_PATH,
  assertClaimPinsMatchPublish,
  collectClaimVerifyPins,
  fetchPublishedVerifyVersions,
  loadFirstCutPlatformPin,
  loadProductReleasePlatformPin,
  registeredVerifyReleases,
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
const V21_PIN_SHA = '0533a224cf99f06d7facf0c23455f2781a5b9e62';
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

test('the shipped README states the pin the selected receipt actually applies', () => {
  const readme = readFileSync(join(repoRoot, 'packages/benchmark-product/verify/README.md'), 'utf8');
  assert.match(readme, new RegExp(V21_PIN_VERSION, 'u'));
  assert.doesNotMatch(readme, /e00b2fc47fc5635b007eb349fb1e41aa81bb3c50/u);
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

test('Colophon trusted publishing is a separate workflow and never joins the stack 75', () => {
  const stack = buildRegistrationList(repoRoot);
  assert.equal(stack.length, 75);
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
  const readme = readFileSync(join(repoRoot, 'packages/benchmark-product/verify/README.md'), 'utf8');
  const cli = readFileSync(join(repoRoot, 'packages/benchmark-product/verify/src/cli.ts'), 'utf8');
  for (const [label, text] of [['README', readme], ['CLI', cli]]) {
    assert.match(text, /spec\.jinn\.network/u, label);
    assert.match(text, /not hosted/iu, label);
  }
  assert.match(readme, /What this does not yet prove/u);
});

test('every claim pin in the tree names a published verifier, and the tree pins the version being published', () => {
  const pins = collectClaimVerifyPins(repoRoot);
  assert.ok(pins.includes('0.2.1'), 'the tree must pin the version this repository publishes');
  assert.deepEqual(assertClaimPinsMatchPublish(pins, verifyManifest().version), pins);
  for (const source of CLAIM_PIN_SOURCES) {
    assert.ok(readFileSync(join(repoRoot, source), 'utf8').includes('@colophon-claims/verify@'), source);
  }
  assert.deepEqual(registeredVerifyReleases(), ['0.1.0', '0.2.0', '0.2.1']);
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

test('the publish workflow runs the claim-pin guard before it applies the manifest', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows', COLOPHON_PUBLISH_WORKFLOW), 'utf8');
  const guard = workflow.indexOf('--check-claim-pins packages/benchmark-product/verify/package.json');
  const apply = workflow.indexOf('--apply packages/benchmark-product/verify/package.json');
  assert.ok(guard > 0, 'the workflow must run the claim-pin guard');
  assert.ok(guard < apply, 'the guard must refuse before the manifest is rewritten for publish');
});

test('the guard reads what npm actually serves, and fails closed when it cannot', async () => {
  const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  assert.deepEqual(
    await fetchPublishedVerifyVersions('@colophon-claims/verify', ok({ versions: { '0.1.0': {}, '0.2.0': {} } })),
    ['0.1.0', '0.2.0'],
  );
  await assert.rejects(
    () => fetchPublishedVerifyVersions('@colophon-claims/verify', async () => ({ ok: false, status: 503 })),
    /cannot read published @colophon-claims\/verify versions from npm: HTTP 503/u,
  );
  await assert.rejects(
    () => fetchPublishedVerifyVersions('@colophon-claims/verify', ok({ versions: {} })),
    /npm reports no published versions/u,
  );
});

/** Every non-test source file under the product packages, so the pin scan cannot silently miss one. */
function productSourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__fixtures__' && entry.name !== 'node_modules') productSourceFiles(path, found);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(path);
    }
  }
  return found;
}

test('CLAIM_PIN_SOURCES names every product source that pins a verifier version', () => {
  const productsRoot = join(repoRoot, 'packages/benchmark-product');
  const pinning = readdirSync(productsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const src = join(productsRoot, entry.name, 'src');
      try {
        return productSourceFiles(src);
      } catch {
        return [];
      }
    })
    .filter((path) => readFileSync(path, 'utf8').includes('@colophon-claims/verify@'))
    .map((path) => path.slice(repoRoot.length + 1))
    .sort();
  assert.deepEqual(pinning, [...CLAIM_PIN_SOURCES].sort());
});
