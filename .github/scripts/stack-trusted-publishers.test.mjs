import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { loadCatalogPackages, loadPlatformCatalog, loadStackPublishedCatalogPackages } from './platform-catalog.mjs';
import {
  disableReleaseGroup,
  fixtureCatalog,
  fixtureRepo,
} from './platform-catalog-test-fixture.mjs';
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

test('catalog-disabled platform groups cannot generate trusted-publisher registrations', () => {
  const root = fixtureRepo({ catalog: disableReleaseGroup(fixtureCatalog()) });
  try {
    assert.throws(
      () => buildRegistrationList(root),
      /no stack-published release group is eligible for canary publication/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every canonical stack-published package gets one registration bound to this repo and workflow', () => {
  const registrations = buildRegistrationList(repoRoot);
  const expectedPackages = loadStackPublishedCatalogPackages(repoRoot)
    .map((pkg) => pkg.name)
    .sort();
  assert.deepEqual(registrations.map((registration) => registration.package), expectedPackages);
  assert.equal(registrations.length, 64);
  assert.equal(registrations.length, expectedPackages.length);
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
    pkg.releaseGroup === 'experimental-policy'
    || pkg.releaseGroup === 'legacy-product-lines'
    || pkg.classification === 'product'
    || pkg.classification === 'product-support'
  ));
  assert.ok(excluded.length > 0);
  assert.deepEqual(excluded.filter((pkg) => registered.has(pkg.name)).map((pkg) => pkg.name), []);
});

test('the markdown rendering requires the protected environment and publish-only action', () => {
  const markdown = renderRegistrationMarkdown(buildRegistrationList(repoRoot));
  assert.match(markdown, /Environment field MUST equal `npm-publish`/);
  assert.match(markdown, /Allowed action MUST be exactly `npm publish`/);
  assert.match(markdown, /Stable publication is gated on `stable-publish-gate`.*live\s+`spec\.jinn\.network` host verification/su);
  assert.doesNotMatch(markdown, /stable blocker/u);
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
    assert.equal(json.length, loadStackPublishedCatalogPackages(repoRoot).length);
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

test('the stack publishing runbook tracks the generated set, CLI registration, and wave truncation', () => {
  const runbook = readFileSync(join(repoRoot, 'docs/runbooks/stack-npm-publishing.md'), 'utf8');
  const sealedCount = loadCatalogPackages(repoRoot, { releaseGroup: 'sealed-platform-v1' }).length;
  const implementationsCount = loadCatalogPackages(repoRoot, {
    releaseGroup: 'implementations-v1',
  }).length;
  const registrations = buildRegistrationList(repoRoot);
  assert.equal(registrations.length, sealedCount + implementationsCount);
  assert.match(
    runbook,
    new RegExp(`sealed-platform-v1\` \\(${sealedCount} packages\\)`),
  );
  assert.match(
    runbook,
    new RegExp(`implementations-v1\` \\(${implementationsCount} packages\\)`),
  );
  assert.match(runbook, new RegExp(`\\*\\*${registrations.length}\\*\\* rows`));
  assert.match(runbook, new RegExp(`${registrations.length} names`));
  assert.ok(registrations.some((row) => row.package === '@jinn-network/evidence-offer'));
  assert.match(runbook, /@jinn-network\/evidence-offer/);
  assert.match(runbook, /2026-09-01/);
  assert.match(runbook, /ritsukai/);
  assert.match(runbook, /npm publish[^\n]*--tag bootstrap/);
  assert.match(runbook, /npm trust github/);
  assert.match(runbook, /--file stack-npm-publish\.yml/);
  assert.match(runbook, /--allow-publish/);
  assert.match(runbook, /ENEEDAUTH/);
  assert.match(runbook, /truncat(?:e|es|ed|ion)/i);

  // The three names still missing npm registration (issue #3521 recurrence): the runbook
  // must name each one and record that `npm view <name> version` returns E404, not just
  // assert a generic "some names are missing" statement.
  for (const unregistered of [
    '@jinn-network/contract-abis',
    '@jinn-network/evidence-gate',
    '@jinn-network/record-discovery-facts-offers',
  ]) {
    const escaped = unregistered.replace(/[/]/gu, '\\/');
    assert.match(runbook, new RegExp(escaped), `runbook must name ${unregistered}`);
  }
  assert.match(runbook, /E404/);
  assert.match(runbook, /\[ \] Regenerate the list and compare it with the generated release view/);

  // The bootstrap placeholder method: an empty temporary directory, not the workspace
  // package directory (which is 0.1.0 with a build step and, for four packages,
  // provenance:true that a local publish cannot satisfy).
  assert.match(runbook, /empty temporary directory/);
  assert.match(runbook, /publishConfig\.provenance: true/);
  assert.match(runbook, /EUSAGE/);
  assert.match(runbook, /"description": "Name reservation for npm trusted-publisher setup\. Not a platform receipt\."/);
  assert.match(runbook, /"publishConfig": \{ "access": "public" \}/);
  assert.match(runbook, /has no `provenance` field/);
  assert.match(runbook, /`latest` stays `0\.0\.0` until the first real publish/);

  // The failure scope: the throw crosses both loops in publishMissingTarballs, so it takes
  // out the rest of the release group's walk (not just the current wave), while the other
  // matrix group keeps publishing.
  assert.match(runbook, /publishMissingTarballs/);
  assert.match(runbook, /rest of\s+the wave and all later waves/);
  assert.match(runbook, /other matrix group[\s\S]{0,80}?is unaffected/);
  assert.match(runbook, /fail-fast: false/);

  // Non-blocking: the rerun advice must name the artifact retention window.
  assert.match(runbook, /platform-verification-artifacts/);
  assert.match(runbook, /retention-days: 1/);
  assert.match(runbook, /next push to `next` is the retry/);
});
