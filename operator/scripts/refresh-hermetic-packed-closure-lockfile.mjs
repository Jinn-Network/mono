#!/usr/bin/env node
/**
 * Regenerates the committed packed-closure lockfile.
 * This is the only packed-closure path allowed to consult the npm registry
 * for range resolution (`npm install --package-lock-only`). Smoke uses the
 * result via npm ci and never re-resolves.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFixtureLockfilePresent,
  buildConsumerThirdPartyDependencies,
  discoverPackageRoots,
  firstPartyArchiveDependencies,
  fixtureDir,
  fixtureLockfilePath,
  packedClosurePackageNames,
  readPackageJson,
  refreshLockfileArgs,
  requirePackageRoot,
  sanitizedManifest,
  withoutLocalArchiveIntegrity,
  writeConsumerPackageJson,
} from './lib/hermetic-packed-closure.mjs';

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(scriptsRoot, '..');
const repoRoot = resolve(clientRoot, '..');
const packagesRoot = join(repoRoot, 'packages');
const workRoot = mkdtempSync(join(tmpdir(), 'jinn-hermetic-packed-closure-refresh-'));
// Same layout as the smoke, so the lockfile's `file:../archives/...` entries
// resolve identically in both.
const archivesRoot = join(workRoot, 'archives');
const consumerRoot = join(workRoot, 'consumer');
const stagingRoot = join(workRoot, 'staging');

function run(command, args, context, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    const output = [result.error?.message, result.stderr, result.stdout]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .join('\n');
    throw new Error(`${context} failed\n${output}`);
  }
  return result;
}

// The lockfile needs each first-party archive's manifest, not its contents, so
// pack the sanitized manifest the smoke packs, alone.
function packManifest(name, manifest) {
  const stagedRoot = join(stagingRoot, name.replaceAll('/', '__'));
  mkdirSync(stagedRoot, { recursive: true });
  writeFileSync(
    join(stagedRoot, 'package.json'),
    `${JSON.stringify(sanitizedManifest(manifest, name), null, 2)}\n`,
  );
  const output = run(
    'npm',
    ['pack', '--json', '--pack-destination', archivesRoot, '--ignore-scripts'],
    `pack ${name}`,
    { cwd: stagedRoot },
  ).stdout;
  const entries = JSON.parse(output);
  if (entries.length !== 1 || typeof entries[0]?.filename !== 'string') {
    throw new Error(`pack ${name} did not produce exactly one tarball.`);
  }
  return join(archivesRoot, entries[0].filename);
}

try {
  const packageRoots = discoverPackageRoots(packagesRoot);
  const clientManifest = readPackageJson(clientRoot);
  const names = packedClosurePackageNames(clientManifest, packageRoots);
  const closureManifests = names.map((name) => readPackageJson(requirePackageRoot(packageRoots, name)));
  mkdirSync(archivesRoot, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });
  const archives = new Map(names.map((name, index) => [name, packManifest(name, closureManifests[index])]));
  const thirdParty = buildConsumerThirdPartyDependencies({
    operatorManifest: clientManifest,
    closureManifests,
  });
  writeConsumerPackageJson(consumerRoot, {
    dependencies: {
      ...thirdParty.dependencies,
      ...firstPartyArchiveDependencies(consumerRoot, archives),
    },
    devDependencies: thirdParty.devDependencies,
  });
  run('npm', refreshLockfileArgs(), 'refresh packed-closure lockfile', {
    cwd: consumerRoot,
  });
  const lock = JSON.parse(readFileSync(join(consumerRoot, 'package-lock.json'), 'utf8'));
  mkdirSync(fixtureDir(scriptsRoot), { recursive: true });
  writeFileSync(
    fixtureLockfilePath(scriptsRoot),
    `${JSON.stringify(withoutLocalArchiveIntegrity(lock), null, 2)}\n`,
  );
  assertFixtureLockfilePresent(scriptsRoot);
  console.log(`wrote ${fixtureLockfilePath(scriptsRoot)}`);
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
