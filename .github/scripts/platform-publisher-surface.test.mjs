import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import * as legacyPackModule from './publish-stack-run.mjs';

const source = (name) => readFileSync(join(import.meta.dirname, name), 'utf8');
const legacyCli = source('publish-stack.mjs');
const legacyPack = source('publish-stack-run.mjs');
const bundleBuilder = source('build-prepublication-bundle.mjs');
const verifiedPublisher = source('publish-verified-platform.mjs');
const executableNpmPublish = /exec\(\s*(?:['"]npm['"]|npmCommand)\s*,\s*\[\s*['"]publish['"]/u;

test('the legacy CLI has no dynamic route to a direct publishing module', () => {
  assert.doesNotMatch(legacyCli, /import\(\s*['"]\.\/publish-stack-run\.mjs['"]\s*\)|\brunPublish\b/u);
});

test('the legacy run module exports only the pack helper used by the bundle builder', () => {
  assert.deepEqual(Object.keys(legacyPackModule), ['packWave']);
  assert.match(bundleBuilder, /import\s*\{\s*packWave\s*\}\s*from\s*['"]\.\/publish-stack-run\.mjs['"]/u);
});

test('only the receipt-gated platform publisher contains executable npm publish logic', () => {
  const platformModules = new Map([
    ['publish-stack.mjs', legacyCli],
    ['publish-stack-run.mjs', legacyPack],
    ['build-prepublication-bundle.mjs', bundleBuilder],
    ['publish-verified-platform.mjs', verifiedPublisher],
  ]);
  const publishers = [...platformModules]
    .filter(([, contents]) => executableNpmPublish.test(contents))
    .map(([name]) => name);
  assert.deepEqual(publishers, ['publish-verified-platform.mjs']);
});
