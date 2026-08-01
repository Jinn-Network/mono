import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { buildRegistrationList, renderRegistrationMarkdown } from './stack-trusted-publishers.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const script = resolve(import.meta.dirname, 'stack-trusted-publishers.mjs');

test('every platform package gets one registration bound to this repo and workflow', () => {
  const registrations = buildRegistrationList(repoRoot);
  assert.ok(registrations.length >= 45);
  assert.equal(new Set(registrations.map((r) => r.package)).size, registrations.length);
  for (const registration of registrations) {
    assert.equal(registration.provider, 'GitHub Actions');
    assert.equal(registration.organization, 'Jinn-Network');
    assert.equal(registration.repository, 'mono');
    assert.equal(registration.workflow, 'stack-npm-publish.yml');
    assert.equal(registration.environment, '', 'the optional npmjs Environment field must be blank');
    assert.ok(registration.package.startsWith('@jinn-network/'));
  }
});

test('the markdown rendering states the blank-environment rule and one row per package', () => {
  const markdown = renderRegistrationMarkdown(buildRegistrationList(repoRoot));
  assert.match(markdown, /Environment field MUST be blank/);
  assert.match(markdown, /\| `@jinn-network\/evidence-protocol` \| `stack-npm-publish\.yml` \|/);
  assert.doesNotMatch(markdown, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji in produced artifacts');
});

test('the CLI writes both artifact files', () => {
  const out = mkdtempSync(join(tmpdir(), 'jinn-registrations-'));
  try {
    const result = spawnSync(process.execPath, [script, '--out', out, '--root', repoRoot], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(readFileSync(join(out, 'trusted-publishers.json'), 'utf8'));
    assert.ok(json.length >= 45);
    assert.match(readFileSync(join(out, 'trusted-publishers.md'), 'utf8'), /Environment field MUST be blank/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
