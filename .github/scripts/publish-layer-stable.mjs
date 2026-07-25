#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const packageSet = [
  { directory: 'packages/plugin', name: '@jinn-network/plugin' },
  { directory: 'packages/core', name: '@jinn-network/core' },
  { directory: 'packages/layer', name: '@jinn-network/jinn-layer' },
];
const stableSemver = /^\d+\.\d+\.\d+$/u;

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const root = resolve(args.get('--root') ?? process.cwd());
const version = args.get('--version');
const npmCommand = args.get('--npm') ?? 'npm';
const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-layer-stable-'));
const npmEnv = { ...process.env };
delete npmEnv.NODE_AUTH_TOKEN;
const retryAttempts = Number.parseInt(process.env.JINN_NPM_REGISTRY_RETRY_ATTEMPTS ?? '12', 10);
const retryDelayMs = Number.parseInt(process.env.JINN_NPM_REGISTRY_RETRY_DELAY_MS ?? '5000', 10);

function fail(message) {
  throw new Error(`layer stable publish failed: ${message}`);
}

function runNpm(npmArgs, cwd, { allowNotFound = false } = {}) {
  const result = spawnSync(npmCommand, npmArgs, {
    cwd,
    encoding: 'utf8',
    env: npmEnv,
  });
  if (!result.error && result.status === 0) return result;

  const output = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join('\n');
  if (allowNotFound && /\bE404\b/u.test(output)) return null;
  fail(`npm ${npmArgs.join(' ')} failed: ${output || `status ${result.status}`}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${error?.message ?? String(error)}`);
  }
}

function packPackage(pkg) {
  const packageRoot = resolve(root, pkg.directory);
  const manifest = readJson(resolve(packageRoot, 'package.json'));
  if (manifest?.name !== pkg.name || manifest.version !== version) {
    fail(
      `${pkg.directory}/package.json must be ${pkg.name}@${version}, got `
      + `${manifest?.name ?? '<missing>'}@${manifest?.version ?? '<missing>'}`,
    );
  }

  const result = runNpm(
    ['pack', '--json', '--pack-destination', tarballsDir],
    packageRoot,
  );
  let packed;
  try {
    const entries = JSON.parse(result.stdout);
    if (!Array.isArray(entries) || entries.length !== 1) {
      fail(`npm pack returned ${Array.isArray(entries) ? entries.length : 'non-array'} entries for ${pkg.name}`);
    }
    [packed] = entries;
  } catch (error) {
    if (error?.message?.startsWith('layer stable publish failed:')) throw error;
    fail(`npm pack returned invalid JSON for ${pkg.name}: ${error?.message ?? String(error)}`);
  }
  if (
    packed?.name !== pkg.name
    || packed.version !== version
    || typeof packed.filename !== 'string'
  ) {
    fail(`npm pack returned unexpected identity for ${pkg.name}@${version}`);
  }

  const tarball = resolve(tarballsDir, basename(packed.filename));
  let bytes;
  try {
    bytes = readFileSync(tarball);
  } catch (error) {
    fail(`cannot read packed tarball for ${pkg.name}: ${error?.message ?? String(error)}`);
  }
  return {
    ...pkg,
    spec: `${pkg.name}@${version}`,
    tarball,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

function sleepSync(ms) {
  if (ms <= 0) return;
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  spawnSync('sleep', [String(seconds)], { stdio: 'ignore' });
}

function registryIntegrity(spec, { allowRetry = false } = {}) {
  const attempts = allowRetry ? retryAttempts : 1;
  const delayMs = allowRetry ? retryDelayMs : 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = runNpm(
      ['view', spec, 'dist.integrity', '--json'],
      root,
      { allowNotFound: true },
    );
    if (result !== null) {
      try {
        const integrity = JSON.parse(result.stdout);
        if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
          fail(`registry returned invalid dist.integrity for ${spec}`);
        }
        return integrity;
      } catch (error) {
        if (error?.message?.startsWith('layer stable publish failed:')) throw error;
        fail(`registry returned invalid JSON for ${spec}: ${error?.message ?? String(error)}`);
      }
    }
    if (attempt < attempts - 1) sleepSync(delayMs);
  }
  return null;
}

function registryLatest(name, { allowRetry = false } = {}) {
  const attempts = allowRetry ? retryAttempts : 1;
  const delayMs = allowRetry ? retryDelayMs : 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = runNpm(
      ['view', name, 'dist-tags.latest', '--json'],
      root,
      { allowNotFound: true },
    );
    if (result !== null) {
      try {
        const latest = JSON.parse(result.stdout);
        if (typeof latest !== 'string') {
          fail(`registry returned invalid dist-tags.latest for ${name}`);
        }
        return latest;
      } catch (error) {
        if (error?.message?.startsWith('layer stable publish failed:')) throw error;
        fail(`registry returned invalid latest JSON for ${name}: ${error?.message ?? String(error)}`);
      }
    }
    if (attempt < attempts - 1) sleepSync(delayMs);
  }
  return null;
}

function requireMatchingIntegrity(artifact, actual, phase) {
  if (actual !== artifact.integrity) {
    fail(
      `${phase} integrity mismatch for ${artifact.spec}: `
      + `local ${artifact.integrity}, registry ${actual ?? '<missing>'}`,
    );
  }
}

function requireMatchingLatest(artifact, actual, phase) {
  if (actual !== version) {
    fail(
      `${phase} latest tag mismatch for ${artifact.name}: `
      + `expected ${version}, got ${actual ?? '<missing>'}; `
      + 'OIDC cannot repair an immutable version via npm dist-tag, refusing further publication',
    );
  }
}

try {
  if (typeof version !== 'string' || !stableSemver.test(version)) {
    fail(`--version must be a stable semver, got ${version ?? '<missing>'}`);
  }

  // Complete the immutable local package set before consulting or mutating npm.
  const artifacts = packageSet.map(packPackage);
  const missing = [];

  // Preflight the entire set. A mismatch aborts before the first publish.
  for (const artifact of artifacts) {
    const actual = registryIntegrity(artifact.spec);
    if (actual === null) {
      missing.push(artifact);
    } else {
      requireMatchingIntegrity(artifact, actual, 'preflight');
      requireMatchingLatest(
        artifact,
        registryLatest(artifact.name),
        'preflight',
      );
      console.log(`already published with matching integrity: ${artifact.spec}`);
    }
  }

  for (const artifact of missing) {
    runNpm(
      ['publish', artifact.tarball, '--access', 'public', '--tag', 'latest'],
      root,
    );
    requireMatchingIntegrity(
      artifact,
      registryIntegrity(artifact.spec, { allowRetry: true }),
      'post-publish',
    );
    requireMatchingLatest(
      artifact,
      registryLatest(artifact.name, { allowRetry: true }),
      'post-publish',
    );
  }

  // npm trusted publishing authenticates `npm publish`, but not `npm dist-tag`.
  // Cross-package latest promotion therefore cannot be atomic under OIDC. The
  // protected manual environment bounds this transient partial-release window,
  // and exact-integrity retries resume safely without republishing versions.
  for (const artifact of artifacts) {
    requireMatchingIntegrity(
      artifact,
      registryIntegrity(artifact.spec),
      'final',
    );
    requireMatchingLatest(artifact, registryLatest(artifact.name), 'final');
  }

  console.log(`published and verified coherent layer package set ${version} at latest`);
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
} finally {
  rmSync(tarballsDir, { recursive: true, force: true });
}
