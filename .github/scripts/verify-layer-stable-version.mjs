#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const root = resolve(args.get('--root') ?? process.cwd());
const expectedVersion = args.get('--version');
const stableSemver = /^\d+\.\d+\.\d+$/u;

function fail(message) {
  throw new Error(`layer stable release check failed: ${message}`);
}

function readJson(relativePath) {
  const path = resolve(root, relativePath);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${relativePath}: ${error?.message ?? String(error)}`);
  }
}

function requireVersion(manifest, name) {
  if (manifest?.name !== name) {
    fail(`expected package ${name}, got ${manifest?.name ?? '<missing>'}`);
  }
  if (manifest.version !== expectedVersion) {
    fail(
      `${name} version ${manifest.version ?? '<missing>'} does not match ${expectedVersion}`,
    );
  }
}

function requireDependency(manifest, dependency) {
  const actual = manifest?.dependencies?.[dependency];
  if (actual !== expectedVersion) {
    fail(
      `${manifest?.name ?? '<unknown>'} dependency pin ${dependency}@${
        actual ?? '<missing>'
      } does not match ${expectedVersion}`,
    );
  }
}

try {
  if (typeof expectedVersion !== 'string' || !stableSemver.test(expectedVersion)) {
    fail(`--version must be a stable semver, got ${expectedVersion ?? '<missing>'}`);
  }

  const plugin = readJson('packages/plugin/package.json');
  const core = readJson('packages/core/package.json');
  const layer = readJson('packages/layer/package.json');
  const runtime = readJson('plugin/frozen/layer-runtime.json');

  requireVersion(plugin, '@jinn-network/plugin');
  requireVersion(core, '@jinn-network/core');
  requireVersion(layer, '@jinn-network/jinn-layer');
  requireDependency(core, '@jinn-network/plugin');
  requireDependency(layer, '@jinn-network/plugin');
  requireDependency(layer, '@jinn-network/core');

  if (
    runtime?.package !== '@jinn-network/jinn-layer'
    || runtime.version !== expectedVersion
  ) {
    fail(
      `runtime pin ${runtime?.package ?? '<missing>'}@${
        runtime?.version ?? '<missing>'
      } does not match @jinn-network/jinn-layer@${expectedVersion}`,
    );
  }
  if (runtime.bin !== 'runtime/node_modules/.bin/jinn-layer') {
    fail(`runtime bin contract is invalid: ${runtime.bin ?? '<missing>'}`);
  }

  console.log(
    `layer stable release check: coherent ${expectedVersion} package and runtime pins`,
  );
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}
