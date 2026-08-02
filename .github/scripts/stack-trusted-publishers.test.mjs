import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { loadCatalogPackages, loadPlatformCatalog } from './platform-catalog.mjs';
import { fixtureRepo } from './platform-catalog-test-fixture.mjs';
import { buildRegistrationList, renderRegistrationMarkdown } from './stack-trusted-publishers.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const script = resolve(import.meta.dirname, 'stack-trusted-publishers.mjs');

test('controlled registrations select exactly the fixture catalog platform-v1 group', () => {
  const root = fixtureRepo();
  try {
    assert.deepEqual(
      buildRegistrationList(root).map((registration) => registration.package),
      loadCatalogPackages(root, { releaseGroup: 'platform-v1' }).map((pkg) => pkg.name).sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every canonical platform-v1 package gets one registration bound to this repo and workflow', () => {
  const registrations = buildRegistrationList(repoRoot);
  const expectedPackages = loadCatalogPackages(repoRoot, { releaseGroup: 'platform-v1' })
    .map((pkg) => pkg.name)
    .sort();
  assert.deepEqual(registrations.map((registration) => registration.package), expectedPackages);
  assert.equal(registrations.length, 50);
  assert.equal(new Set(registrations.map((r) => r.package)).size, registrations.length);
  for (const registration of registrations) {
    assert.equal(registration.provider, 'GitHub Actions');
    assert.equal(registration.organization, 'Jinn-Network');
    assert.equal(registration.repository, 'mono');
    assert.equal(registration.workflow, 'stack-npm-publish.yml');
    assert.equal(registration.environment, 'npm-publish');
    assert.deepEqual(registration.allowedActions, ['npm publish']);
    assert.ok(registration.package.startsWith('@jinn-network/'));
  }
});

test('registrations exclude every experimental, legacy, and product package', () => {
  const registered = new Set(buildRegistrationList(repoRoot).map((registration) => registration.package));
  const excluded = loadPlatformCatalog(repoRoot).packages.filter((pkg) => (
    pkg.releaseGroup === 'experimental-environment-supply'
    || pkg.releaseGroup === 'legacy-product-lines'
    || pkg.classification === 'product'
    || pkg.classification === 'product-support'
  ));
  assert.ok(excluded.length > 0);
  assert.deepEqual(excluded.filter((pkg) => registered.has(pkg.name)).map((pkg) => pkg.name), []);
  assert.equal(registered.has('@jinn-network/record-discovery-facts-environments'), false);
});

test('the markdown rendering requires the protected environment and publish-only action', () => {
  const markdown = renderRegistrationMarkdown(buildRegistrationList(repoRoot));
  assert.match(markdown, /Environment field MUST equal `npm-publish`/);
  assert.match(markdown, /Allowed action MUST be exactly `npm publish`/);
  assert.match(markdown, /Stable publication remains disabled.*live `jinn\.network`\s+hosting verification/su);
  assert.doesNotMatch(markdown, /Leave blank|MUST be blank/u);
  assert.doesNotMatch(markdown, /stable from `npm-stable-publish`/u);
  assert.match(markdown, /\| `@jinn-network\/evidence-protocol` \| `stack-npm-publish\.yml` \|/);
  assert.doesNotMatch(markdown, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji in produced artifacts');
});

test('the CLI writes both artifact files', () => {
  const out = mkdtempSync(join(tmpdir(), 'jinn-registrations-'));
  try {
    const result = spawnSync(process.execPath, [script, '--out', out, '--root', repoRoot], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(readFileSync(join(out, 'trusted-publishers.json'), 'utf8'));
    assert.equal(json.length, 50);
    assert.ok(json.every((entry) => entry.environment === 'npm-publish'));
    assert.ok(json.every((entry) => JSON.stringify(entry.allowedActions) === '["npm publish"]'));
    assert.match(
      readFileSync(join(out, 'trusted-publishers.md'), 'utf8'),
      /Environment field MUST equal `npm-publish`/,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
