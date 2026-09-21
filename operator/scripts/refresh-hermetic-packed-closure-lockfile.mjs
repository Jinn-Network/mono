#!/usr/bin/env node
/**
 * Regenerates the committed packed-closure third-party lockfile.
 * This is the only packed-closure path allowed to consult the npm registry
 * for range resolution (`npm install --package-lock-only`). Smoke uses the
 * result via npm ci and never re-resolves.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFixtureLockfilePresent,
  buildConsumerThirdPartyDependencies,
  discoverPackageRoots,
  fixtureDir,
  fixtureLockfilePath,
  packedClosurePackageNames,
  readPackageJson,
  refreshLockfileArgs,
  requirePackageRoot,
  writeConsumerPackageJson,
} from './lib/hermetic-packed-closure.mjs';

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(scriptsRoot, '..');
const repoRoot = resolve(clientRoot, '..');
const packagesRoot = join(repoRoot, 'packages');
const workRoot = mkdtempSync(join(tmpdir(), 'jinn-hermetic-packed-closure-refresh-'));

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

try {
  const packageRoots = discoverPackageRoots(packagesRoot);
  const clientManifest = readPackageJson(clientRoot);
  const names = packedClosurePackageNames(clientManifest, packageRoots);
  const thirdParty = buildConsumerThirdPartyDependencies({
    operatorManifest: clientManifest,
    closureManifests: names.map((name) => readPackageJson(requirePackageRoot(packageRoots, name))),
  });
  writeConsumerPackageJson(workRoot, thirdParty);
  run('npm', refreshLockfileArgs(), 'refresh packed-closure third-party lockfile', {
    cwd: workRoot,
  });
  mkdirSync(fixtureDir(scriptsRoot), { recursive: true });
  cpSync(join(workRoot, 'package-lock.json'), fixtureLockfilePath(scriptsRoot));
  assertFixtureLockfilePresent(scriptsRoot);
  console.log(`wrote ${fixtureLockfilePath(scriptsRoot)}`);
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
