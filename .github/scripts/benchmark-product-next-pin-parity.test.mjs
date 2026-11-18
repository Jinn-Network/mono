// The Colophon CLI serves the web app's standalone build with the `next` its own manifest
// declares: cli/scripts/build.mjs copies the build without node_modules, and cli/src/local-app.ts
// resolves `next` from the installed CLI package root. A one-sided Next.js bump therefore ships a
// build compiled by one version and served by another, which only the packed-consumer check on
// macOS arm64 noticed ("installed packaged workspace did not serve the three-choice home"),
// about an hour into the lane. This fails in the first minute and names both versions.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function pins(pkg) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages', 'benchmark-product', pkg, 'package.json'), 'utf8'));
  const found = new Map();
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (name === 'next' || name === 'eslint-config-next' || name.startsWith('@next/')) {
        found.set(`${name} (${section})`, range);
      }
    }
  }
  return found;
}

const cli = pins('cli');
const web = pins('web');
const declared = (map, name) => [...map].filter(([key]) => key.startsWith(`${name} (`)).map(([, v]) => v);

test('cli and web declare one exact next version', () => {
  const [cliNext, ...extraCli] = declared(cli, 'next');
  const [webNext, ...extraWeb] = declared(web, 'next');
  assert.ok(cliNext && webNext, 'both packages must declare next');
  assert.deepEqual([extraCli, extraWeb], [[], []], 'next must be declared once per package');
  assert.match(cliNext, /^\d+\.\d+\.\d+$/, `cli next must be an exact version, got ${cliNext}`);
  assert.equal(
    cliNext,
    webNext,
    `packages/benchmark-product/cli declares next ${cliNext} but packages/benchmark-product/web declares next ${webNext}. ` +
      'The CLI serves the web standalone build with its own next, so both pins must move together.',
  );
});

test('every other next-family pin in cli and web matches the shared next version', () => {
  const [shared] = declared(web, 'next');
  for (const [label, map] of [['cli', cli], ['web', web]]) {
    for (const [key, range] of map) {
      assert.equal(
        range,
        shared,
        `packages/benchmark-product/${label} pins ${key} at ${range}, but next is ${shared}; the whole Next.js family must move together.`,
      );
    }
  }
});
