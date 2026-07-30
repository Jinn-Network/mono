import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { applyPublishManifest } from './stack-publish-manifest.mjs';

export function defaultExec(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: publishEnv() });
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

export function publishEnv() {
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

export async function runPublish(plan, args) {
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-stack-publish-'));
  try {
    for (const [index, wave] of plan.waves.entries()) {
      const artifacts = await packWave(wave, {
        repoRoot: args.repoRoot,
        version: plan.version,
        gitHead: args.sha ?? plan.version,
        inSetNames: plan.inSetNames,
        tarballsDir,
      });
      console.log(`wave ${index}: packed ${artifacts.length} packages`);
    }
  } finally {
    rmSync(tarballsDir, { recursive: true, force: true });
  }
}
