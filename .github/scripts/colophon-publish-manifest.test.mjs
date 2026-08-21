import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  COLOPHON_PUBLISH_WORKFLOW,
  FIRST_CUT_PLATFORM_PIN_PATH,
  loadFirstCutPlatformPin,
  transformColophonManifestForPublish,
} from './colophon-publish-manifest.mjs';
import { loadPlatformCatalog } from './platform-catalog.mjs';
import { buildRegistrationList } from './stack-trusted-publishers.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const PIN_SHA = '1ed36166faf16ea4b96b021ceff0397f83a0a80c';
const PIN_VERSION = `0.1.0-canary.sha.${PIN_SHA}`;

function verifyManifest() {
  return JSON.parse(readFileSync(join(repoRoot, 'packages/benchmark-product/verify/package.json'), 'utf8'));
}

test('the first-cut pin names one exact stack-canary receipt, not a dist-tag', () => {
  const pin = loadFirstCutPlatformPin(repoRoot);
  assert.equal(pin.schemaVersion, 1);
  assert.equal(pin.decision, 'DR-2026-08-17-c');
  assert.equal(pin.sourceSha, PIN_SHA);
  assert.equal(pin.packageVersion, PIN_VERSION);
  assert.equal(pin.distTag, 'canary');
  assert.equal(pin.latestRemains, '0.0.0');
  assert.doesNotMatch(pin.packageVersion, /@canary|^canary$/u);
  assert.equal(FIRST_CUT_PLATFORM_PIN_PATH, 'packages/benchmark-product/first-cut-platform-pin.json');
});

test('publish transform keeps the Colophon product version and pins every Jinn runtime dep', () => {
  const pin = loadFirstCutPlatformPin(repoRoot);
  const patched = transformColophonManifestForPublish(verifyManifest(), pin);
  assert.equal(patched.name, '@colophon-claims/verify');
  assert.equal(patched.version, '0.1.0');
  const jinnDeps = Object.entries(patched.dependencies).filter(([name]) => name.startsWith('@jinn-network/'));
  assert.ok(jinnDeps.length >= 8);
  for (const [name, version] of jinnDeps) {
    assert.equal(version, PIN_VERSION, name);
  }
  assert.equal(patched.dependencies.zod, '4.4.3');
  assert.equal(patched.dependencies['@fontsource-variable/newsreader'], '5.3.0');
});

test('publish transform strips portal and workspace resolutions and rewrites prepack for npm', () => {
  const pin = loadFirstCutPlatformPin(repoRoot);
  const patched = transformColophonManifestForPublish(verifyManifest(), pin);
  const serialized = JSON.stringify(patched);
  assert.doesNotMatch(serialized, /portal:/u);
  assert.doesNotMatch(serialized, /workspace:/u);
  assert.doesNotMatch(serialized, /"@canary"|: "canary"/u);
  assert.equal(patched.resolutions?.['@noble/hashes'], '2.2.0');
  assert.equal(patched.scripts.prepack, 'npm run build');
});

test('publish transform refuses a floating canary dist-tag in the pin or source deps', () => {
  const pin = loadFirstCutPlatformPin(repoRoot);
  assert.throws(
    () => transformColophonManifestForPublish(verifyManifest(), { ...pin, packageVersion: 'canary' }),
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
  assert.equal(catalog.releaseGroups['transitional-or-private'].expectedPackageCount, 13);
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
  const readme = readFileSync(join(repoRoot, 'packages/benchmark-product/verify/README.md'), 'utf8');
  const cli = readFileSync(join(repoRoot, 'packages/benchmark-product/verify/src/cli.ts'), 'utf8');
  for (const [label, text] of [['README', readme], ['CLI', cli]]) {
    assert.match(text, /spec\.jinn\.network/u, label);
    assert.match(text, /not hosted/iu, label);
  }
  assert.match(readme, /What this does not yet prove/u);
});
