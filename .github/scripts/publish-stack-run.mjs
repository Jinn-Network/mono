import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { DEPENDENCY_SECTIONS } from './stack-package-graph.mjs';
import { applyPublishManifest } from './stack-publish-manifest.mjs';

const LOCAL_SPECIFIER = /^(portal|link|file|workspace):/u;

// Belt-and-suspenders check on the acceptance criterion's headline claim: no
// portal:/link:/file:/workspace: specifier survives into a packed manifest.
// transformManifestForPublish only rewrites in-set dependency specifiers and
// strips portal: resolutions; an out-of-set devDependency carrying one of these
// specifiers today would pack, publish, and 404 every consumer's install on a
// path that does not exist on their disk, with CI green throughout. This runs
// inside the mutation window that already exists between applyPublishManifest
// and restore().
function assertNoLocalSpecifiers(manifest, directory) {
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [dependency, spec] of Object.entries(manifest[section] ?? {})) {
      if (typeof spec === 'string' && LOCAL_SPECIFIER.test(spec)) {
        throw new Error(`${directory}: packed manifest ${section}.${dependency} still carries local specifier ${spec}`);
      }
    }
  }
}

function defaultExec(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: packEnv() });
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function packEnv() {
  const env = { ...process.env };
  delete env.NODE_AUTH_TOKEN;
  return env;
}

function requireSuccess(result, directory, label) {
  if (result.status !== 0) {
    throw new Error(`${directory}: ${label} failed: ${(result.stderr || result.stdout || `status ${result.status}`).trim()}`);
  }
  return result;
}

export async function packWave(wave, options) {
  const { repoRoot, version, gitHead, inSetNames, tarballsDir, exec = defaultExec } = options;
  const artifacts = [];
  for (const entry of wave) {
    const packageRoot = resolve(repoRoot, entry.directory);
    requireSuccess(exec('yarn', ['install', '--immutable'], packageRoot), entry.directory, 'yarn install --immutable');
    requireSuccess(exec('yarn', ['build'], packageRoot), entry.directory, 'yarn build');
    const { restore } = applyPublishManifest(entry.manifestPath, { version, gitHead, inSetNames });
    let packed;
    try {
      assertNoLocalSpecifiers(JSON.parse(readFileSync(entry.manifestPath, 'utf8')), entry.directory);
      const result = requireSuccess(
        exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballsDir], packageRoot),
        entry.directory,
        'npm pack',
      );
      const entries = JSON.parse(result.stdout);
      if (!Array.isArray(entries) || entries.length !== 1) {
        throw new Error(`${entry.directory}: npm pack returned ${Array.isArray(entries) ? entries.length : 'non-array'} entries`);
      }
      [packed] = entries;
    } finally {
      restore();
    }
    if (packed?.name !== entry.name || packed.version !== version || typeof packed.filename !== 'string') {
      throw new Error(
        `npm pack produced ${packed?.name ?? '<missing>'}@${packed?.version ?? '<missing>'}, expected ${entry.name}@${version}`,
      );
    }
    const tarball = join(tarballsDir, basename(packed.filename));
    const bytes = readFileSync(tarball);
    artifacts.push({
      name: entry.name,
      spec: `${entry.name}@${version}`,
      directory: entry.directory,
      tarball,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    });
  }
  return artifacts;
}
